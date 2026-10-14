'use strict';
/**
 * snapshot-manifest.js — эталонная реализация манифеста версии снимка (Snapshot Manifest)
 * ---------------------------------------------------------------------------
 * Цель: чтобы каждый снимок конфигурации сам нес в себе факт «под какой версией DSH-движка /
 * в каком поколении модели конфигурации он был создан», что позволяет определить совместимость
 * версий до восстановления, не распаковывая предварительно архив в несколько сотен МБ.
 *
 * Ключевые проектные решения (подробнее — в doc/design/snapshot-version-manifest.md):
 *  1. Метаданные упаковываются в архив как обычный файл-участник `.dsh/.dsh-meta/snapshot.json`
 *     под каталогом `.dsh/`, поэтому существующий белый список validateArchiveMembers()
 *     не приходится расширять (принцип fail-closed сохраняется).
 *  2. Этот участник помещается в архив **первым**, что позволяет читать его почти за O(1)
 *     через `tar -xzOf --occurrence=1`.
 *  3. Дописывается также скрытый sidecar `.<filename>.meta.json`, который listBackups()
 *     может перечислять без распаковки архива.
 *  4. Для старых снимков без метаданных поколение умно выводится по структуре
 *     (settings.yaml против cordis.patch.yml).
 *
 * Модуль содержит чистую логику и минимальную зависимость от tar; удобен для юнит-тестов;
 * не требует backup-service, чтобы избежать циклической зависимости.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ── Константы ─────────────────────────────────────────────────────────────
/** Версия формата самого JSON-манифеста (+1 при добавлении/удалении полей; не связана с версией DSH) */
const MANIFEST_SCHEMA_VERSION = 1;
/** Путь участника внутри архива (под .dsh/ — белый список пропускает естественно) */
const MANIFEST_MEMBER = '.dsh/.dsh-meta/snapshot.json';
/** Служебный каталог внутри архива (принадлежит архиву; не должен долго храниться в живом дереве) */
const MANIFEST_DIR_IN_DSH = '.dsh-meta';
/** Именование sidecar: скрытый файл, естественно отфильтровывается listBackups через `!f.startsWith('.')` */
const SIDECAR_SUFFIX = '.meta.json';
const SIDECAR_PREFIX = '.';

/** «Поколение» модели конфигурации — основная ось оценки совместимости версий */
const CONFIG_SCHEMA = Object.freeze({
  SETTINGS_FILE: 1, // <= 0.1.6.x: $DSH_HOME/.dsh/settings.yaml (бэкенд dsh-settings-file)
  PATCH_LAYER: 2    // >= 0.1.7.x: profile cordis.patch.yml + cordis.patch.yml уровня Home
});
const CONFIG_MODEL_LABEL = Object.freeze({
  1: 'settings-file',
  2: 'patch-layer'
});
/** Версия-водораздел смены поколений (в официальном 0.1.7-alpha.1 введена подсистема Settings / слой Home patch) */
const PATCH_LAYER_EPOCH = '0.1.7-alpha.1';

// ── SemVer (самодостаточная реализация, семантика совпадает с version-service.js) ─────────
function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
}
function isValidSemver(v) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(v ?? '').trim());
}
function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  if (p1.patch !== p2.patch) return p1.patch - p2.patch;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;
  return p1.pre.localeCompare(p2.pre);
}
function sameMajorMinor(a, b) {
  const p1 = parseSemver(a);
  const p2 = parseSemver(b);
  return p1.major === p2.major && p1.minor === p2.minor;
}
/** Вывод поколения модели конфигурации по версии движка */
function configSchemaForDshVersion(dshVersion) {
  if (!isValidSemver(dshVersion)) return null;
  return compareSemver(dshVersion, PATCH_LAYER_EPOCH) >= 0
    ? CONFIG_SCHEMA.PATCH_LAYER
    : CONFIG_SCHEMA.SETTINGS_FILE;
}

// ── Минимальная обёртка над tar (асинхронная, с таймаутом и ограничением вывода, чтобы не блокировать цикл событий / не забивать память) ──────
function runTarAsync(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60 * 1000;
  const maxOutputBytes = Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Превышен таймаут tar (${Math.round(timeoutMs / 1000)} с): tar ${args.join(' ')}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onData = (chunk, isErr) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('Превышен лимит вывода tar (возможно, повреждённый или аномальный архив)'));
        return;
      }
      if (isErr) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', d => onData(d, false));
    child.stderr.on('data', d => onData(d, true));
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    child.on('close', code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } });
  });
}

/** Чтение участника-манифеста из архива (почти за O(1), если манифест расположен первым) */
async function readManifestFromArchive(archivePath) {
  const res = await runTarAsync(
    ['-xzOf', archivePath, '--occurrence=1', MANIFEST_MEMBER],
    { timeoutMs: 120 * 1000, maxOutputBytes: 4 * 1024 * 1024 }
  );
  if (res.code !== 0 || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/** Перечисление участников архива (только для вывода о старых снимках / диагностики; дорого — обязательно использовать кэш sidecar) */
async function listMembers(archivePath) {
  const res = await runTarAsync(['-tzf', archivePath], { timeoutMs: 300 * 1000, maxOutputBytes: 64 * 1024 * 1024 });
  if (res.code !== 0) throw new Error('Не удалось перечислить участники архива: ' + (res.stderr || 'неизвестная ошибка'));
  return res.stdout.split('\n').map(s => s.replace(/\s+$/, '')).filter(Boolean);
}

/** Извлечение одного участника архива в память (для чтения небольших файлов вроде profiles/web/package.json) */
async function readMemberFromArchive(archivePath, member) {
  const res = await runTarAsync(
    ['-xzOf', archivePath, '--occurrence=1', member],
    { timeoutMs: 120 * 1000, maxOutputBytes: 8 * 1024 * 1024 }
  );
  return res.code === 0 ? res.stdout : null;
}

// ── Сборка манифеста ─────────────────────────────────────────────────────────
/**
 * Канонический JSON (сортировка ключей, удаление лишних пробелов) для стабильного хеша:
 * одно и то же логическое содержимое → один и тот же отпечаток.
 */
function canonicalJson(obj) {
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Сборка манифеста (без собственного отпечатка; его добавляет finalizeManifest).
 * @param {object} ctx
 */
function buildManifest(ctx = {}) {
  const now = new Date();
  const dshVersion = ctx.dshVersion || null;
  const schemaVersion = ctx.schemaVersion
    ?? configSchemaForDshVersion(dshVersion)
    ?? null;
  const projectVersion = ctx.projectVersion || null;

  return {
    // —— Идентичность и происхождение ——
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    generator: 'deepseek-harness-docker/gateway/backup-service',
    generatorVersion: projectVersion,                 // версия комплекта (проекта)
    dockerSuiteVersion: projectVersion,               // явный псевдоним для удобного чтения из фронтенда/документации
    imageRevision: ctx.imageRevision || null,         // например proj0.1.8-dsh0.1.7-rc.1
    // —— Ось версий ——
    dshVersion,                                        // версия DSH-движка, реально работавшая в момент создания снимка
    dshVersionSource: ctx.dshVersionSource || 'unknown', // package.json|probe|cli|fallback|injected|unknown
    schemaVersion,                                     // поколение модели конфигурации (1=settings-file, 2=patch-layer)
    configModel: CONFIG_MODEL_LABEL[schemaVersion] || 'unknown',
    // —— Свойства архива ——
    backupType: ctx.backupType === 'config' ? 'config' : 'full',
    createdAt: now.toISOString(),
    createdAtEpochMs: now.getTime(),
    name: ctx.name || '',
    // —— Диапазон совместимости (заявление цепочки поставок на момент создания снимка, сохраняется как «исторический факт») ——
    compatibilityRange: ctx.compatibilityRange || null,
    // —— Отпечаток содержимого (для быстрой проверки «есть ли там определённый файл конфигурации») ——
    contents: ctx.contents || null,
    // —— Окружение хоста (диагностика при восстановлении на другой машине) ——
    host: ctx.host || null,
    // —— Статистика архива (необязательно, заполняется в sidecar после создания) ——
    archive: ctx.archive || null,
    // —— Целостность ——
    filesHash: {
      algorithm: 'sha256',
      manifestSelfHash: null,   // заполняется в finalize
      configTreeHash: null,     // необязательно: сводка дерева конфигурации (вычисляется асинхронно)
      fileCount: ctx.fileCount ?? null,
      totalBytes: ctx.totalBytes ?? null
    }
  };
}

/** Вычисление и запись собственного отпечатка манифеста (перекрывает все поля, кроме manifestSelfHash) */
function finalizeManifest(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.filesHash.manifestSelfHash = null;
  const hash = sha256Hex(canonicalJson(clone));
  manifest.filesHash.manifestSelfHash = hash;
  return manifest;
}

/** Проверка собственного отпечатка манифеста (обнаружение повреждения/подделки) */
function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'манифест отсутствует или не является объектом' };
  const expect = manifest.filesHash && manifest.filesHash.manifestSelfHash;
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.filesHash.manifestSelfHash = null;
  const actual = sha256Hex(canonicalJson(clone));
  if (!expect) return { ok: false, reason: 'отсутствует manifestSelfHash' };
  return expect === actual ? { ok: true } : { ok: false, reason: 'manifestSelfHash не совпадает (содержимое изменено)' };
}

// ── Кэш sidecar (ключ к работе listBackups без распаковки) ────────────────────────
function sidecarPath(snapshotsDir, filename) {
  return path.join(snapshotsDir, `${SIDECAR_PREFIX}${filename}${SIDECAR_SUFFIX}`);
}

function readSidecar(snapshotsDir, filename) {
  try {
    const p = sidecarPath(snapshotsDir, filename);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeSidecarAtomic(snapshotsDir, filename, payload) {
  const target = sidecarPath(snapshotsDir, filename);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

function removeSidecar(snapshotsDir, filename) {
  try {
    const p = sidecarPath(snapshotsDir, filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Соответствует ли sidecar всё ещё текущему файлу архива (двойное сравнение размера + mtime, чтобы кэш не устаревал после замены файла) */
function sidecarIsFresh(sidecar, stat) {
  if (!sidecar || !sidecar.archive) return false;
  return Number(sidecar.archive.sizeBytes) === Number(stat.size)
    && Number(sidecar.archive.mtimeMs) === Math.floor(stat.mtimeMs);
}

// ── Вывод версии для старых снимков ─────────────────────────────────────────────────
/**
 * Вывод версии и поколения снимка по структуре его участников.
 * Это ядро обратной совместимости для «существующих старых снимков»:
 * вывод доступен даже без метаданных, с указанием достоверности.
 */
function inferFromMembers(members, filename = '') {
  const set = new Set(members.map(m => m.replace(/\/+$/, '')));
  const has = p => set.has(p);
  const anyUnder = prefix => members.some(m => m === prefix || m.startsWith(prefix + '/'));

  const signals = [];
  const hasSettingsYaml = has('.dsh/settings.yaml');
  const hasSettingsImported = has('.dsh/settings.yaml.imported');
  const hasHomePatch = has('.dsh/cordis.patch.yml');
  const hasProfilesDir = anyUnder('.dsh/profiles');
  const hasSessions = anyUnder('.dsh/sessions');
  const hasCredentials = has('.dsh/.credentials.yaml');

  let schemaVersion = null;
  let confidence = 'low';

  // Признак 1 (самый сильный): cordis.patch.yml / settings.yaml.imported — продукты, характерные только для 0.1.7+
  if (hasHomePatch || hasSettingsImported) {
    schemaVersion = CONFIG_SCHEMA.PATCH_LAYER;
    confidence = 'high';
    signals.push(hasSettingsImported ? 'присутствует settings.yaml.imported (одноразовый продукт миграции из 0.1.7+)'
      : 'присутствует cordis.patch.yml уровня Home (слой патчей из 0.1.7+)');
  } else if (hasSettingsYaml) {
    schemaVersion = CONFIG_SCHEMA.SETTINGS_FILE;
    confidence = 'high';
    signals.push('присутствует settings.yaml и отсутствует cordis.patch.yml (модель settings-file из 0.1.6 и раньше)');
  } else if (hasProfilesDir) {
    // Нет сильных признаков: используем структуру каталога profiles/ и имя файла как слабую подсказку
    schemaVersion = null;
    confidence = 'low';
    signals.push('обнаружен только каталог profiles/ — поколение определить нельзя');
  }

  // Определение типа снимка: в первую очередь по фактическому содержимому (есть сессии — full, нет сессий — config);
  // имя файла служит лишь слабой подсказкой, если участников нет вовсе
  const backupType = (members && members.length > 0)
    ? (hasSessions ? 'full' : 'config')
    : (/(^|[-_])config([-_]|\.)/.test(filename) ? 'config' : 'full');

  return {
    inferred: true,
    confidence,
    signals,
    backupType,
    schemaVersion,
    configModel: CONFIG_MODEL_LABEL[schemaVersion] || 'unknown',
    dshVersion: null,                    // структурный вывод даёт только поколение, но не точную версию
    dshVersionRange: schemaVersion === CONFIG_SCHEMA.PATCH_LAYER ? `>=${PATCH_LAYER_EPOCH}`
      : schemaVersion === CONFIG_SCHEMA.SETTINGS_FILE ? `<${PATCH_LAYER_EPOCH}` : null,
    contents: { hasSettingsYaml, hasSettingsImported, hasCordisPatchYml: hasHomePatch, hasProfilesDir, hasSessions, hasCredentials }
  };
}

// ── Инспекция архива (общая для listBackups / API инспекции) ──────────────────────────────
/**
 * Чтение метаданных снимка: sidecar → манифест внутри архива → структурный вывод.
 * Результат записывается в sidecar, чтобы последующие вызовы работали за O(1).
 * @returns {Promise<object>} { filename, meta, metaSource, confidence, verified, archive }
 */
async function inspectArchive(archivePath, opts = {}) {
  const filename = opts.filename || path.basename(archivePath);
  const snapshotsDir = opts.snapshotsDir || path.dirname(archivePath);
  const stat = fs.statSync(archivePath);
  const archive = { sizeBytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };

  // 1) попадание в sidecar (и он актуален)
  if (!opts.force) {
    const sc = readSidecar(snapshotsDir, filename);
    if (sidecarIsFresh(sc, stat) && sc.meta) {
      return { filename, meta: sc.meta, metaSource: sc.metaSource || 'sidecar', confidence: sc.confidence || 'high', verified: Boolean(sc.verified), archive, fromCache: true };
    }
  }

  // 2) манифест внутри архива
  let meta = null;
  let metaSource = 'none';
  let confidence = 'none';
  let verified = false;
  try {
    const inline = await readManifestFromArchive(archivePath);
    if (inline && inline.manifestVersion) {
      meta = inline;
      metaSource = 'inline';
      confidence = 'high';
      const v = verifyManifest(inline);
      verified = v.ok;
    }
  } catch { /* при повреждении архива откатываемся к выводу по структуре */ }

  // 3) структурный вывод (старые снимки)
  if (!meta) {
    try {
      const members = await listMembers(archivePath);
      const inf = inferFromMembers(members, filename);
      meta = buildManifest({
        dshVersion: null,
        dshVersionSource: 'inferred',
        schemaVersion: inf.schemaVersion,
        backupType: inf.backupType,
        name: filename.replace(/\.tar\.gz$/i, ''),
        contents: inf.contents
      });
      meta.inferred = true;
      meta.inference = { confidence: inf.confidence, signals: inf.signals, dshVersionRange: inf.dshVersionRange };
      finalizeManifest(meta);
      metaSource = 'inferred';
      confidence = inf.confidence;
    } catch {
      meta = null;
    }
  }

  const payload = { meta, metaSource, confidence, verified, archive };
  if (meta) writeSidecarAtomic(snapshotsDir, filename, payload);
  return { filename, ...payload, fromCache: false };
}

// ── Оценка совместимости версий ─────────────────────────────────────────────────
/**
 * Определение уровня риска «восстановить этот снимок в текущую систему».
 *
 * @param {object} snapshotMeta  манифест снимка (может быть результатом вывода)
 * @param {object} current       { dshVersion, schemaVersion, projectVersion }
 * @param {object} [opts]        { rules } compatibility.rules из version.json (единый источник данных)
 * @returns {object} вердикт
 */
function assessCompatibility(snapshotMeta, current, opts = {}) {
  const snapVer = snapshotMeta && snapshotMeta.dshVersion;
  const snapSchema = snapshotMeta && snapshotMeta.schemaVersion;
  const curVer = current && current.dshVersion;
  const curSchema = current && current.schemaVersion;

  const messages = [];
  let level = 'ok';
  let code = 'EXACT_MATCH';
  const bump = lv => {
    const w = { ok: 0, info: 1, warning: 2, danger: 3, unknown: 2 };
    if ((w[lv] || 0) > (w[level] || 0)) level = lv;
  };

  // 1) версия отсутствует → неизвестно, требуется явное подтверждение
  if (!isValidSemver(snapVer) || !isValidSemver(curVer)) {
    code = 'UNKNOWN_VERSION';
    bump('unknown');
    messages.push({
      level: 'unknown',
      title: 'Не удалось определить версию DSH снимка',
      message: snapshotMeta && snapshotMeta.inferred
        ? `В снимке нет метаданных версии, выполнен только структурный вывод (достоверность ${snapshotMeta.inference?.confidence || 'low'}).` +
          `${snapshotMeta.inference?.dshVersionRange ? ` Выведенный применимый диапазон: ${snapshotMeta.inference.dshVersionRange}.` : ''} Подтвердите перед восстановлением.`
        : `Не удалось разобрать версию DSH снимка или текущей системы (снимок=${snapVer || 'неизвестно'}, текущая=${curVer || 'неизвестно'}).`,
      action: 'acknowledge'
    });
  } else {
    const cmp = compareSemver(snapVer, curVer);
    const sp = parseSemver(snapVer);
    const cp = parseSemver(curVer);

    if (cmp === 0) {
      code = 'EXACT_MATCH';
      messages.push({ level: 'ok', title: 'Версии полностью совпадают', message: `Снимок и текущая система имеют одинаковую версию v${curVer} — риск восстановления минимален.` });
    } else if (sp.major === cp.major && sp.minor === cp.minor) {
      code = 'PATCH_DIFF';
      bump('info');
      messages.push({ level: 'info', title: 'Одна major.minor-версия (различия только в патчах)', message: `Снимок v${snapVer} и текущая v${curVer} относятся к одной major.minor-версии, модель конфигурации совпадает — обычно можно восстанавливать напрямую.` });
    } else if (sp.major === cp.major) {
      // одна major-версия, разные minor: риск перехода между поколениями дополнительно повышается по оси schema
      code = cmp < 0 ? 'MINOR_DOWNGRADE' : 'MINOR_UPGRADE';
      bump('warning');
      messages.push({
        level: 'warning',
        title: cmp < 0 ? 'Понижение minor-версии' : 'Повышение minor-версии',
        message: `Снимок v${snapVer} и текущая v${curVer} различаются minor-версией${cmp < 0 ? ' (понижение)' : ' (повышение)'} — возможны добавления/удаления полей конфигурации; после восстановления проверьте настройки.`
      });
    } else {
      code = 'MAJOR_DIFF';
      bump('danger');
      messages.push({
        level: 'danger',
        title: 'Major-версии не совпадают',
        message: `Снимок v${snapVer} и текущая v${curVer} различаются major-версией — базовая архитектура/протокол официально могли быть переработаны, конфигурация после восстановления может не распознаваться.`
      });
    }
  }

  // 2) ось поколения модели конфигурации (ближе к вопросу «прочитается ли конфигурация», чем номер версии)
  if (snapSchema != null && curSchema != null && snapSchema !== curSchema) {
    code = code === 'UNKNOWN_VERSION' ? code : 'SCHEMA_ERA_CROSS';
    if (snapSchema > curSchema) {
      // снимок нового поколения → система старого поколения: cordis.patch.yml будет проигнорирован → потеря конфигурации
      bump('danger');
      messages.push({
        level: 'danger',
        title: 'Модели конфигурации несовместимы (новая → старая)',
        message: `Снимок использует модель ${CONFIG_MODEL_LABEL[snapSchema]} (${snapSchema}), текущая система — ${CONFIG_MODEL_LABEL[curSchema]} (${curSchema}); ` +
          `старый движок не распознаёт cordis.patch.yml, после восстановления конфигурация слоя патчей станет неактуальной. Рекомендуется повысить DSH до >= ${PATCH_LAYER_EPOCH} перед восстановлением.`
      });
    } else {
      // снимок старого поколения → система нового поколения: settings.yaml будет одноразово импортирован и переименован
      bump('warning');
      messages.push({
        level: 'warning',
        title: 'Переход между поколениями модели конфигурации (старая → новая, одноразовый импорт)',
        message: `Снимок относится к модели ${CONFIG_MODEL_LABEL[snapSchema]} (${snapSchema}), текущая — ${CONFIG_MODEL_LABEL[curSchema]} (${curSchema}); ` +
          `старый settings.yaml будет импортирован один раз при запуске DSH и переименован в settings.yaml.imported, после импорта авторитетным становится слой патчей.`
      });
    }
  }

  // 3) переиспользование официальных правил совместимости из version.json (единый источник данных, чтобы правила не расходились)
  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  if (isValidSemver(snapVer)) {
    const sev = { danger: 3, warning: 2, info: 1 };
    for (const rule of [...rules].sort((a, b) => (sev[b.level] || 0) - (sev[a.level] || 0))) {
      if (matchSemverPattern(snapVer, rule.pattern)) {
        bump(rule.level === 'danger' ? 'danger' : rule.level === 'warning' ? 'warning' : 'info');
        messages.push({ level: rule.level || 'warning', title: rule.title || 'Подсказка о совместимости версии', message: rule.message || '', action: rule.action || '' });
        break; // останавливаемся на первом (наиболее опасном) совпавшем правиле
      }
    }
  }

  const requiresAcknowledgement = level === 'warning' || level === 'danger' || level === 'unknown';
  const canProceed = level !== 'danger' || opts.allowDanger === true;

  return {
    level,
    code,
    snapshot: { dshVersion: snapVer || null, schemaVersion: snapSchema ?? null, configModel: CONFIG_MODEL_LABEL[snapSchema] || 'unknown', inferred: Boolean(snapshotMeta && snapshotMeta.inferred) },
    current: { dshVersion: curVer || null, schemaVersion: curSchema ?? null, configModel: CONFIG_MODEL_LABEL[curSchema] || 'unknown' },
    messages,
    requiresAcknowledgement,
    canProceed
  };
}

function matchSemverPattern(ver, pattern) {
  if (!ver || !pattern) return false;
  const p = String(pattern).trim();
  if (p.startsWith('>=')) return compareSemver(ver, p.slice(2).trim()) >= 0;
  if (p.startsWith('>')) return compareSemver(ver, p.slice(1).trim()) > 0;
  if (p.startsWith('<=')) return compareSemver(ver, p.slice(2).trim()) <= 0;
  if (p.startsWith('<')) return compareSemver(ver, p.slice(1).trim()) < 0;
  if (p.startsWith('=')) return compareSemver(ver, p.slice(1).trim()) === 0;
  return compareSemver(ver, p) === 0;
}

// ── Идентификатор версии для одиночных файлов конфигурации (gateway.config.json / cordis.patch.yml) ──────────
const YAML_STAMP_BEGIN = '# >>> dsh-snapshot-meta (auto-generated, do not edit) >>>';
const YAML_STAMP_END = '# <<< dsh-snapshot-meta <<<';

/** Генерация версионного штампа для записи в файл конфигурации (сокращённая версия, чтобы не засорять семантику конфигурации) */
function buildFileStamp(ctx = {}) {
  return {
    dshVersion: ctx.dshVersion || null,
    schemaVersion: ctx.schemaVersion ?? configSchemaForDshVersion(ctx.dshVersion),
    configModel: CONFIG_MODEL_LABEL[ctx.schemaVersion ?? configSchemaForDshVersion(ctx.dshVersion)] || 'unknown',
    dockerSuiteVersion: ctx.projectVersion || null,
    imageRevision: ctx.imageRevision || null,
    stampedAt: new Date().toISOString()
  };
}

/** Наложение штампа на объект JSON-конфигурации (идемпотентно: перезаписывает старый _snapshotMeta) */
function stampJsonConfig(obj, stamp) {
  if (!obj || typeof obj !== 'object') return obj;
  return { ...obj, _snapshotMeta: { ...buildFileStamp(stamp), note: 'Идентификатор версии, записанный комплектом DSH; используется для оценки совместимости при резервном копировании/восстановлении' } };
}

/** Чтение версионного штампа из JSON-конфигурации */
function readJsonStamp(obj) {
  return obj && typeof obj === 'object' && obj._snapshotMeta ? obj._snapshotMeta : null;
}

/**
 * Наложение штампа на текст YAML: в виде **блока комментариев** в начале файла.
 * Комментарии не участвуют в разборе YAML, поэтому семантика конфигурации не меняется;
 * операция идемпотентна (старый блок удаляется перед записью нового).
 */
function stampYamlText(text, stamp) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = [
    YAML_STAMP_BEGIN,
    ...Object.entries(buildFileStamp(stamp)).map(([k, v]) => `# ${k}: ${v == null ? 'null' : v}`),
    YAML_STAMP_END
  ].join('\n');
  const cleaned = stripYamlStamp(body);
  return `${lines}\n${cleaned.replace(/^\n+/, '')}`;
}

function stripYamlStamp(text) {
  const re = new RegExp(`${escapeRe(YAML_STAMP_BEGIN)}[\\s\\S]*?${escapeRe(YAML_STAMP_END)}\\n?`, 'g');
  return String(text ?? '').replace(re, '');
}

function readYamlStamp(text) {
  const re = new RegExp(`${escapeRe(YAML_STAMP_BEGIN)}\\n([\\s\\S]*?)\\n${escapeRe(YAML_STAMP_END)}`);
  const m = String(text ?? '').match(re);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^#\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2] === 'null' ? null : mm[2];
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  // константы
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_MEMBER,
  MANIFEST_DIR_IN_DSH,
  CONFIG_SCHEMA,
  CONFIG_MODEL_LABEL,
  PATCH_LAYER_EPOCH,
  // semver
  parseSemver,
  isValidSemver,
  compareSemver,
  sameMajorMinor,
  matchSemverPattern,
  configSchemaForDshVersion,
  // tar
  runTarAsync,
  readManifestFromArchive,
  listMembers,
  readMemberFromArchive,
  // манифест
  canonicalJson,
  sha256Hex,
  buildManifest,
  finalizeManifest,
  verifyManifest,
  // sidecar
  sidecarPath,
  readSidecar,
  writeSidecarAtomic,
  removeSidecar,
  sidecarIsFresh,
  // вывод / инспекция
  inferFromMembers,
  inspectArchive,
  // оценка совместимости
  assessCompatibility,
  // штампы конфигурации
  buildFileStamp,
  stampJsonConfig,
  readJsonStamp,
  stampYamlText,
  stripYamlStamp,
  readYamlStamp
};
