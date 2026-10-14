'use strict';
/**
 * Автоматическая вычистка «неразрешаемых» ghost-записей bundle в профиле.
 *
 * Предыстория: официальный DSH активно развивается и объединяет/снимает bundle-пакеты.
 * Например, с 0.1.7 `@deepseek-ai/dsh-experimental-agent-team-web-profile` влит в
 * `@deepseek-ai/dsh-experimental-agent-team-profile`, а `@deepseek-ai/dsh-settings-file`
 * удалён. После обновления образа в `dsh.profile.bundles` профиля остаются имена пакетов,
 * которых больше нет, и DSH при каждой загрузке печатает в stderr
 * `skipping profile bundle "..." : cannot resolve ...` и показывает подсказку в интерфейсе.
 *
 * Критерий разрешимости **полностью совпадает с `resolveBundleDir` официального
 * `dsh-app-boot`**: сначала по якорю установки DSH, затем по якорю каталога профиля,
 * через `require.resolve.paths()` Node проверяется существование
 * `<searchPath>/<name>/package.json` в каждом пути поиска (предпочтение якорю установки —
 * чтобы `@deepseek-ai/*` всегда брался из одной и той же установки).
 *
 * Требования безопасности (по умолчанию «консервативный режим», никогда не трогаем
 * конкурентных писателей и намерения пользователя):
 *   - по умолчанию чистим только **известно снятые/переименованные апстримом** bundle
 *     ({@link KNOWN_REMOVED_BUNDLES}, можно расширить через `DSH_PRUNE_BUNDLES_EXTRA`).
 *     Это решает предупреждения после обновления и при этом не касается записей, которые
 *     только что написал нативный менеджер плагинов DSH (гарантия P6 «не терять обновления»).
 *   - чистим только **действительно неразрешаемые** записи: если пакет снова разрешим
 *     (пользователь переустановил) — всегда оставляем.
 *   - записи, объявленные в полях зависимостей (dependencies / devDependencies /
 *     optionalDependencies / peerDependencies), сохраняются — чтобы не удалить
 *     «объявленное ожидание установки».
 *   - защищённые core-bundle (`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`) никогда не вычищаются.
 *   - `DSH_PRUNE_STALE_BUNDLES=all` переключает «агрессивный режим»: вычищаются любые
 *     «неразрешаемые и необъявленные» записи; `=0/false/off/no` полностью отключает.
 * Функция — чистое преобразование в памяти (на диск не пишет); вызывающая сторона сохраняет
 * результат внутри write-lock профиля, что гарантирует идемпотентность и сохранность прочих записей.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/** Core-bundle, который никогда не вычищается (даже при ошибке разрешения его сохраняют
 * и передают в предупреждение вышестоящему коду, а не молча снимают из основания). */
const DEFAULT_PROTECTED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
]);

/**
 * Packеты bundle, известные как снятые/переименованные апстримом (список очистки консервативного режима).
 * Основание: официальные Release-заметки разных версий и фактическая установочная структура.
 *   - `@deepseek-ai/dsh-experimental-agent-team-web-profile`: с 0.1.7 влит в
 *     `@deepseek-ai/dsh-experimental-agent-team-profile` (его README явно требует
 *     удалить отдельную запись из `dsh.profile.bundles`).
 *   - `@deepseek-ai/dsh-settings-file`: удалён с 0.1.7.
 *   - `@deepseek-ai/dsh-experimental-schedule-bundle`: снят с 0.2.1-alpha.1, автоматизация
 *     встроена в `dsh-web-app` (апстримный `dsh-app-boot` тоже удаляет его через `RETIRED_BUNDLES`;
 *     здесь выровнено, чтобы профили старых томов данных чистились одинаково).
 */
const KNOWN_REMOVED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-experimental-agent-team-web-profile',
  '@deepseek-ai/dsh-settings-file',
  '@deepseek-ai/dsh-experimental-schedule-bundle'
]);

/** Кандидаты-якоря установки DSH (в контейнере фактически `/usr/local/lib/node_modules/@deepseek-ai/dsh`). */
function defaultInstallAnchors(env = process.env) {
  const candidates = [
    env.DSH_INSTALL_ANCHOR,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
  ];
  const anchors = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) anchors.push(candidate);
    } catch {}
  }
  return anchors;
}

/**
 * Разрешает каталог пакета от заданного якоря, семантика совпадает с официальным `packageDirFromAnchor`.
 * @param {string} anchor файл-якорь (производит поиск node_modules вверх от своего каталога)
 * @param {string} name имя пакета
 * @returns {string|undefined} абсолютный путь каталога пакета; undefined, если не найден
 */
function packageDirFromAnchor(anchor, name) {
  let searchPaths = null;
  try {
    searchPaths = createRequire(anchor).resolve.paths(name);
  } catch {
    searchPaths = null;
  }
  if (!searchPaths) return undefined;
  for (const searchPath of searchPaths) {
    const candidate = path.join(searchPath, name);
    try {
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * Определяет, разрешим ли bundle: сначала якорь установки, затем якорь каталога профиля.
 * @param {string} name имя пакета
 * @param {string} profileDir каталог профиля
 * @param {string[]} [installAnchors] якоря установки DSH
 * @returns {boolean}
 */
function isBundleResolvable(name, profileDir, installAnchors) {
  const anchors = [...(installAnchors || defaultInstallAnchors()), path.join(profileDir, 'package.json')];
  for (const anchor of anchors) {
    if (packageDirFromAnchor(anchor, name)) return true;
  }
  return false;
}

/** Собирает имена пакетов, объявленных зависимостями в manifest (в любом поле зависимостей). */
function declaredNames(pkg) {
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const obj = pkg && pkg[field];
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj)) names.add(key);
    }
  }
  return names;
}

/**
 * Определяет режим очистки.
 * @param {Record<string,string|undefined>} [env]
 * @returns {'off'|'known'|'all'} по умолчанию 'known' (консервативно: только известный список снятых)
 */
function pruneMode(env = process.env) {
  const value = String(env.DSH_PRUNE_STALE_BUNDLES ?? 'known').trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return 'off';
  if (value === 'all') return 'all';
  return 'known';
}

/** Имена пакетов, добавляемых к известному списку снятых (`DSH_PRUNE_BUNDLES_EXTRA`, через запятую). */
function extraRemovedNames(env = process.env) {
  return parseExtraList(env.DSH_PRUNE_BUNDLES_EXTRA);
}

/** Разбирает «дополнительный список очистки»: принимает массив или строку через запятую. */
function parseExtraList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Определяет стратегию очистки, объединяя переменные окружения и сохранённую конфигурацию
 * (`gateway.config.json`).
 * Приоритет: переменная окружения `DSH_PRUNE_STALE_BUNDLES` > сохранённый `pruneStaleBundles` > по умолчанию `known`;
 * дополнительный список берётся как объединение обоих (переменная окружения `DSH_PRUNE_BUNDLES_EXTRA`
 * + сохранённый `pruneBundlesExtra`).
 * @param {Record<string,string|undefined>} [env]
 * @param {{ pruneStaleBundles?: string, pruneBundlesExtra?: string|string[] }} [persisted]
 * @returns {{ mode: 'off'|'known'|'all', extraNames: string[] }}
 */
function resolvePruneConfig(env = process.env, persisted = {}) {
  const envRaw = env.DSH_PRUNE_STALE_BUNDLES;
  const persistedRaw = persisted && persisted.pruneStaleBundles;
  let mode;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    mode = pruneMode({ DSH_PRUNE_STALE_BUNDLES: envRaw });
  } else if (persistedRaw !== undefined && String(persistedRaw).trim() !== '') {
    mode = pruneMode({ DSH_PRUNE_STALE_BUNDLES: persistedRaw });
  } else {
    mode = 'known';
  }
  const extraNames = [...new Set([
    ...parseExtraList(env.DSH_PRUNE_BUNDLES_EXTRA),
    ...parseExtraList(persisted && persisted.pruneBundlesExtra)
  ])];
  return { mode, extraNames };
}

/**
 * Убирает из manifest профиля неразрешимые ghost-записи bundle (изменяет `pkg` на месте).
 * @param {any} pkg объект package.json профиля
 * @param {{ profileDir: string, mode?: 'off'|'known'|'all', installAnchors?: string[], protectedNames?: string[], knownRemoved?: string[], extraNames?: string[] }} opts
 * @returns {{ pruned: string[], declared: string[], mode: string }}
 *          pruned=удалённые ghost-записи; declared=подпадавшие под кандидатов, но объявленные
 *          зависимостями и потому сохранённые записи
 */
function pruneStaleBundles(pkg, opts = {}) {
  const profileDir = opts.profileDir;
  if (!profileDir) throw new Error('pruneStaleBundles: profileDir is required');
  const mode = opts.mode || 'known';
  if (mode === 'off') return { pruned: [], declared: [], mode };

  const protectedNames = new Set(opts.protectedNames || DEFAULT_PROTECTED_BUNDLES);
  const installAnchors = opts.installAnchors || defaultInstallAnchors();
  const knownRemoved = new Set([...(opts.knownRemoved || KNOWN_REMOVED_BUNDLES), ...(opts.extraNames || [])]);

  const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
  if (!Array.isArray(bundles) || bundles.length === 0) return { pruned: [], declared: [], mode };

  const declared = declaredNames(pkg);
  const pruned = [];
  const keptDeclared = [];
  const next = [];

  for (const name of bundles) {
    if (typeof name !== 'string' || name === '') { next.push(name); continue; }
    if (protectedNames.has(name)) { next.push(name); continue; }
    // Консервативный режим обрабатывает только известный список снятых; агрессивный — любые записи.
    if (mode !== 'all' && !knownRemoved.has(name)) { next.push(name); continue; }
    if (isBundleResolvable(name, profileDir, installAnchors)) { next.push(name); continue; }
    if (declared.has(name)) { keptDeclared.push(name); next.push(name); continue; }
    pruned.push(name);
  }

  if (pruned.length > 0) pkg.dsh.profile.bundles = next;
  return { pruned, declared: keptDeclared, mode };
}

module.exports = {
  pruneStaleBundles,
  isBundleResolvable,
  packageDirFromAnchor,
  defaultInstallAnchors,
  pruneMode,
  extraRemovedNames,
  parseExtraList,
  resolvePruneConfig,
  declaredNames,
  DEFAULT_PROTECTED_BUNDLES,
  KNOWN_REMOVED_BUNDLES
};
