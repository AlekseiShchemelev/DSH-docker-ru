#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const profileDir = process.env.DSH_PROFILE_DIR || `${process.env.DSH_HOME || '/root'}/.dsh/profiles/web`;
const pkgPath = path.join(profileDir, 'package.json');
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const linkDir = path.join(profileDir, 'node_modules/@dsh-custom');
const targetLink = path.join(linkDir, 'dsh-browser-desktop');
const pluginSource = '/app/plugins/dsh-browser-desktop';
const stateFile = `${process.env.DSH_HOME || '/root'}/.dsh/plugins-state.json`;

// ── P6: разделяем с DSH write-lock профиля ─────────────────────────────────────────
// Официальный нативный менеджер плагинов/редактор настроек 0.1.7 перед изменением
// `profiles/web/package.json` берёт `package.json.lock` (wx — эксклюзивно). При старте
// контейнера/смене версии этот скрипт тоже правит тот же package.json; без lock
// будет взаимная перезапись с конкурентной записью DSH (потеря обновлений).
// Здесь каждое «читать package.json → изменить → записать» выполняется в одном lock.
const require = createRequire(import.meta.url);
const { withProfileLock, assertProfileLockHeld } = require('./profile-lock.cjs');
const { removePatchEntries, assertPatchSafe } = require('./patch-yaml.cjs');
const { pruneStaleBundles, resolvePruneConfig } = require('./stale-bundles.cjs');

/**
 * Выполняет один цикл «читать package.json → mutate → записать при необходимости» внутри
 * write-lock профиля.
 * @param {(pkg: any) => boolean} mutate возвращает true, если нужна запись
 * @returns {Promise<boolean>}
 */
async function writeProfile(mutate) {
  return withProfileLock(profileDir, async () => {
    assertProfileLockHeld(profileDir);
    // Прежняя семантика сохраняется: если файла profile нет — с нуля не создаём
    // (инициализацией занимается ensureProfilePackage)
    if (!fs.existsSync(pkgPath)) return false;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      console.warn('[install-plugin] Ошибка чтения package.json, пропускаем эту запись:', e.message);
      return false;
    }
    const changed = mutate(pkg);
    if (changed) atomicWrite(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    return changed;
  }, { label: 'install-plugin' });
}

/**
 * Атомарная запись файла (незначительное): сначала во временный файл, затем rename —
 * чтобы обрыв записи не оставил обрезанный JSON/YAML, из-за которого DSH не разберёт
 * файл при следующем старте. rename в той же директории атомарен.
 */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

fs.mkdirSync(linkDir, { recursive: true });

/**
 * Безопасно определяет, существует ли путь (включая «висячие» symlink).
 * Внимание: нельзя использовать `fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()` —
 * при полностью отсутствующем p lstatSync бросает ENOENT и прерывает регистрацию плагина.
 */
function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Удаляет существующий файл/симлинк (включая «висячий»); если нет — молча пропускает */
function removeIfExists(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

/**
 * Гарантирует наличие package.json профиля.
 * При первом старте свежего контейнера DSH ещё не создал файл; если здесь не проинициализировать,
 * блоки регистрации зависимостей/bundles ниже (`if (fs.existsSync(pkgPath))`) будут пропущены целиком,
 * и dsh-browser-desktop так и не зарегистрируется в профиле (инструменты ИИ и промпт полностью пропадут).
 */
async function ensureProfilePackage() {
  try {
    await withProfileLock(profileDir, async () => {
      assertProfileLockHeld(profileDir);
      // Проверяем ещё раз уже внутри lock: не вступить в гонку инициализации с другим писателем
      if (fs.existsSync(pkgPath)) return;
      fs.mkdirSync(profileDir, { recursive: true });
      const initial = {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
      };
      atomicWrite(pkgPath, JSON.stringify(initial, null, 2) + '\n');
      console.log('[install-plugin] Инициализирован package.json Web Profile (первый старт свежего контейнера)');
    }, { label: 'install-plugin:init' });
  } catch (e) {
    console.warn('[install-plugin] Ошибка инициализации package.json профиля:', e.message);
  }
}

function readPluginState() {
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return {
        disabled: Array.isArray(data.disabled) ? data.disabled : [],
        uninstalled: Array.isArray(data.uninstalled) ? data.uninstalled : [],
        // known: список плагинов, которые мы «видели/собирали». Позволяет отличать
        // «ни разу не собирался» (по умолчанию включён) от «удалён извне» (остаётся
        // удалённым) — см. reconcileManagedState()
        known: Array.isArray(data.known) ? data.known : []
      };
    }
  } catch (e) {
    console.warn('[install-plugin] Предупреждение при чтении plugins-state.json:', e.message);
  }
  return { disabled: [], uninstalled: [], known: [] };
}

function writePluginState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    atomicWrite(stateFile, JSON.stringify({
      disabled: Array.from(new Set(state.disabled || [])),
      uninstalled: Array.from(new Set(state.uninstalled || [])),
      known: Array.from(new Set(state.known || [])),
      updatedAt: new Date().toISOString()
    }, null, 2) + '\n');
  } catch (e) {
    console.warn('[install-plugin] Предупреждение при записи plugins-state.json:', e.message);
  }
}

/**
 * Выравнивает состояние плагинов с «внешними писателями» (нативный менеджер плагинов
 * DSH / страница настроек) по manifest профиля.
 *
 * Зачем это нужно (смысловая сторона P6): нативный менеджер, включая/отключая плагин,
 * **меняет только bundles** и не пишет наш plugins-state.json. Не распознай мы это —
 * при перезапуске контейнера скрипт посчитает плагин с «зависимостью на месте, но вынутой
 * из bundles» «ни разу не собранным» и автоматически вернёт его, молча откатив решение
 * пользователя об отключении.
 *
 * Правила (manifest — единственный источник истины):
 *   dependencies есть + bundles есть      → включён: снимаем наши disabled / uninstalled
 *   dependencies есть + bundles нет       → отключён: ставим disabled (больше не собираем)
 *   dependencies нет + bundles нет + в known → удалён: ставим uninstalled
 *   dependencies нет + bundles нет + нет в known → никогда не собирался: оставляем по умолчанию
 *     (штатная автоматическая сборка)
 *
 * @param {string[]} names имена плагинов, которыми управляет этот скрипт
 */
function reconcileManagedState(names) {
  try {
    if (!fs.existsSync(pkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    const bundles = (pkg.dsh?.profile?.bundles) || [];
    const state = readPluginState();
    const known = new Set(state.known);
    const disabled = new Set(state.disabled);
    const uninstalled = new Set(state.uninstalled);
    let changed = false;

    // 1) Запоминаем «виденные/собранные» плагины (первый запуск сеет их из текущего manifest;
    //    для распознавания будущих внешних удалений это должно сохраняться)
    for (const n of [...deps, ...bundles]) {
      if (!known.has(n)) { known.add(n); changed = true; }
    }

    // 2) Выравниваем флаги включения/удаления управляемых плагинов по manifest
    const notes = [];
    for (const n of names) {
      const present = deps.includes(n);
      const bundled = bundles.includes(n);
      if (present && bundled) {
        if (disabled.delete(n)) { changed = true; notes.push(`${n}=включён`); }
        if (uninstalled.delete(n)) { changed = true; notes.push(`${n}=переустановлен`); }
      } else if (present && !bundled) {
        if (!disabled.has(n)) { disabled.add(n); changed = true; notes.push(`${n}=отключён (внешне)`); }
        if (uninstalled.delete(n)) changed = true;
      } else if (!present && !bundled && known.has(n)) {
        if (!uninstalled.has(n)) { uninstalled.add(n); changed = true; notes.push(`${n}=удалён (внешне)`); }
        if (disabled.delete(n)) changed = true;
      }
    }

    if (changed) {
      writePluginState({ disabled: [...disabled], uninstalled: [...uninstalled], known: [...known] });
      pluginState.disabled = [...disabled];
      pluginState.uninstalled = [...uninstalled];
      pluginState.known = [...known];
      if (notes.length > 0) {
        console.log(`[install-plugin] Состояние плагинов выровнено с внешним (нативный менеджер DSH): ${notes.join(', ')}`);
      }
    }
  } catch (e) {
    console.warn('[install-plugin] Ошибка выравнивания внешнего состояния плагинов:', e.message);
  }
}

await ensureProfilePackage();

const pluginState = readPluginState();

// Если plugins-state.json нет, но package.json уже существует — значит, была история запусков.
// Автоматически выводим уже отключённые плагины, чтобы при апгрейде образа не перекрыть
// существующие предпочтения пользователя по отключению
if (!fs.existsSync(stateFile) && fs.existsSync(pkgPath)) {
  try {
    const existingPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = existingPkg.dependencies || {};
    const bnds = existingPkg.dsh?.profile?.bundles || [];
    let updated = false;
    for (const dep of Object.keys(deps)) {
      if (!bnds.includes(dep) && !pluginState.disabled.includes(dep)) {
        pluginState.disabled.push(dep);
        updated = true;
      }
    }
    if (updated) {
      writePluginState(pluginState);
    }
  } catch {}
}

// 0. Автодополнение глобальных зависимостей: линкуем встроенные братские пакеты DSH
// @deepseek-ai/* к глобальному /usr/local/lib/node_modules/@deepseek-ai
// Полностью решает проблему, при которой сторонние плагины вроде dshmarket не могли найти
// в родительском каталоге библиотеки вида @deepseek-ai/schemastery и падали при старте.
const dshCoreModules = [
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
].find(d => fs.existsSync(d));

const globalScopeDir = [
  '/usr/local/lib/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai'
].find(d => fs.existsSync(d));

if (dshCoreModules && globalScopeDir) {
  try {
    const pkgs = fs.readdirSync(dshCoreModules);
    for (const p of pkgs) {
      if (p === 'dsh') continue;
      const target = path.join(globalScopeDir, p);
      const src = path.join(dshCoreModules, p);
      try {
        if (!pathExists(target)) {
          fs.symlinkSync(src, target);
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[install-plugin] Ошибка дополнения глобальных зависимостей @deepseek-ai:', e.message);
  }
}

// 1. Создаём симлинк файла зависимости плагина (schemastery)
const possibleSchemasterySources = [
  '/usr/local/lib/node_modules/@deepseek-ai/schemastery',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery',
  '/opt/dsh/lib/node_modules/@deepseek-ai/schemastery',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'
];
for (const src of possibleSchemasterySources) {
  if (fs.existsSync(src)) {
    const pluginDepDir = path.join(pluginSource, 'node_modules/@deepseek-ai');
    fs.mkdirSync(pluginDepDir, { recursive: true });
    const linkPath = path.join(pluginDepDir, 'schemastery');
    try {
      if (pathExists(linkPath)) fs.unlinkSync(linkPath);
      fs.symlinkSync(src, linkPath);
      console.log('[install-plugin] Симлинк зависимости schemastery создан');
    } catch {}
    break;
  }
}

// 2. Автоматически регистрируем и настраиваем @dsh-custom/dsh-browser-desktop
//    (уважая сохранённые предпочтения пользователя)
const browserDesktopName = '@dsh-custom/dsh-browser-desktop';
// P6: сначала выравниваемся с manifest (распознаём «отключено нативным менеджером DSH»),
// затем решаем, собирать ли
reconcileManagedState([browserDesktopName]);
const isBrowserDesktopUninstalled = pluginState.uninstalled.includes(browserDesktopName);
const isBrowserDesktopDisabled = pluginState.disabled.includes(browserDesktopName);

if (isBrowserDesktopUninstalled) {
  console.log('[install-plugin] Пользователь явно удалил dsh-browser-desktop, сборку пропускаем');
  try {
    if (pathExists(targetLink)) removeIfExists(targetLink);
  } catch {}
  try {
    await writeProfile((pkg) => {
      let ch = false;
      if (pkg.dependencies && pkg.dependencies[browserDesktopName]) {
        delete pkg.dependencies[browserDesktopName];
        ch = true;
      }
      if (pkg.dsh?.profile?.bundles?.includes(browserDesktopName)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== browserDesktopName);
        ch = true;
      }
      return ch;
    });
  } catch {}
} else {
  try {
    if (pathExists(targetLink)) removeIfExists(targetLink);
    fs.symlinkSync(pluginSource, targetLink);
    console.log('[install-plugin] Симлинк каталога плагина создан:', targetLink);
  } catch (e) {
    console.warn('[install-plugin] Ошибка создания симлинка:', e.message);
  }

  try {
    await writeProfile((pkg) => {
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies[browserDesktopName] = 'link:' + pluginSource;
      pkg.dsh = pkg.dsh || { profile: {} };
      pkg.dsh.profile = pkg.dsh.profile || {};
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

      if (isBrowserDesktopDisabled) {
        if (pkg.dsh.profile.bundles.includes(browserDesktopName)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== browserDesktopName);
        }
        console.log('[install-plugin] Пользователь явно отключил dsh-browser-desktop, остаёмся отключёнными (в bundles не добавляем)');
      } else {
        if (!pkg.dsh.profile.bundles.includes(browserDesktopName)) {
          pkg.dsh.profile.bundles.push(browserDesktopName);
        }
        console.log('[install-plugin] Регистрация bundle-зависимости в package.json успешна');
      }
      return true;
    });
  } catch (e) {
    console.warn('[install-plugin] Ошибка обновления package.json:', e.message);
  }
}

// 3. Убираем дублирующие insert-записи в cordis.patch.yml (хирургическое удаление + предохранитель,
//    никогда не задеваются соседние плагины/записи настроек)
if (fs.existsSync(patchPath)) {
  try {
    await withProfileLock(profileDir, async () => {
      assertProfileLockHeld(profileDir);
      const before = fs.readFileSync(patchPath, 'utf8');
      // Наш плагин загружается всегда через bundles; любая запись о нём в patch — исторический
      // остаток (вносил устаревший config)
      if (!before.includes('dsh-browser-desktop')) return;
      const r = removePatchEntries(before, (block) => block.includes('dsh-browser-desktop'));
      if (r.removed === 0) return;
      let res = r.text.trim();
      // Если после фильтрации пусто — обязательно записываем корректную пустую последовательность '[]'.
      // Запись пустого файла (только перевод строки) сломает разбор патча cordis у DSH → при старте
      // DSH выйдет с кодом 1.
      if (!res) res = '[]';
      // Предохранитель: этот файл — авторитет настроек DSH (включая конфиг моделей llm-pi-ai),
      // чужие записи не трогаем никогда
      assertPatchSafe({ before, after: res, removedIds: r.removedIds });
      atomicWrite(patchPath, res + '\n');
      console.log('[install-plugin] Убраны исторические записи этого плагина из cordis.patch.yml (авторитет конфигурации — в Admin)');
    }, { label: 'install-plugin:patch-cleanup' });
  } catch (e) {
    console.warn('[install-plugin] Ошибка обработки cordis.patch.yml (не записано):', e.message);
  }
}

// 4. Автоматически инициализируем рабочую область по умолчанию в хранилище DSH
const wsStoragePath = `${process.env.DSH_HOME || '/root'}/.dsh/storages/workspace.json`;
const defaultWsPath = process.env.DSH_WORKSPACE || '/workspace';
fs.mkdirSync(`${process.env.DSH_HOME || '/root'}/.dsh/storages`, { recursive: true });

try {
  let wsData = null;
  if (fs.existsSync(wsStoragePath)) {
    try { wsData = JSON.parse(fs.readFileSync(wsStoragePath, 'utf8')); } catch {}
  }
  if (!wsData || !wsData.tables || Object.keys(wsData.tables.workspaces || {}).length === 0) {
    const wsId = 'ws-default-workspace';
    const now = new Date().toISOString();
    wsData = {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [wsId],
        archivedSessionIds: []
      },
      tables: {
        workspaces: {
          [wsId]: {
            path: defaultWsPath,
            title: path.basename(defaultWsPath) || 'workspace',
            sessionIds: [],
            createdAt: now,
            updatedAt: now
          }
        }
      }
    };
    atomicWrite(wsStoragePath, JSON.stringify(wsData, null, 2) + '\n');
    console.log('[install-plugin] Для DSH зарегистрирована начальная рабочая область по умолчанию:', defaultWsPath);
  }
} catch (e) {
  console.warn('[install-plugin] Ошибка инициализации рабочей области по умолчанию:', e.message);
}

// 5. Автоочистка снятых исторических встроенных плагинов (например, потерявшего смысл
//    @dsh-custom/dsh-settings-config-path)
try {
  const legacyLink = path.join(linkDir, 'dsh-settings-config-path');
  if (pathExists(legacyLink)) {
    removeIfExists(legacyLink);
    console.log('[install-plugin] Удалён симлинк снятого плагина: dsh-settings-config-path');
  }
} catch {}

try {
  await writeProfile((pkg) => {
    let changed = false;
    const legacyPkgName = '@dsh-custom/dsh-settings-config-path';
    if (pkg.dependencies && pkg.dependencies[legacyPkgName]) {
      delete pkg.dependencies[legacyPkgName];
      changed = true;
    }
    if (pkg.dsh?.profile?.bundles?.includes(legacyPkgName)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== legacyPkgName);
      changed = true;
    }
    if (changed) {
      console.log('[install-plugin] Снятый плагин @dsh-custom/dsh-settings-config-path вычищен из зависимостей и bundles package.json');
    }
    return changed;
  });
} catch {}

// 6. Автообнаружение и сборка предустановленных Market-плагинов (динамическая синхронизация
//    с plugins.market.list, полностью уважаем предпочтения пользователя по отключению/удалению)
// Корневой каталог физической установки плагинов (можно переопределить через
// DSH_MARKET_PLUGIN_ROOT, удобно для тестов и повторной упаковки)
const MARKET_ROOT = process.env.DSH_MARKET_PLUGIN_ROOT || '/usr/local/lib/node_modules';
const marketPlugins = [
  { id: 'dshmarket', name: 'dshmarket', path: path.join(MARKET_ROOT, 'dshmarket') },
  { id: 'dsh-thinking-effort', name: '@hytime/dsh-thinking-effort', path: path.join(MARKET_ROOT, '@hytime/dsh-thinking-effort') }
];

const listFile = '/app/plugins.market.list';
if (fs.existsSync(listFile)) {
  try {
    const listLines = fs.readFileSync(listFile, 'utf8').split('\n');
    for (const line of listLines) {
      const clean = line.replace(/#.*/, '').trim();
      if (clean && !marketPlugins.some(item => item.name === clean)) {
        const shortId = clean.replace(/^@.*\//, '');
        marketPlugins.push({
          id: shortId,
          name: clean,
          path: path.join(MARKET_ROOT, clean)
        });
      }
    }
  } catch {}
}

// P6: выравниваемся с manifest (распознаём внешнее отключение/удаление), затем собираем
reconcileManagedState(marketPlugins.map((p) => p.name));

for (const p of marketPlugins) {
  const isMarketUninstalled = pluginState.uninstalled.includes(p.name);
  const isMarketDisabled = pluginState.disabled.includes(p.name);

  // Если пользователь явно удалил — сохраняем удалённым, вычищаем остаточные симлинки и ссылки,
  // ни в коем случае не собираем заново!
  if (isMarketUninstalled) {
    console.log(`[install-plugin] Пользователь явно удалил ${p.name}, остаёмся удалёнными (сборку пропускаем)`);
    const targetLnk = path.join(profileDir, 'node_modules', p.name);
    try {
      if (pathExists(targetLnk)) removeIfExists(targetLnk);
    } catch {}
    try {
      await writeProfile((pkg) => {
        let ch = false;
        if (pkg.dependencies && pkg.dependencies[p.name]) {
          delete pkg.dependencies[p.name];
          ch = true;
        }
        if (pkg.dsh?.profile?.bundles?.includes(p.name)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== p.name);
          ch = true;
        }
        return ch;
      });
    } catch {}
    continue;
  }

  if (fs.existsSync(p.path)) {
    try {
      const scopeDir = path.dirname(path.join(profileDir, 'node_modules', p.name));
      fs.mkdirSync(scopeDir, { recursive: true });
      const targetLnk = path.join(profileDir, 'node_modules', p.name);
      if (pathExists(targetLnk)) removeIfExists(targetLnk);
      fs.symlinkSync(p.path, targetLnk);

      // Гарантируем, что внутренние node_modules/@deepseek-ai плагина указывают на глобальные
      // зависимости (pathExists безопасно переживает «висячие» симлинки)
      const peerLinkDir = path.join(p.path, 'node_modules/@deepseek-ai');
      try {
        if (pathExists(peerLinkDir)) {
          removeIfExists(peerLinkDir);
        }
        if (dshCoreModules) {
          fs.mkdirSync(path.dirname(peerLinkDir), { recursive: true });
          fs.symlinkSync(dshCoreModules, peerLinkDir);
        }
      } catch (e) {}

      await writeProfile((pkg) => {
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies[p.name] = 'link:' + p.path;
        pkg.dsh = pkg.dsh || { profile: {} };
        pkg.dsh.profile = pkg.dsh.profile || {};
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

        if (isMarketDisabled) {
          if (pkg.dsh.profile.bundles.includes(p.name)) {
            pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== p.name);
          }
          console.log(`[install-plugin] Пользователь явно отключил ${p.name}, остаёмся отключёнными (в bundles не добавляем)`);
        } else {
          if (!pkg.dsh.profile.bundles.includes(p.name)) {
            pkg.dsh.profile.bundles.push(p.name);
          }
          console.log(`[install-plugin] Автосборка предустановленного Market-плагина: ${p.name}`);
        }
        return true;
      });
    } catch (e) {
      console.warn(`[install-plugin] Ошибка автосборки Market-плагина (${p.name}):`, e.message);
    }
  } else {
    // Плагин не установлен (чистый базовый образ) — вычищаем остаточные bundle-ссылки из package.json
    try {
      await writeProfile((pkg) => {
        let changed = false;
        if (pkg.dsh?.profile?.bundles?.includes(p.name)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== p.name);
          changed = true;
        }
        if (pkg.dependencies && pkg.dependencies[p.name]) {
          delete pkg.dependencies[p.name];
          changed = true;
        }
        if (changed) {
          console.log(`[install-plugin] Базовый образ автоматически вычистил ссылки на несобранный плагин: ${p.name}`);
        }
        return changed;
      });
    } catch (e) {}
  }
}

// 6.1 Финальное выравнивание: собранные плагины записываем в known (чтобы в будущем отличать
//     «ни разу не собирался» от «удалён извне»)
reconcileManagedState([...marketPlugins.map((p) => p.name), browserDesktopName]);

// 6.2 Автоочистка неразрешимых ghost-записей bundle в профиле.
//     Предыстория: официально с 0.1.7 было объединено/снято несколько bundle-пакетов (например,
//     `@deepseek-ai/dsh-experimental-agent-team-web-profile` влит в
//     `@deepseek-ai/dsh-experimental-agent-team-profile`). После апгрейда образа в
//     `dsh.profile.bundles` профиля остаются имена несуществующих пакетов, и DSH при каждой
//     загрузке печатает `skipping profile bundle "..." : cannot resolve ...` и показывает
//     подсказку в UI.
//     Источник политики (приоритет): переменная окружения DSH_PRUNE_STALE_BUNDLES >
//     сохранённая конфигурация панели `$DSH_HOME/.dsh/gateway.config.json#pruneStaleBundles` >
//     по умолчанию known (консервативно).
//     «Консервативный режим» по умолчанию чистит только известные снятые апстримом bundle
//     (список из stale-bundles.cjs + доп. список), причём только «точно неразрешимые и не
//     объявленные в полях зависимостей» — никогда не трогая конкурентных писателей и замыслы
//     пользователя.
//     Внимание: этот скрипт выполняется один раз на этапе старта контейнера; изменение в панели
//     управления вступает в силу после перезапуска контейнера.
function readGatewayConfig() {
  const file = process.env.GATEWAY_CONFIG_FILE || path.join(process.env.DSH_HOME || '/root', '.dsh', 'gateway.config.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[install-plugin] Ошибка чтения конфигурации шлюза (игнорируется, откат к политике по умолчанию):', e.message);
  }
  return {};
}
const pruneCfg = resolvePruneConfig(process.env, readGatewayConfig());
if (pruneCfg.mode !== 'off') {
  try {
    await writeProfile((pkg) => {
      const { pruned, declared } = pruneStaleBundles(pkg, {
        profileDir,
        mode: pruneCfg.mode,
        extraNames: pruneCfg.extraNames
      });
      if (pruned.length > 0) {
        console.log(`[install-plugin] Вычищены неразрешимые ghost-записи bundle профиля (режим: ${pruneCfg.mode}): ${pruned.join(', ')}`);
      }
      if (declared.length > 0) {
        console.log(`[install-plugin] Следующие bundle объявлены в dependencies, но пока не установлены — оставлены без очистки: ${declared.join(', ')} (можно установить командой dsh plugin --profile web install)`);
      }
      return pruned.length > 0;
    });
  } catch (e) {
    console.warn('[install-plugin] Ошибка автоочистки ghost-bundle:', e.message);
  }
}

// 7. Контейнерные пресеты конфигурации пишутся в патч-слой уровня Home (официально с 0.1.7
//    авторитет настроек — в патче, старый settings.yaml импортируется только один раз).
//    - dsh-market.allowRestart:false —— контейнерный dsh-manager единый страж, запрещает
//      «перезапуск в один клик» маркетплейса во избежание конфликта двух перезапусков по порту.
//      Внимание: это поле — config записи (dshmarket не экспортирует настраиваемую Schema,
//      через settings.yaml его не импортировать).
//    - ui-sidebar-browser disabled:false —— со встроенной версии 0.1.7 браузер боковой панели
//      в Web по умолчанию выключен, здесь включаем обратно, сохраняя функциональную поверхность 0.1.6.
//    Патч уровня Home $DSH_HOME/cordis.patch.yml имеет наивысший приоритет и не перезаписывается
//    ни страницей настроек DSH, ни нашей очисткой profile-патча.
const homePatchPath = path.join(process.env.DSH_HOME || '/root', '.dsh', 'cordis.patch.yml');

function ensureHomePatchEntries(entries) {
  try {
    fs.mkdirSync(path.dirname(homePatchPath), { recursive: true });
    let raw = '';
    try { raw = fs.readFileSync(homePatchPath, 'utf8'); } catch {}
    const trimmed = raw.trim();
    const isFlowEmpty = trimmed === '' || trimmed === '[]';
    let text = isFlowEmpty ? '' : raw.replace(/\s*$/, '\n');
    const added = [];
    for (const { key, block } of entries) {
      if (text.includes(key)) continue;
      text += block.replace(/\s*$/, '') + '\n';
      added.push(key);
    }
    if (added.length > 0) {
      atomicWrite(homePatchPath, text);
      console.log(`[install-plugin] Home-патч обновлён (${added.join(', ')}): ${homePatchPath}`);
    }
  } catch (e) {
    console.warn('[install-plugin] Ошибка записи Home-патча:', e.message);
  }
}

ensureHomePatchEntries([
  { key: 'ui-sidebar-browser', block: '- id: ui-sidebar-browser\n  disabled: false' },
  { key: 'dsh-market', block: '- id: dsh-market\n  config:\n    allowRestart: false' }
]);
