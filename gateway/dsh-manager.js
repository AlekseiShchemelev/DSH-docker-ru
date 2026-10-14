const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const DSH_WORKSPACE = process.env.DSH_WORKSPACE || '/workspace';
const DSH_WEB_LOG = process.env.DSH_WEB_LOG || '/tmp/dsh-web.log';
const SNAPSHOTS_DIR = process.env.DSH_SNAPSHOTS_DIR || '/root/.dsh-snapshots';
const DSH_DIR = path.join(process.env.DSH_HOME || '/root', '.dsh');
const backupService = require('./backup-service');
const { isValidVersion, resolveWithinDir } = require('./dsh-version');

try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DSH_WORKSPACE, { recursive: true }); } catch {}

function killPortProcess(port) {
  // Предохранитель: никогда не чистим порт самого шлюза (если DSH_PORT ошибочно настроен как PROXY_PORT, `fuser -k` убьёт сам шлюз)
  const proxyPort = Number(process.env.PROXY_PORT) || 3080;
  if (Number(port) === proxyPort) {
    console.warn(`[dsh-manager] Пропуск очистки порта: целевой порт ${port} совпадает с портом шлюза, во избежание случайного убийства собственного процесса`);
    return;
  }
  try {
    spawnSync('fuser', ['-k', '-9', `${port}/tcp`], { stdio: 'ignore' });
  } catch {}
  try {
    const res = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        // Точная фильтрация: обрабатываем только «процесс dsh web на данном DSH-порту», чтобы не задеть другие одноимённые команды
        if (!/dsh\s+web(\s|$)/.test(line)) continue;
        if (!line.includes(String(port))) continue;
        const m = line.trim().match(/^(\d+)/);
        if (m) {
          const pid = Number(m[1]);
          if (pid !== process.pid) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      }
    }
  } catch {}
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function ensurePortReleased(port, timeoutMs = 3500) {
  killPortProcess(port);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let inUse = false;
    try {
      const res = spawnSync('ss', ['-tlpn'], { encoding: 'utf8' });
      if (res.stdout && res.stdout.includes(`:${port}`)) {
        inUse = true;
      }
    } catch {}

    // Двойная проверка через модуль net на случай, если утилиты `ss` нет или она дала ложный результат
    if (!inUse) {
      inUse = await isPortInUse(port);
    }

    if (!inUse) return true;
    killPortProcess(port);
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// ── Единый источник метаданных версий ────────────────────────────────────────────
// «Поддерживаемые версии» ранее велись в трёх местах: в этом файле, в version-service.js
// и в version.json. При обновлении этот файл нередко забывали править, из-за чего
// панель управления ошибочно считала 0.1.7-alpha.1/alpha.2 «специально не адаптированными».
// Теперь единообразно в 우선ном порядке читается compatibility.adaptedVersions из
// version.json в корне репозитория, что исключает повторное расхождение.
const VERSION_META_PATHS = [
  path.join(__dirname, '../version.json'),
  path.join(__dirname, 'version.json'),
  '/app/version.json'
];

function readVersionMeta() {
  for (const p of VERSION_META_PATHS) {
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (meta && typeof meta === 'object') return meta;
    } catch {}
  }
  return null;
}

const VERSION_META = readVersionMeta();

// Резервный список: используется только при отсутствии version.json; должен поддерживаться в синхронизме с compatibility.recommendedDsh
const DEFAULT_ADAPTED_VERSIONS = [
  '0.2.1-alpha.2',
  '0.2.1-alpha.1',
  '0.2.0-rc.2',
  '0.2.0-rc.1',
  '0.1.7-rc.2',
  '0.1.7-rc.1',
  '0.1.7-alpha.2',
  '0.1.7-alpha.1',
  '0.1.6-alpha.2',
  '0.1.6-alpha.1',
  '0.1.5-rc.2',
  '0.1.5-rc.1',
  '0.1.2-rc.1'
];

// Резервный номер версии при неудаче определения (в приоритете берётся зафиксированная в version.json версия из цепочки поставок)
const FALLBACK_DSH_VERSION = (VERSION_META && VERSION_META.supply && VERSION_META.supply.dshVersion) || '0.2.1-alpha.2';

function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
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

// ── Хранилище версий (постоянный путь) и примитивы подмены каталогов ──────────────────────────────
// Исправление Issue #7: архивы версий ранее складывались в /app (записываемый слой контейнера),
// поэтому пересоздание контейнера или обновление образа стирали их, и «возврат к старой версии»
// требовал повторной загрузки. Теперь они перенесены в постоянный путь $DSH_SNAPSHOTS_DIR/versions
// (том со снимками, см. VERSIONS_DIR ниже), а схема «сначала rm -rf активного ядра, затем cp»
// заменена на «staging-копирование + подмену каталога (приоритетно rename; на нижнем слое
// overlayfs — откат на копирование + удаление)».
const DSH_HOME_DIR = process.env.DSH_HOME || '/root';
// Хранилище версий по умолчанию размещается как подкаталог внутри тома «Снимки и резервные копии»
// (переиспользуется существующее примонтирование ./data/snapshots, новые точки монтирования не добавляются).
// Это ленивый кэш: он читается только при «переключении версии», в остальное время его можно
// удалить в любой момент (цена — лишь повторная загрузка при следующем возврате).
// Пользователям, которым нужна изоляция, можно указать DSH_VERSIONS_DIR на отдельный том,
// например /root/.dsh-versions.
const VERSIONS_DIR = process.env.DSH_VERSIONS_DIR || path.join(SNAPSHOTS_DIR, 'versions');
const STORE_STAGING_DIR = path.join(VERSIONS_DIR, '.staging');
// Тестовый хук: позволяет направить «каталог-родитель активного ядра / символическую ссылку dsh»
// во временный каталог, чтобы в юнит-тестах проверять логику подмены и отката.
// В продакшене эти переменные не задаются, поведение полностью идентично.
const LIVE_CORE_PARENT = process.env.DSH_TEST_CORE_PARENT || '/usr/local/lib/node_modules/@deepseek-ai';
const LIVE_CORE_DIR = path.join(LIVE_CORE_PARENT, 'dsh');
const DSH_BIN_LINK = process.env.DSH_TEST_BIN_LINK || '/usr/local/bin/dsh';
const ROLLBACK_PRESERVED_DIR = path.join(LIVE_CORE_PARENT, '.dsh-rollback-preserved');
const READY_FILE = '.ready';
const GC_KEEP_DEFAULT = Number(process.env.DSH_VERSIONS_KEEP) || 3;
// Порог свободного места на диске перед переключением (МБ, по умолчанию 1536; можно переопределить
// через DSH_VERSIONS_MIN_FREE_MB для слабых сред и учёжных сценариев)
const MIN_FREE_BYTES = Math.max(64, Number(process.env.DSH_VERSIONS_MIN_FREE_MB) || 1536) * 1024 * 1024;

// Идентификатор образа: один и тот же номер версии dsh может встречаться в образах разных проектов
// (если version.json не менялся, dshVersion совпадает); записывается в .ready для диагностики
// «из какого образа получен архив».
const IMAGE_REVISION = (() => {
  const p = (VERSION_META && VERSION_META.latest && VERSION_META.latest.version) || 'unknown';
  const d = (VERSION_META && VERSION_META.supply && VERSION_META.supply.dshVersion) || 'unknown';
  return `proj${p}-dsh${d}`;
})();

try { fs.mkdirSync(STORE_STAGING_DIR, { recursive: true }); } catch {}

/** Запуск внешней команды с выбрасыванием ошибки при неудаче (вместо молчаливого отказа голого spawnSync) */
function runSyncSafe(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (res.error) throw new Error(`Не удалось выполнить ${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim().slice(0, 300);
    throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} … код выхода ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res;
}

function isNonEmptyDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; } catch { return false; }
}

/**
 * Перемещение каталога src в dst.
 * Важная тонкость (проверено удалённо): каталог, расположенный на нижнем слое overlayfs
 * (только для чтения слой образа), нельзя переименовать — ядро возвращает EXDEV
 * (cross-device link not permitted). Активное ядро `/usr/local/lib/node_modules/
 * @deepseek-ai/dsh`, если после запуска контейнера его не перезаписывали, как раз находится
 * на нижнем слое; в этом случае приходится откатываться на «копирование + удаление».
 * Семантически это эквивалентно, цена — одна дополнительная копия (ветка срабатывает лишь
 * при первом переключении в рамках каждого поколения контейнера).
 * @returns {'rename'|'copy'}
 */
function moveDirOrCopy(src, dst) {
  try {
    fs.renameSync(src, dst);
    return 'rename';
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.mkdirSync(dst, { recursive: true });
    runSyncSafe('cp', ['-a', src + '/.', dst + '/']);
    runSyncSafe('rm', ['-rf', src]);
    return 'copy';
  }
}

/** Восстановление активного ядра из резервной копии (также совместимо с EXDEV на overlayfs) */
function restoreCoreFromBackup(backupDir) {
  if (!fs.existsSync(backupDir)) throw new Error('Точка отката не существует, восстановление невозможно');
  try { fs.rmSync(LIVE_CORE_DIR, { recursive: true, force: true }); } catch {}
  moveDirOrCopy(backupDir, LIVE_CORE_DIR);
}

/** Подсчёт числа файлов и суммарного размера в байтах каталога (для метаданных целостности .ready) */
function measureDir(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(p).size; } catch {} }
    }
  }
  return { files, bytes };
}

function readReadyMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, READY_FILE), 'utf8'));
    return (m && typeof m === 'object') ? m : null;
  } catch { return null; }
}

/** Полностью ли пригоден каталог архива: подпись .ready + package.json + непустой node_modules, а также совпадение ABI / архитектуры Node */
function isReadyVersionDir(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) return false;
  const marker = readReadyMarker(dir);
  if (!marker) return false; // нет подписи → считается незавершённым, никогда не разворачивается
  if (marker.nodeAbi && String(marker.nodeAbi) !== String(process.versions.modules)) return false;
  if (marker.arch && marker.arch !== process.arch) return false;
  return isNonEmptyDir(path.join(dir, 'node_modules'));
}

function writeReadyMarker(dir, version) {
  const { files, bytes } = measureDir(dir);
  const marker = {
    version,
    nodeAbi: process.versions.modules,
    nodeVersion: process.versions.node,
    arch: process.arch,
    imageRevision: IMAGE_REVISION,
    fileCount: files,
    sizeBytes: bytes,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, READY_FILE), JSON.stringify(marker, null, 2));
  return marker;
}

function dirSizeBytes(dir) {
  return measureDir(dir).bytes;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return 'неизвестно';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

/** Лежит ли целевой путь под каким-либо реальным точкой монтирования (для проверки, действительно ли хранилище версий персистентно) */
function isMountedPath(p) {
  try {
    const info = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    return info.split('\n').some(line => {
      const mp = (line.split(' ')[4] || '');
      return mp && mp !== '/' && (p === mp || p.startsWith(mp.endsWith('/') ? mp : mp + '/'));
    });
  } catch { return false; }
}

/** Перечисление записей в персистентном хранилище версий (с размером и временем последнего использования) */
function listStoreEntries() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(VERSIONS_DIR); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(VERSIONS_DIR, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    out.push({
      version: name,
      dir,
      ready: isReadyVersionDir(dir),
      marker: readReadyMarker(dir),
      mtimeMs: st.mtimeMs,
      sizeBytes: dirSizeBytes(dir)
    });
  }
  return out;
}

class DshManager {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.installing = false;
    this.stopping = false;
    this.installLog = [];
    this.registry = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
    this.launchToken = '';
    this.upstreamCookie = '';
    // Персистентное хранилище версий (Issue #7): сохраняется после пересоздания контейнера / обновления образа,
    // возврат к предыдущей версии выполняется мгновенно без повторной загрузки
    this.versionsCacheDir = VERSIONS_DIR;
    // Защищённый слот локальной точки отката в слое контейнера (хранится одна копия, не персистентна)
    this.rollbackPreservedDir = ROLLBACK_PRESERVED_DIR;
    this.lastGcAt = 0;
    this.restartTimer = null;
    this.lastCrashTime = 0;
    this.manualStopped = false;
    this.startTime = 0;
    this.recentLogs = [];
    this.lastExitInfo = null;
    this.lastKnownVersion = '';
    this.autoHealEnabled = true;
    this.maxAutoHealPerBoot = 5;
    this.autoHealCountInCurrentBoot = 0;
    this.autoIsolatedEvents = [];
    // Последовательная очередь операций жизненного цикла: boot/stop/restart выполняются по очереди,
    // что исключает одновременный запуск и конфликты между защитным самовосстановлением
    this._opChain = Promise.resolve();
    // Окно аварий (M4): предохранитель срабатывает по «числу аварий за последние некоторое время»,
    // а не сбрасывается одним успешным запуском до готовности
    this.crashWindow = [];
    try {
      fs.mkdirSync(this.versionsCacheDir, { recursive: true });
    } catch (e) {
      // Без молчания: недоступное на запись хранилище версий приведёт к тому, что «возврат к прошлой версии потребует повторной загрузки»;
      // это должно быть заметно сопровождающему персоналу
      console.warn(`[dsh-manager] ⚠️ Каталог хранилища версий недоступен (${this.versionsCacheDir}): ${e.message}; возврат к предыдущей версии будет выполнен через повторную загрузку`);
    }
  }

  // Сериализация операций жизненного цикла: предыдущая операция (успех или отказ) не блокирует последующие
  _enqueue(task) {
    const run = this._opChain.then(task, task);
    // Сторожевой таймер (последний рубеж защиты): если задача не завершится за 180 с (утечка внутреннего Promise и т.п.),
    // фиксируется предупреждение и последующие операции пропускаются, чтобы вся очередь жизненного цикла не зависла навсегда.
    let timer = null;
    const guarded = Promise.race([
      run,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn('[dsh-manager] ⚠️ Операция жизненного цикла не вернулась за 180 с, последующие операции пропускаются (сработал сторожевой таймер)');
          resolve({ ok: false, error: 'operation_timeout' });
        }, 180000);
        if (timer.unref) timer.unref();
      })
    ]);
    // Важно: таймер снимается, как только операция завершилась. В исходной реализации он никогда не снимался → даже если операция давно уже успешно завершилась,
    // процесс через 180 с после запуска всё равно печатал ложное предупреждение «сработал сторожевой таймер» (именно такие ложные срабатывания наблюдались удалённо).
    const clear = () => { if (timer) clearTimeout(timer); };
    guarded.then(clear, clear);
    this._opChain = guarded.then(() => {}, () => {});
    return guarded;
  }

  setAutoHeal(enabled, maxPerBoot = 5) {
    this.autoHealEnabled = enabled !== false;
    this.maxAutoHealPerBoot = Math.max(1, Math.min(50, Number(maxPerBoot) || 5));
    console.log(`[dsh-manager] Политика самовосстановления при авариях запуска и автоизоляции плагинов обновлена: ${this.autoHealEnabled ? 'включена' : 'выключена'} (лимит за один цикл: ${this.maxAutoHealPerBoot})`);
  }

  getAutoIsolatedEvents() {
    return this.autoIsolatedEvents || [];
  }

  clearAutoIsolatedEvents() {
    this.autoIsolatedEvents = [];
  }

  detectCrashingPlugin(recentLogs = []) {
    let combinedLogs = Array.isArray(recentLogs) ? [...recentLogs] : [];
    if (this.lastExitInfo && Array.isArray(this.lastExitInfo.logs)) {
      combinedLogs = [...this.lastExitInfo.logs, ...combinedLogs];
    }
    try {
      if (fs.existsSync(DSH_WEB_LOG)) {
        const fileContent = fs.readFileSync(DSH_WEB_LOG, 'utf8');
        const fileLines = fileContent.split('\n').filter(Boolean).slice(-150);
        combinedLogs = [...fileLines, ...combinedLogs];
      }
    } catch {}

    const logText = combinedLogs.join('\n');
    if (!logText.trim()) return null;

    let pluginsList = [];
    try {
      const pm = require('./plugin-manager');
      const res = pm.getPlugins();
      if (res && Array.isArray(res.plugins)) {
        pluginsList = res.plugins;
      }
    } catch (e) {
      console.warn('[dsh-manager] Не удалось получить список плагинов для анализа аварий:', e.message);
      return null;
    }

    // Строго запрещается изолировать системные ядерные компоненты; анализируются только неядерные включённые плагины
    const candidatePlugins = pluginsList.filter(p => !p.isCore && p.enabled && !p.isUninstalled);
    if (candidatePlugins.length === 0) return null;

    // 1. Извлечение структурированных ошибок загрузчика Cordis о записях загрузчика
    // Совпадения вида: failed to import loader entry archived-chats (dsh-archived-chats): ...
    // или: failed to apply loader entry include (cordis:include): ...
    // или: loader entry <id> (<name>): ...
    const cordisEntryRegex = /(?:loader entry|failed to (?:import|apply|load|resolve)[^:\n]*loader entry)\s+([a-zA-Z0-9_\-\.\@\/]+)(?:\s*\(([@a-zA-Z0-9_\-\.\/]+)\))?/gi;
    let m;
    while ((m = cordisEntryRegex.exec(logText)) !== null) {
      const entryId = m[1];
      const pkgName = m[2];
      for (const p of candidatePlugins) {
        if (p.isCore) continue;
        const cleanName = p.name.replace(/^@.*\//, '');
        if ((pkgName && (p.name === pkgName || cleanName === pkgName || p.name.endsWith('/' + pkgName))) ||
            (entryId && (p.name === entryId || cleanName === entryId || p.name === 'dsh-' + entryId || cleanName === 'dsh-' + entryId))) {
          return {
            name: p.name,
            reason: 'cordis_loader_entry_failure',
            matched: `Загрузчик Cordis явно сообщил о сбое загрузки записи: ${entryId}${pkgName ? ` (${pkgName})` : ''}`
          };
        }
      }
    }

    // 2. Обнаружение явного имени пакета в скобках (Cordis всегда указывает имя пакета в скобках в сообщениях об ошибках, например `(dsh-archived-chats)`)
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const short = p.name.replace(/^@.*\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('\\(\\s*(?:' + escaped + '|' + short + ')\\s*\\)', 'i').test(logText)) {
        return {
          name: p.name,
          reason: 'plugin_paren_mention',
          matched: `Сообщение об ошибке загрузчика явно указывает на сбойное расширение: (${p.name})`
        };
      }
    }

    // 3. Обнаружение общих сбоев загрузки и импорта зависимостей (failed to import/load/apply ... <pluginName>)
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const short = p.name.replace(/^@.*\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('failed to (?:import|apply|load|resolve)[^\\n]*?\\b(?:' + escaped + '|' + short + ')\\b', 'i').test(logText)) {
        return {
          name: p.name,
          reason: 'failed_to_import',
          matched: `В журнале обнаружен сбой загрузки расширения: ${p.name}`
        };
      }
    }

    // 4. Глубокое сканирование: локализация по стеку вызовов Node.js (node_modules/<name>/... или imported from ...<name>)
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stackRegex = new RegExp(`(?:node_modules[\\\\/]${escaped}[\\\\/]|imported from.*${escaped})`, 'i');
      if (stackRegex.test(logText)) {
        return {
          name: p.name,
          reason: 'stack_trace_match',
          matched: `Стек вызовов напрямую указывает на сбойный плагин: ${p.name}`
        };
      }
    }

    // 5. Конфликт конфигурации патчей Cordis: требуется «структурированная» ошибка разбора, причём имя плагина должно встретиться **в одной строке**.
    //    Старая реализация срабатывала при любом совпадении «patch» и имени плагина в тексте, что часто давало ложные срабатывания (например, на логи патч-скриптов этого проекта).
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const names = esc(p.name) + '|' + esc(p.name.replace(/^@.*\//, ''));
      const reA = new RegExp('(patch|yaml|yml)[^\\n]*?(parse|syntax|invalid|conflict|error)[^\\n]*?(?:' + names + ')', 'i');
      const reB = new RegExp('(?:' + names + ')[^\\n]*?(patch|yaml|yml)[^\\n]*?(parse|syntax|invalid|conflict|error)', 'i');
      if (reA.test(logText) || reB.test(logText)) {
        return {
          name: p.name,
          reason: 'patch_conflict',
          matched: `Конфликт разбора конфигурации патчей Cordis: ${p.name}`
        };
      }
    }

    // 6. Фатальные ошибки по собственному тегу плагина: тег и признак ошибки должны встретиться **в одной строке**.
    //    Старая реализация искала их в произвольных местах текста, из-за чего ошибки других плагинов могли ложно обвинять этот плагин.
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const short = p.name.replace(/^@.*\//, '');
      const tagEsc = ('[' + short + ']').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(tagEsc + '[^\\n]*?(Error|Exception|FATAL|crash|failed)', 'i');
      if (re.test(logText)) {
        return {
          name: p.name,
          reason: 'plugin_logger_error',
          matched: `Во внутреннем журнале плагина напечатано фатальное исключение: [${short}]`
        };
      }
    }

    return null;
  }

  getStatus() {
    const running = !!this.proc && this.proc.exitCode === null && !this.proc.killed;
    const currentVer = this.getCurrentVersion();
    return {
      version: currentVer,
      running,
      ready: this.ready,
      manualStopped: !!this.manualStopped,
      pid: running && this.proc ? this.proc.pid : null,
      startTime: this.startTime,
      cachedVersions: this.getCachedVersions(),
      lastExitInfo: this.lastExitInfo,
      recentLogs: this.getRecentLogs(30),
      autoHealEnabled: this.autoHealEnabled,
      autoHealMaxPerBoot: this.maxAutoHealPerBoot,
      autoHealCountInCurrentBoot: this.autoHealCountInCurrentBoot,
      autoIsolatedEvents: this.autoIsolatedEvents
    };
  }

  getRecentLogs(count = 150) {
    if (this.recentLogs && this.recentLogs.length > 0) {
      return this.recentLogs.slice(-count);
    }
    try {
      if (fs.existsSync(DSH_WEB_LOG)) {
        const content = fs.readFileSync(DSH_WEB_LOG, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        return lines.slice(-count);
      }
    } catch {}
    return [];
  }

  getCachedVersions() {
    try {
      if (!fs.existsSync(this.versionsCacheDir)) return [];
      return fs.readdirSync(this.versionsCacheDir).filter(name => {
        if (name.startsWith('.')) return false; // пропуск внутренних каталогов вроде .staging
        // Обязательна проверка целостности .ready: неполный результат (с лежащим лишь package.json) ни в коем случае не считается «закэшированным»
        return isReadyVersionDir(path.join(this.versionsCacheDir, name));
      });
    } catch {
      return [];
    }
  }

  getAdaptedVersions(meta = null) {
    if (process.env.ADAPTED_DSH_VERSIONS) {
      return process.env.ADAPTED_DSH_VERSIONS.split(',').map(s => s.trim()).filter(Boolean);
    }
    let liveMeta = meta;
    if (!liveMeta) {
      try {
        const versionService = require('./version-service');
        if (versionService && typeof versionService.getLiveMeta === 'function') {
          liveMeta = versionService.getLiveMeta();
        }
      } catch {}
    }
    const liveList = liveMeta && liveMeta.compatibility && liveMeta.compatibility.adaptedVersions;
    if (Array.isArray(liveList) && liveList.length) return liveList;

    // Откат к единому источнику данных: локальный version.json -> DEFAULT_ADAPTED_VERSIONS
    const localList = VERSION_META && VERSION_META.compatibility && VERSION_META.compatibility.adaptedVersions;
    if (Array.isArray(localList) && localList.length) return localList;
    return DEFAULT_ADAPTED_VERSIONS;
  }

  isAdaptedVersion(ver, meta = null) {
    const list = this.getAdaptedVersions(meta);
    return list.includes(ver);
  }

  getCurrentVersion() {
    if (this.lastKnownVersion) {
      return this.lastKnownVersion;
    }

    const paths = [
      path.join(LIVE_CORE_DIR, 'package.json'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
      '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
    ];
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
          if (v) {
            this.lastKnownVersion = v;
            return v;
          }
        }
      } catch {}
    }

    try {
      const res = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (res.status === 0 && res.stdout.trim()) {
        const v = res.stdout.trim();
        this.lastKnownVersion = v;
        return v;
      }
    } catch {}

    return this.lastKnownVersion || FALLBACK_DSH_VERSION;
  }

  async fetchAvailableVersions(force = false, meta = null) {
    let distTags = {};
    let versions = [];

    // По возможности используем нативный асинхронный fetch к registry — он никогда не блокирует главный цикл событий
    try {
      const regUrl = this.registry.replace(/\/+$/, '') + '/@deepseek-ai/dsh';
      const resp = await fetch(regUrl, { signal: AbortSignal.timeout(6000) });
      if (resp.ok) {
        const pkgData = await resp.json();
        distTags = pkgData['dist-tags'] || {};
        versions = Object.keys(pkgData.versions || {});
      }
    } catch (fetchErr) {
      // При сбое сети или зеркала registry переключаемся на неблокирующий асинхронный npm view
      const runNpmAsync = (args) => new Promise((resolve) => {
        const child = spawn('npm', [...args, '--cache=/tmp/.npm-cache'], {
          env: { ...process.env, NPM_CONFIG_REGISTRY: this.registry }
        });
        let out = '';
        child.stdout.on('data', d => out += d);
        child.on('close', (code) => {
          if (code === 0 && out.trim()) {
            try { resolve(JSON.parse(out.trim())); } catch { resolve(null); }
          } else {
            resolve(null);
          }
        });
        child.on('error', () => resolve(null));
      });
      distTags = (await runNpmAsync(['view', '@deepseek-ai/dsh', 'dist-tags', '--json'])) || {};
      versions = (await runNpmAsync(['view', '@deepseek-ai/dsh', 'versions', '--json'])) || [];
    }

    const current = this.getCurrentVersion();
    // По возможности выбираем настоящий последний официальный релиз (пререлизы alpha / next / latest и стабильные новые версии, либо максимальная semver из списка — как в build.sh)
    let latest = distTags.alpha || distTags.next || distTags.latest;
    if (Array.isArray(versions) && versions.length > 0) {
      const sorted = [...versions].sort(compareSemver);
      const newestInList = sorted[sorted.length - 1];
      if (!latest || (newestInList && compareSemver(newestInList, latest) > 0)) {
        latest = newestInList;
      }
    }
    if (!latest) latest = FALLBACK_DSH_VERSION;
    const isUpToDate = Boolean(current && latest && compareSemver(current, latest) >= 0);

    return {
      current,
      latest,
      isUpToDate,
      distTags,
      cachedVersions: this.getCachedVersions(),
      adaptedVersions: this.getAdaptedVersions(meta),
      versions: Array.isArray(versions) ? versions.reverse() : [],
      registry: this.registry
    };
  }

  setRegistry(reg) {
    if (reg && reg.startsWith('http')) {
      this.registry = reg.trim();
    }
    return this.registry;
  }

  // Внешняя точка входа: после постановки в очередь выполняется настоящая логика запуска
  boot(onProbe) {
    return this._enqueue(() => this._bootInternal(onProbe));
  }

  _bootInternal(onProbe) {
    // Исправление антипаттерна: исключение, выброшенное внутри `new Promise(async executor)`, становится необработанным rejection,
    // промис никогда не завершится (и очередь, поставленная в очередь, зависнет). Заменено на синхронный executor + асинхронную функцию реализации.
    return new Promise((resolve) => {
      // Внимание: нельзя использовать .then(resolve) и брать «возвращаемое значение» функции реализации — она асинхронная,
      // сама вызовет resolve при готовности/сбое, а её тело может вернуться раньше завершения вложенной цепочки then;
      // использование возвращаемого значения завершило бы промис раньше времени с undefined. Здесь через catch перехватываем исключения реализации.
      Promise.resolve()
        .then(() => this._bootInternalImpl(onProbe, resolve))
        .catch((err) => {
          console.error('[dsh-manager] Исключение в процессе запуска (resolve вызван в catch):', (err && err.message) || err);
          resolve({ ok: false, error: (err && err.message) || String(err) });
        });
    });
  }

  async _bootInternalImpl(onProbe, resolve) {
      this.manualStopped = false;
      // «Уже запущен» считается только если процесс действительно жив; иначе чистим зомби-ссылку, чтобы после ложного срабатывания запуск всё равно произошёл
      if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
        return resolve({ ok: true, alreadyRunning: true });
      }
      if (this.proc) {
        console.warn('[dsh-manager] Обнаружена ссылка на уже завершённый процесс (зомби), очищаем и продолжаем запуск');
        this.proc = null;
        this.ready = false;
      }
      this.stopping = false;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      // Перед запуском проверяем и при необходимости исправляем права на .credentials.yaml и .dsh (служба учётных данных DSH требует mode 600)
      try {
        const credPath = path.join(DSH_DIR, '.credentials.yaml');
        if (fs.existsSync(credPath)) {
          fs.chmodSync(credPath, 0o600);
        }
        if (fs.existsSync(DSH_DIR)) {
          fs.chmodSync(DSH_DIR, 0o700);
        }
      } catch (err) {
        console.warn('[dsh-manager] Не удалось проверить/исправить права на файл учётных данных:', err.message);
      }

      // Ключевая защита от конфликтов: освобождаем порт DSH_PORT от возможных осиротевших или внешних перезапущенных процессов
      await ensurePortReleased(DSH_PORT, 4000);
      await new Promise(r => setTimeout(r, 200));

      console.log(`[dsh-manager] Запуск процесса DSH (рабочее пространство: ${DSH_WORKSPACE}, порт: ${DSH_PORT})...`);
      this.ready = false;

      const logStream = fs.createWriteStream(DSH_WEB_LOG, { flags: 'a' });
      // Ошибка записи журнала на диск (диск заполнен/нет прав) не должна ронять процесс шлюза
      logStream.on('error', (e) => console.warn('[dsh-manager] Не удалось записать журнал DSH (проигнорировано):', e.message));
      const env = {
        ...process.env,
        DSH_PORT: String(DSH_PORT),
        PROXY_PORT: String(process.env.PROXY_PORT || 3080),
        NPM_CONFIG_REGISTRY: this.registry,
        NPM_REGISTRY: this.registry,
        PNPM_REGISTRY: this.registry,
        // Семантика DSH: «$DSH_HOME сам по себе является harness home» (профили лежат в $DSH_HOME/profiles/<name>,
        // см. resolveDshHome в @deepseek-ai/dsh-home-paths), тогда как остальной код проекта всюду считает harness home
        // равным $DSH_HOME/.dsh (т.е. DSH_DIR). Если передать дочернему процессу контейнерный DSH_HOME (по умолчанию /root),
        // DSH будет читать /root/profiles/web (там только два официальных бандла: dsh-base + dsh-web-app),
        // и предустановленные/кастомные плагины, установленные в /root/.dsh/profiles/web (маркет dshmarket, браузерный десктоп,
        // интенсивность размышлений и т.д.), никогда не будут загружены. Здесь явно сужаем DSH_HOME дочернего процесса до DSH_DIR, в соответствии со всем проектом.
        DSH_HOME: DSH_DIR
      };
      // Полностью убираем NODE_ENV=production, возвращая чистую среду разработки, чтобы установка в рабочем пространстве не пропускала devDependencies
      delete env.NODE_ENV;

      const p = spawn('dsh', ['web', '--port', String(DSH_PORT), '--no-open'], {
        cwd: DSH_WORKSPACE,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.proc = p;

      // Редактирование журнала: при запуске DSH печатает токен доступа в открытом виде в stdout (`dsh web: ...?token=xxx`);
      // перед записью на диск / пересылкой / попаданием в панель просмотра истории Admin он вычищается, чтобы открытые учётные данные не накапливались в журналах.
      const redactLog = (d) => String(Buffer.isBuffer(d) ? d.toString('utf8') : d)
        .replace(/([?&]token=)[A-Za-z0-9._~-]+/gi, '$1<redacted>');

      p.stdout.on('data', d => {
        const safe = redactLog(d);
        logStream.write(safe);
        process.stdout.write(safe);

        // Собираем последние журналы для разбора причины аварии (тоже с редактированием, чтобы токен не попал в панель истории Admin)
        const str = d.toString('utf8');
        const lines = str.split('\n').filter(Boolean);
        for (const l of lines) {
          this.recentLogs.push(redactLog(l));
          if (this.recentLogs.length > 80) this.recentLogs.shift();
        }

        // Динамически подхватываем из stdout-канала токен запуска — без задержки получаем официально подписанный Cookie
        const m = str.match(/token=([A-Za-z0-9._~-]{16,})/i);
        if (m) {
          const token = m[1].trim();
          if (token !== this.launchToken) {
            this.launchToken = token;
            this.exchangeSessionCookie(token).catch(() => {});
          }
        }
      });
      p.stderr.on('data', d => {
        const safe = redactLog(d);
        logStream.write(safe);
        process.stderr.write(safe);

        const str = d.toString('utf8');
        const lines = str.split('\n').filter(Boolean);
        for (const l of lines) {
          this.recentLogs.push(redactLog(l));
          if (this.recentLogs.length > 80) this.recentLogs.shift();
        }
      });

      p.on('error', err => {
        console.error('[dsh-manager] Ошибка запуска DSH:', err.message);
        this.proc = null;
        this.ready = false;
        this.lastExitInfo = { code: -1, sig: err.message, time: Date.now(), logs: this.recentLogs.slice(-20) };
        resolve({ ok: false, error: err.message });
      });

      p.on('exit', (code, sig) => {
        console.log(`[dsh-manager] DSH завершился (code=${code}, sig=${sig})`);
        if (code !== 0 && code !== null) {
          this.lastExitInfo = { code, sig, time: Date.now(), logs: this.recentLogs.slice(-20) };
        }
        // Сначала запоминаем «был ли готов до выхода»: ниже ready выставляется в false,
        // и если судить напрямую по this.ready, ветки перезапуска после аварии/аварийной защиты стали бы недостижимы (скрытый баг старой реализации).
        const wasReady = this.ready;
        if (this.proc === p) {
          this.proc = null;
          this.ready = false;
        }
        // Если выполняется ручная остановка, автоподъём не выполняется
        if (this.manualStopped) {
          console.log('[dsh-manager] DSH находится в состоянии ручной остановки, служба надзора приостановила автоматический перезапуск');
          return;
        }
        // Если аномальный выход произошёл ещё во время стартовой проверки готовности, диагностика сбоев, автоизоляция плагинов и очищающий перезапуск выполняются ниже централизованно через waitReady;
        // здесь выполняется только надзорный перезапуск с экспоненциальной задержкой для случая, когда DSH уже был готов, но неожиданно упал позже, — чтобы исключить двойной подъём и гонки
        if (!wasReady) {
          return;
        }
        // Если stop() не вызывался вручную, выполняется автонадзорный подъём (с защитой от аварий по «скользящему окну»)
        // Ключево: нельзя обнулять счётчик после первого успешного готова — самый типичный вид сбойного плагина: «готов — и сразу падает»,
        // тогда счётчик каждый раз возвращался к 1, а откат и аварийная защита никогда не срабатывали, превращая всё в неограниченный шторм перезапусков.
        if (!this.stopping && !this.installing) {
          const now = Date.now();
          const CRASH_WINDOW_MS = 120000; // скользящее окно 2 минуты
          const MAX_CRASHES = 5;

          // DSH стабильно работал дольше одного окна → считаем здоровой историей и обнуляем окно
          if (this.startTime && now - this.startTime > CRASH_WINDOW_MS) {
            this.crashWindow = [];
          }
          this.crashWindow = (this.crashWindow || []).filter(t => now - t < CRASH_WINDOW_MS);
          this.crashWindow.push(now);
          this.lastCrashTime = now;
          const crashes = this.crashWindow.length;

          if (crashes > MAX_CRASHES) {
            console.error(`[dsh-manager] Предупреждение: DSH упал ${crashes} раз(а) за ${CRASH_WINDOW_MS / 1000} с (>${MAX_CRASHES}), автоподъём приостановлен для защиты системы. Проверьте конфигурацию в панели администрирования или восстановите снимок.`);
            return;
          }

          const delay = Math.min(1000 * Math.pow(1.5, crashes - 1), 10000);
          console.log(`[dsh-manager] Процесс DSH завершился, служба надзора автоматически перезапустит DSH через ${(delay / 1000).toFixed(1)} с (попытка ${crashes} в окне)...`);
          clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            if (!this.stopping && !this.installing && !this.proc) {
              this.boot().catch(err => console.error('[dsh-manager] Не удалось автоматически перезапустить DSH:', err.message));
            }
          }, delay);
        }
      });

      // Ждём настоящей готовности (защищаемся от ложной готовности извне)
      // Внимание: снаружи это new Promise(async executor), любое исключение в колбэке не даёт промису завершиться
      // (настоящий источник дедлока в старой реализации — он вместе подвешивал и очередь). Здесь явные try/catch + перехват в catch.
      this.waitReady(60000, onProbe).then(async ok => {
       try {
        this.ready = ok;
        console.log(ok ? '[dsh-manager] DSH готов' : '[dsh-manager] DSH не уложился в таймаут запуска или упал');
        if (ok) {
          this.autoHealCountInCurrentBoot = 0;
          this.startTime = Date.now();
          if (this.launchToken) {
            await this.exchangeSessionCookie(this.launchToken);
          }
          return resolve({ ok: true });
        }

        // ==========================================================
        // [Самовосстановление при сбое запуска и автоизоляция сбойных плагинов]
        // Ограничения: 1. Функция самовосстановления включена (autoHealEnabled)
        //              2. За один цикл запуска количество изоляций не превысило лимит (лимит: 3)
        //              3. Нет ручной остановки или установки с обновлением
        // ==========================================================
        if (this.autoHealEnabled && !this.stopping && !this.installing) {
          if (this.autoHealCountInCurrentBoot < this.maxAutoHealPerBoot) {
            const detected = this.detectCrashingPlugin(this.recentLogs);
            if (detected) {
              this.autoHealCountInCurrentBoot++;
              console.warn(`[dsh-manager] 🛡️ [Сработало самовосстановление сбоя запуска (${this.autoHealCountInCurrentBoot}/${this.maxAutoHealPerBoot})] Обнаружено расширение «${detected.name}», вызывающее сбой запуска DSH (${detected.matched})!`);
              console.log(`[dsh-manager] Автоматически изолируем и отключаем расширение «${detected.name}», чтобы вернуть работоспособность системы...`);

              try {
                const pm = require('./plugin-manager');
                // P6: togglePlugin теперь выполняет «прочитать-изменить-записать» внутри блокировки записи профиля, поэтому нужен await
                await pm.togglePlugin(detected.name, false);

                const event = {
                  id: 'heal-' + Date.now(),
                  plugin: detected.name,
                  reason: detected.matched,
                  time: Date.now(),
                  logSnippet: this.recentLogs.slice(-20).join('\n')
                };
                this.autoIsolatedEvents.unshift(event);
                if (this.autoIsolatedEvents.length > 10) this.autoIsolatedEvents.pop();

                console.log(`[dsh-manager] Расширение «${detected.name}» автоматически отключено и состояние зафиксировано, немедленно перезапускаем ядро DSH...`);
                await ensurePortReleased(DSH_PORT, 3000);
                const healBootRes = await this._bootInternal(onProbe);
                return resolve(healBootRes);
              } catch (healErr) {
                console.error('[dsh-manager] Не удалось выполнить автоизоляцию плагина:', healErr.message);
              }
            } else {
              console.log('[dsh-manager] В последних журналах работы не удалось выявить явное стороннее сбойное расширение — автоизоляция пропущена');
            }
          } else {
            console.warn(`[dsh-manager] ⚠️ За текущий цикл запуска достигнут лимит автоизоляции расширений (${this.maxAutoHealPerBoot}), автоизоляция остановлена во избежание дедлока`);
          }
        }

        resolve({ ok: false });
       } catch (e) {
        console.error('[dsh-manager] Исключение при обработке готовности после запуска (resolve вызван в catch):', (e && e.message) || e);
        resolve({ ok: false, error: (e && e.message) || String(e) });
       }
      }).catch(err => {
        console.error('[dsh-manager] Исключение в waitReady (resolve вызван в catch):', (err && err.message) || err);
        resolve({ ok: false, error: (err && err.message) || String(err) });
      });
  }

  // Внешняя точка входа: после постановки в очередь выполняется настоящая логика остановки
  stop() {
    return this._enqueue(() => this._stopInternal());
  }

  _stopInternal() {
    return new Promise(resolve => {
      this.stopping = true;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.crashWindow = [];

      const p = this.proc;
      this.proc = null;
      this.ready = false;

      // Независимо от того, есть ли this.proc, принудительно освобождаем порт 3079 и все осиротевшие процессы node dsh
      killPortProcess(DSH_PORT);

      if (!p) {
        this.stopping = false;
        return resolve({ ok: true });
      }

      console.log('[dsh-manager] Остановка процесса DSH...');
      let settled = false;
      const done = (extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        this.stopping = false;
        resolve({ ok: true, ...extra });
      };

      const timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch {}
        killPortProcess(DSH_PORT);
      }, 4000);

      // Подстраховка: в крайнем случае, если процесс не удаётся убить или событие exit потеряно, всё равно нужно вернуть результат, чтобы вызывающий код (включая очередь) не завис навсегда
      const hardTimer = setTimeout(() => {
        console.warn('[dsh-manager] Таймаут остановки DSH (9 с), принудительный возврат результата');
        done({ forced: true });
      }, 9000);

      p.once('exit', async () => {
        try { await ensurePortReleased(DSH_PORT, 2500); } catch {}
        done();
      });

      try {
        p.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  // Перезапуск = остановка, а затем запуск в рамках одной задачи очереди, чтобы между ними не вклинились другие операции
  async restart(onProbe) {
    return this._enqueue(async () => {
      await this._stopInternal();
      return this._bootInternal(onProbe);
    });
  }

  async exchangeSessionCookie(token = this.launchToken) {
    if (!token) return '';
    const targetUrl = `http://127.0.0.1:${DSH_PORT}/?token=${encodeURIComponent(token)}`;
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: { 'Host': `127.0.0.1:${DSH_PORT}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      });

      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const cookieHeader = res.headers.get('set-cookie') || '';
      const allCookies = setCookies.length > 0 ? setCookies : (cookieHeader ? [cookieHeader] : []);

      for (const sc of allCookies) {
        if (sc && sc.includes('dsh-auth-')) {
          const cookiePair = sc.split(';')[0].trim();
          this.upstreamCookie = cookiePair;
          return cookiePair;
        }
      }
    } catch (err) {
      console.warn('[dsh-manager] Не удалось получить сессионный Cookie:', err.message);
    }
    return this.upstreamCookie;
  }

  async ensureValidUpstreamCookie() {
    if (this.upstreamCookie) return this.upstreamCookie;
    return this.exchangeSessionCookie();
  }

  async waitReady(timeoutMs = 60000, onProbeProgress) {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
      // Если дочерний процесс уже завершился или упал, однозначно считаем систему неготовой — защищаемся от ложной готовности извне
      if (!this.proc || this.proc.exitCode !== null || this.proc.killed) {
        return false;
      }
      try {
        // Обязательно с таймаутом: если порт занят процессом, который «принимает соединение, но не отвечает», fetch без таймаута навечно подвесил бы весь цикл проверки готовности
        const res = await fetch(`http://127.0.0.1:${DSH_PORT}/`, { signal: AbortSignal.timeout(3000) });
        if (res.status < 500 && this.proc && this.proc.exitCode === null) {
          return true;
        }
      } catch {}
      const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
      if (typeof onProbeProgress === 'function') {
        try { onProbeProgress({ attempts, elapsedSec }); } catch {}
      }
      await new Promise(r => setTimeout(r, 800));
    }
    return false;
  }

  /** Допустим ли номер версии (единая проверка переиспользуется на входе в Admin API) */
  isValidVersion(value) {
    return isValidVersion(value);
  }

  async installVersion(version, onProgress, onLog, options = {}) {
    // Жёсткая проверка на входе: номер версии должен быть корректным semver — защищаемся от обхода каталогов через `../` и внедрения npm-спецификаторов
    const normalizedVersion = typeof version === 'string' ? version.trim() : '';
    if (!isValidVersion(normalizedVersion)) {
      return { ok: false, error: `Некорректный формат номера версии: ${String(version).slice(0, 64)}` };
    }
    version = normalizedVersion;

    if (this.installing) return { ok: false, error: 'Уже выполняется другая задача установки' };
    this.installing = true;
    this.installLog = [];

    // Совместимость со случаем, когда передан только один колбэк (line => ...)
    if (typeof onProgress === 'function' && typeof onLog !== 'function') {
      onLog = onProgress;
      onProgress = null;
    }

    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      this.installLog.push(line);
      if (typeof onLog === 'function') onLog(line);
      console.log(`[dsh-installer] ${msg}`);
    };

    const emitProgress = (data) => {
      if (typeof onProgress === 'function') {
        try { onProgress(data); } catch {}
      }
    };

    const previousVersion = this.getCurrentVersion() || '0.1.2-rc.1';
    // Архивировать ли текущую версию движка: решается флажком в диалоге перед переключением (по умолчанию включён, пользователь может снять).
    // Архивация — чисто пользовательская функция: аварийный откат использует «точку отката, сохранённую на время переключения», и от неё не зависит.
    const archiveCurrent = options && options.archiveCurrent === true;
    let stagingDir = null; // каталог контейнерного слоя, ожидающий активации (при сбое нужно убрать, чтобы не осталось мусора)
    let tmpPrefix = null; // временный префикс npm (объявляется вне try, иначе catch его не увидит)
    let rollbackDir = null; // точка отката со старым ядром, сохранённая на время подмены (убирается только после успешной проверки активности)
    let coreMutated = false; // начали ли мы менять работающее ядро (если нет — при сбое аварийный откат не нужен)

    try {
      // === Этап 1/5: предварительная проверка переключения и окружения ===
      emitProgress({ step: 1, total: 5, percent: 10, label: 'Предварительная проверка окружения и оценка совместимости версий', mode: 'install' });
      log(`======================================================================`);
      log(`=== [Этап 1/5] Предварительная проверка переключения: текущая версия ${previousVersion} -> целевая версия ${version} ===`);
      if (version === previousVersion) {
        log(`ℹ️ Целевая версия совпадает с текущей (${version}) — будет выполнена пересборка окружения и проверка готовности.`);
      }

      // Проверка функциональной совместимости версий и совместимости данных
      const isAdapted = this.isAdaptedVersion(version);
      if (!isAdapted) {
        log('⚠️ [Предупреждение о совместимости] Целевая версия не проходила глубокие адаптационные тесты для этого Docker-образа!');
        log('💡 [Рекомендация по обновлению образа] Для последнего официального релиза настоятельно рекомендуется напрямую обновить Docker-образ (docker compose pull && docker compose up -d), чтобы получить свежую адресную адаптацию!');
        log('⚠️ Если после онлайн-переключения возникнут сбои запуска, отказы плагинов или проблемы интерфейса — обновите Docker-образ или напишите в GitHub Issues.');
      } else {
        log(`✔ Целевая версия ${version} входит в число официально глубоко адаптированных версий этого образа и прошла адресные интеграционные тесты.`);
      }

      if (compareSemver(version, '0.1.5-rc.1') < 0 && compareSemver(previousVersion, '0.1.5-rc.1') >= 0) {
        log('⚠️ [Предупреждение о версии] Вы выполняете даунгрейд со серии 0.1.5+ на более старую версию!');
        log('⚠️ По официальной документации: начиная с 0.1.5 формат данных сессий обновлён до V3 и необратим; после даунгрейда старые версии DSH не смогут загрузить записи сессий V3.');
        log('⚠️ Настоятельно рекомендуется перед даунгрейдом убедиться, что созданы резервные копии конфигурации и снимков сессий.');
      } else if (compareSemver(version, '0.1.5-rc.1') >= 0 && compareSemver(previousVersion, '0.1.5-rc.1') < 0) {
        log('ℹ️ [Подсказка об обновлении] Готовимся к обновлению до серии 0.1.5+: будут включены DeepSeek-V41-Flash, новый правый Sidebar-превью, наследование исходящего прокси и формат сессий V3.');
      }
      log(`✔ Предварительная проверка пройдена: окружение готово, источник пакетов: ${this.registry}`);

      // Предварительная проверка уровня занятости диска (входной шлюз): и архивация старой версии, и загрузка новой пишут в том хранилища версий,
      // раннее прерывание позволяет избежать бесполезной загрузки 540 МБ при почти заполненном диске.
      this._assertDiskSpace([this.versionsCacheDir, LIVE_CORE_PARENT], MIN_FREE_BYTES, log);

      // === Этап 2/5: (по желанию) архивация текущего движка в персистентное хранилище версий ===
      emitProgress({ step: 2, total: 5, percent: 25, label: archiveCurrent ? 'Резервное копирование текущей версии движка' : 'Пропуск резервного копирования движка', mode: 'install' });
      log(`=== [Этап 2/5] Архивация текущей версии движка (${archiveCurrent ? 'отмечено пользователем' : 'не отмечено → пропуск'}) ===`);
      log(`📦 Хранилище версий: ${this.versionsCacheDir}${isMountedPath(this.versionsCacheDir) ? ' (персистентный том ✔, сохраняется при пересоздании контейнера/обновлении образа)' : ' (⚠️ вне точки монтирования: архивы потеряются при пересоздании контейнера)'}`);
      if (!archiveCurrent) {
        log(`ℹ️ Архивация текущего движка не отмечена → пропуск. При сбое переключения всё равно произойдёт мгновенный автоматический откат (через точку отката, сохранённую на время переключения — без зависимости от архива и сети).`);
      } else if (!isValidVersion(previousVersion)) {
        log(`⚠️ Пропуск архивации: текущий номер версии некорректен (${previousVersion}), не записываем грязный каталог в хранилище версий`);
      } else {
        const prevArchive = resolveWithinDir(this.versionsCacheDir, previousVersion);
        if (isReadyVersionDir(prevArchive)) {
          this._touchVersionUsage(previousVersion);
          log(`✔ Полный архив ${previousVersion} уже есть в хранилище версий, повторная архивация не нужна`);
        } else {
          if (fs.existsSync(prevArchive)) {
            log(`⚠️ Обнаружен неполный старый архив ${previousVersion}, удаляем и создаём заново (чтобы повреждённая версия не была ошибочно принята за рабочую)`);
            fs.rmSync(prevArchive, { recursive: true, force: true });
          }
          if (fs.existsSync(path.join(LIVE_CORE_DIR, 'package.json'))) {
            log(`Архивируем текущий движок ${previousVersion} в персистентное хранилище версий...`);
            const archTmp = path.join(STORE_STAGING_DIR, `archive-${process.pid}-${Date.now()}`);
            try {
              fs.mkdirSync(archTmp, { recursive: true });
              runSyncSafe('cp', ['-a', LIVE_CORE_DIR + '/.', archTmp + '/']);
              writeReadyMarker(archTmp, previousVersion);
              fs.renameSync(archTmp, prevArchive);
              log(`✔ ${previousVersion} заархивирован (${formatBytes(dirSizeBytes(prevArchive))}), при возврате на эту версию загрузка не понадобится`);
            } catch (e) {
              try { fs.rmSync(archTmp, { recursive: true, force: true }); } catch {}
              log(`⚠️ Не удалось заархивировать (на переключение не влияет): ${e.message}`);
            }
          } else {
            log(`ℹ️ Активное ядро не найдено, архивация пропущена`);
          }
        }
      }

      // === Этап 3/5: развёртывание целевой версии ядра (сначала в staging, затем атомарная подмена; никогда не «удалить, а потом скопировать») ===
      emitProgress({ step: 3, total: 5, percent: 40, label: 'Получение пакета ядра целевой версии', mode: 'install' });
      log(`=== [Этап 3/5] Развёртывание целевой версии ядра @deepseek-ai/dsh@${version} ===`);
      const targetArchive = resolveWithinDir(this.versionsCacheDir, version);
      let sourceDir = null;
      if (isReadyVersionDir(targetArchive)) {
        sourceDir = targetArchive;
        this._touchVersionUsage(version);
        log(`⚡ [Без загрузки] Найден ${version} в персистентном хранилище версий, разворачиваем напрямую из локального архива (без сети)`);
      } else {
        if (fs.existsSync(targetArchive)) {
          log(`⚠️ Архив ${version} в хранилище версий неполон, пропускаем его и качаем заново`);
          fs.rmSync(targetArchive, { recursive: true, force: true });
        }
        log(`Загружаем и устанавливаем @deepseek-ai/dsh@${version} из npm-зеркала (источник: ${this.registry})...`);
        const tmpPrefixPath = path.join(STORE_STAGING_DIR, `npm-${process.pid}-${Date.now()}`);
        tmpPrefix = tmpPrefixPath;
        fs.mkdirSync(tmpPrefixPath, { recursive: true });
        const installArgs = [
          'install', '-g', '--prefix', tmpPrefixPath, '--omit=dev', '--no-audit', '--no-fund',
          `--registry=${this.registry}`,
          `@deepseek-ai/dsh@${version}`
        ];
        log(`> npm ${installArgs.join(' ')}`);

        const startTime = Date.now();
        const child = spawn('npm', installArgs, { env: process.env });

        // Динамический таймер «сердцебиения», чтобы консоль не выглядела зависшей во время загрузки npm
        const heartbeat = setInterval(() => {
          const sec = Math.floor((Date.now() - startTime) / 1000);
          const dynamicPercent = Math.min(59, 40 + Math.floor(sec * 1.2));
          log(`⏳ [Зависимости npm качаются] Скачиваем и распаковываем пакеты зависимостей ядра, прошло ${sec} с...`);
          emitProgress({
            step: 3,
            total: 5,
            percent: dynamicPercent,
            label: `Загрузка пакетов зависимостей ядра (прошло ${sec} с)...`,
            mode: 'install'
          });
        }, 2000);

        child.stdout.on('data', d => {
          d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(l));
        });
        child.stderr.on('data', d => {
          d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(l));
        });

        const exitCode = await new Promise(r => child.on('close', r));
        clearInterval(heartbeat);

        if (exitCode !== 0) {
          try { fs.rmSync(tmpPrefix, { recursive: true, force: true }); } catch {}
          throw new Error(`Сбой установки npm install, код выхода: ${exitCode}`);
        }
        const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`✔ npm скачал и распаковал, общее время ${totalSec} с`);
        // При сборке образа node-pty пересобирается нативно (Dockerfile); при онлайн-загрузке это тоже доделываем, чтобы в терминале не хватало нативного модуля
        try {
          const rb = spawnSync('npm', ['rebuild', 'node-pty', '--foreground-scripts', '--prefix', tmpPrefixPath], { encoding: 'utf8', timeout: 180000 });
          if (rb.status !== 0) log(`⚠️ Нативная пересборка node-pty не удалась (переключение не блокируется): ${String(rb.stderr || '').trim().slice(0, 200)}`);
          else log(`✔ Нативный модуль node-pty готов`);
        } catch (e) {
          log(`⚠️ Ошибка нативной пересборки node-pty (переключение не блокируется): ${e.message}`);
        }
        sourceDir = path.join(tmpPrefixPath, 'lib/node_modules/@deepseek-ai/dsh');
        if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
          throw new Error('npm install завершился, но артефакт @deepseek-ai/dsh не найден');
        }
        // Внимание: теперь нет схемы «скачал — и сразу заархивировал» — архивация выполняется только по явному выбору пользователя (см. этап 2),
        // система не занимает диск в фоновом режиме молча.
        emitProgress({ step: 3, total: 5, percent: 60, label: 'Загрузка и установка целевой версии завершены', mode: 'install' });
      }

      // Предварительная проверка места на диске: и том хранилища версий, и контейнерный слой должны иметь достаточно места, иначе — чистое прерывание
      this._assertDiskSpace([this.versionsCacheDir, LIVE_CORE_PARENT], MIN_FREE_BYTES, log);

      // Строим изолированный staging (на той же файловой системе, что активное ядро → приоритет у rename; на lower-слое overlayfs происходит деградация до копирования)
      const stagingPath = path.join(LIVE_CORE_PARENT, `.dsh-staging-${process.pid}-${Date.now()}`);
      stagingDir = stagingPath;
      fs.mkdirSync(stagingPath, { recursive: true });
      runSyncSafe('cp', ['-a', sourceDir + '/.', stagingPath + '/']);
      const stagedPkg = JSON.parse(fs.readFileSync(path.join(stagingPath, 'package.json'), 'utf8'));
      if (stagedPkg.version !== version) {
        throw new Error(`Ошибка проверки версии в staging: ожидалась ${version}, получена ${stagedPkg.version}`);
      }
      log(`✔ Целевая версия ${version} готова в изолированном staging-каталоге (работающий сервис на всём протяжении не затрагивался)`);
      // staging готов, временный префикс npm больше не нужен (иначе на персистентном томе останется ~540 МБ мусора)
      if (tmpPrefix) { try { fs.rmSync(tmpPrefix, { recursive: true, force: true }); } catch {} tmpPrefix = null; }

      // Атомарная подмена: сначала останавливаем процесс (чтобы старый процесс лениво не подтянул require из нового дерева), затем rename
      log(`Останавливаем процесс DSH для атомарной подмены каталога ядра...`);
      coreMutated = true;
      await this.stop();
      rollbackDir = this._atomicSwapCore(stagingPath);
      stagingDir = null;
      log(`✔ Атомарная подмена каталога ядра выполнена (staging → live, без окна «сначала удалить, потом скопировать»)`);

      // === Этап 4/5: сборка плагинов и самовосстановление патчей хоста ===
      emitProgress({ step: 4, total: 5, percent: 70, label: 'Сборка плагинов и самовосстановление патчей', mode: 'install' });
      log(`=== [Этап 4/5] Сборка окружения плагинов и внедрение клиентских патчей ===`);
      if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
        log(`> Синхронизируем и связываем зависимости плагинов с новым ядром (schemastery и dsh-browser-desktop)...`);
        const res = spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }
      if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
        log(`> Внедряем персистентный патч клиентского loopback-хоста...`);
        const res = spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }
      log(`✔ Самовосстановление и адаптация плагинов и патчей хоста завершены`);
      emitProgress({ step: 4, total: 5, percent: 80, label: 'Адаптация плагинов и патчей готова', mode: 'install' });

      // === Этап 5/5: подъём нового ядра и проверка готовности ===
      emitProgress({ step: 5, total: 5, percent: 85, label: 'Подъём нового сервиса и проверка готовности', mode: 'install' });
      log(`=== [Этап 5/5] Поднимаем новую версию DSH (${version}) и выполняем проверку готовности ===`);
      this.lastExitInfo = null;
      this.recentLogs = [];

      const bootRes = await this.restart((probe) => {
        const dynamicPercent = Math.min(97, 85 + Math.floor(probe.attempts * 0.8));
        log(`🔍 [Проверка готовности] Опрашиваем порт ${DSH_PORT} на отклик о готовности (попытка ${probe.attempts}, ждём ${probe.elapsedSec} с)...`);
        emitProgress({
          step: 5,
          total: 5,
          percent: dynamicPercent,
          label: `Проверка готовности порта (${probe.attempts}/30)...`,
          mode: 'install'
        });
      });

      if (!bootRes.ok) {
        let failDetail = `Новая версия ${version} не прошла проверку готовности порта после запуска`;
        if (this.lastExitInfo) {
          failDetail = `Процесс новой версии аварийно завершился при запуске (Exit Code: ${this.lastExitInfo.code}, Signal: ${this.lastExitInfo.sig || 'none'})`;
        }
        throw new Error(failDetail);
      }

      const currentVer = this.getCurrentVersion();
      // Проверка готовности пройдена: переключение успешно, снятое ядро продвигаем в защищённый слот (автоочистке не подлежит, хранится одна копия в единственном слоте)
      if (rollbackDir && fs.existsSync(rollbackDir)) {
        try {
          this._promoteToPreservedRollback(rollbackDir, previousVersion);
          log(`✔ Прежнее ядро сохранено как точка отката на месте; для освобождения места очистите её вручную на панели «Снимки и резервные копии»`);
        } catch (promoteErr) {
          log(`⚠️ Продвижение точки отката в защищённый слот пропущено (не критично): ${promoteErr.message}`);
        }
        rollbackDir = null;
      }
      // Основной процесс переключения завершён: снимаем межоперационную блокировку установки, чтобы фоновая GC и запросы статуса могли работать
      this.installing = false;
      this.lastKnownVersion = '';

      // Внимание: новая версия больше не архивируется автоматически — архивация выполняется по явному выбору пользователя перед переключением (этап 2).
      // Управление местом в хранилище версий: хранение по LRU (по умолчанию 3 копии); активная версия и базовая версия образа никогда не чистятся
      try {
        const gc = this.gcVersions({ keepN: GC_KEEP_DEFAULT, activeVersion: currentVer });
        if (gc && gc.ok && Array.isArray(gc.removed) && gc.removed.length) {
          log(`🧹 GC хранилища версий: удалено старых версий: ${gc.removed.length}, освобождено ${formatBytes(gc.freedBytes)}`);
        }
      } catch (e) {
        log(`⚠️ GC хранилища версий пропущен: ${e.message}`);
      }

      emitProgress({
        step: 5,
        total: 5,
        percent: 100,
        label: `Переключение завершено! Ядро успешно обновлено до v${currentVer}`,
        mode: 'install'
      });

      log(`======================================================================`);
      log(`🎉 [SUCCESS] Переключение версии ядра DSH успешно завершено!`);
      log(`🚀 Текущая работающая версия: v${currentVer} (сервис здоров и готов)`);
      log(`🌐 Адрес рабочего пространства: http://127.0.0.1:${DSH_PORT}`);
      log(`======================================================================`);

      return { ok: true, version: currentVer };

    } catch (err) {
      // Убираем неактивированные остатки staging (активное ядро не трогаем ни в коем случае)
      if (stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {} stagingDir = null; }
      if (tmpPrefix) { try { fs.rmSync(tmpPrefix, { recursive: true, force: true }); } catch {} tmpPrefix = null; }
      log(`======================================================================`);
      log(`❌ Не удалось установить или запустить новую версию: ${err.message}`);
      // Выводим анализ причины сбоя
      log(`----------------- 🔍 [Разбор причины сбоя новой версии] -----------------`);
      if (this.lastExitInfo) {
        log(`Статус завершения процесса: Code=${this.lastExitInfo.code}, Sig=${this.lastExitInfo.sig || 'none'}`);
        if (this.lastExitInfo.logs && this.lastExitInfo.logs.length > 0) {
          log(`Последние фрагменты вывода процесса:`);
          this.lastExitInfo.logs.slice(-8).forEach(l => log(`  | ${l}`));
        }
      } else {
        log(`Вероятная причина: процесс не начал слушать порт ${DSH_PORT} за 60 с, либо порт не отдаёт корректный HTTP-ответ`);
      }
      log(`-----------------------------------------------------------`);
      if (!coreMutated) {
        // Работающее ядро ещё не тронуто (сбой на этапе предпроверки/загрузки/проверки): остановка и откат не нужны, сервис продолжает работать
        log(`ℹ️ Работающее ядро не изменено, аварийный откат не требуется; сервис продолжает работать на версии v${previousVersion}`);
        this.installing = false;
        this.lastKnownVersion = '';
        return { ok: false, error: `Переключение прервано (работающий сервис не затронут): ${err.message}`, untouched: true, version: previousVersion };
      }
      // При сбое в фазе подмены могла уже появиться точка отката (см. err.rollbackDir в _atomicSwapCore) — подхватываем её для подстраховочного восстановления
      if (!rollbackDir && err && err.rollbackDir && fs.existsSync(err.rollbackDir)) {
        rollbackDir = err.rollbackDir;
        log(`ℹ️ Обнаружена точка отката, оставшаяся от фазы подмены, — восстанавливаемся в первую очередь из неё`);
      }
      log(`⚠️ Срабатывает защита аварийного отката: мгновенно откатываемся на стабильную версию v${previousVersion}...`);
      log(`======================================================================`);

      emitProgress({
        step: 1,
        total: 3,
        percent: 30,
        label: `🛡️ Срабатывает аварийный откат: мгновенно восстанавливаем стабильную версию v${previousVersion}...`,
        mode: 'rollback'
      });

      try {
        if (rollbackDir && fs.existsSync(rollbackDir)) {
          // Первый вариант: точка отката со старым ядром, сохранённая на время переключения — мгновенное локальное восстановление, без сети и без зависимости от архива
          log(`[Откат 1/3] ⚡ Мгновенно восстанавливаем стабильное ядро ${previousVersion} из точки отката, сохранённой на время переключения (без архива/сети)...`);
          await this.stop();
          this._restoreFromRollbackDir(rollbackDir);
          rollbackDir = null;
          log(`✔ Стабильное ядро мгновенно восстановлено из точки отката`);
        } else {
          const prevCached = resolveWithinDir(this.versionsCacheDir, previousVersion);
          if (isReadyVersionDir(prevCached)) {
            log(`[Откат 1/3] ⚡ Восстанавливаем стабильное ядро ${previousVersion} из персистентного хранилища версий без загрузки...`);
            await this.stop();
            const rbStaging = path.join(LIVE_CORE_PARENT, `.dsh-staging-rb-${process.pid}-${Date.now()}`);
            fs.mkdirSync(rbStaging, { recursive: true });
            try {
              runSyncSafe('cp', ['-a', prevCached + '/.', rbStaging + '/']);
              this._disposeRollbackDir(this._atomicSwapCore(rbStaging)); // снятое сбойное ядро отбрасываем немедленно
            } catch (rbSwapErr) {
              try { fs.rmSync(rbStaging, { recursive: true, force: true }); } catch {}
              throw rbSwapErr;
            }
            log(`✔ Файлы стабильного ядра восстановлены без загрузки`);
          } else {
            log(`[Откат 1/3] В хранилище версий нет полного архива, качаем стабильную версию ${previousVersion} заново из npm...`);
            const rbArgs = [
              'install', '-g', '--omit=dev', '--no-audit', '--no-fund',
              `--registry=${this.registry}`,
              `@deepseek-ai/dsh@${previousVersion}`
            ];
            const rbChild = spawn('npm', rbArgs, { env: process.env });
            rbChild.stdout.on('data', d => d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(`[Откат] ${l}`)));
            rbChild.stderr.on('data', d => d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(`[Откат] ${l}`)));
            const rbExit = await new Promise(r => rbChild.on('close', r));
            if (rbExit !== 0) throw new Error(`Сбой установки npm при откате, код выхода: ${rbExit}`);
            try { runSyncSafe('ln', ['-sfn', path.join(LIVE_CORE_DIR, 'lib/bin.js'), DSH_BIN_LINK]); } catch {}
          }
        }

        emitProgress({
          step: 2,
          total: 3,
          percent: 65,
          label: `🛡️ Аварийный откат [2/3]: восстановление конфигурации плагинов и патчей стабильной версии`,
          mode: 'rollback'
        });
        log('[Откат 2/3] Повторно выполняем настройку плагинов и самовосстановление зависимостей...');
        if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
          spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
        }
        if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
          spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
        }
        log(`✔ Конфигурация плагинов и патчей возвращена в исходное состояние`);

        emitProgress({
          step: 3,
          total: 3,
          percent: 85,
          label: `🛡️ Аварийный откат [3/3]: перезапуск стабильного ядра и проверка готовности...`,
          mode: 'rollback'
        });
        log(`[Откат 3/3] Снова поднимаем стабильную версию ${previousVersion}...`);
        const rbBoot = await this.restart((probe) => {
          log(`🔍 [Проверка готовности после отката] Опрашиваем порт ${DSH_PORT} стабильной версии (попытка ${probe.attempts}, ждём ${probe.elapsedSec} с)...`);
          emitProgress({
            step: 3,
            total: 3,
            percent: Math.min(98, 85 + probe.attempts * 2),
            label: `🛡️ Аварийный откат [3/3]: проверка готовности стабильной версии (${probe.attempts}/30)...`,
            mode: 'rollback'
          });
        });
        if (!rbBoot.ok) throw new Error(`Не удалось перезапустить стабильную версию, система не перешла в нормальное готовое состояние`);

        emitProgress({
          step: 3,
          total: 3,
          percent: 100,
          label: `🛡️ Автоматический откат завершён! Система восстановлена до стабильной версии v${previousVersion}`,
          mode: 'rollback'
        });

        log(`======================================================================`);
        log(`✅ [Аварийный откат успешен] Система полностью восстановлена до стабильной рабочей версии: v${previousVersion}`);
        log(`✔ Проверяем текущую работающую версию (dsh --version): ${this.getCurrentVersion()}`);
        log(`✔ Статус сервиса: нормальная работа на http://127.0.0.1:${DSH_PORT}`);
        log(`======================================================================`);

        this.installing = false;
        this.lastKnownVersion = ''; // после отката кэш версии тоже сбрасываем
        return {
          ok: false,
          error: `Не удалось запустить целевую версию ${version}: ${err.message}, система автоматически безопасно откатилась на стабильную версию ${previousVersion}`,
          rolledBack: true,
          version: previousVersion
        };
      } catch (rbErr) {
        log(`💥 [КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ] Автоматический откат завершился с исключением: ${rbErr.message}`);
        // Подстраховка 1: активного ядра нет, но точка отката сохранилась → восстанавливаемся изо всех сил, чтобы контейнер не превратился в «кирпич»
        if (rollbackDir && fs.existsSync(rollbackDir) && !fs.existsSync(path.join(LIVE_CORE_DIR, 'package.json'))) {
          try {
            this._restoreFromRollbackDir(rollbackDir);
            rollbackDir = null;
            log(`🛡️ [Подстраховочное восстановление] Прежнее ядро срочно восстановлено из точки отката.`);
          } catch (e2) {
            log(`💥 [Подстраховочное восстановление не удалось] Точка отката сохранена в ${rollbackDir}, можно перезапустить контейнер для самовосстановления через entrypoint.`);
          }
        }
        // Подстраховка 2: файлы ядра на месте (скорее всего уже старые), но сервис не поднялся → стараемся поднять, чтобы не было ситуации «ядро есть, а работать нечем»
        let booted = false;
        if (fs.existsSync(path.join(LIVE_CORE_DIR, 'package.json'))) {
          try {
            const b = await this.boot();
            booted = !!(b && b.ok);
            if (booted) log(`🛡️ [Подстраховочный запуск] Сервис DSH снова поднят.`);
          } catch (e3) {
            log(`⚠️ Подстраховочный запуск не удался: ${e3.message}`);
          }
        }
        this.installing = false;
        return {
          ok: false,
          error: `Переключение не удалось, откат завершился с ошибкой: ${rbErr.message}`,
          rolledBack: booted,
          version: previousVersion,
          hint: booted ? 'Сервис снова поднят' : 'Файлы ядра на месте, но сервис может быть не готов — рекомендуется перезапустить контейнер'
        };
      }
    }
  }

  // === Управление хранилищем версий и примитивы атомарной подмены (Issue #7) ===

  /** Пометить время последнего использования версии (основание для LRU); сбой не влияет на основной поток */
  _touchVersionUsage(version) {
    try {
      const dir = resolveWithinDir(this.versionsCacheDir, version);
      const now = new Date();
      fs.utimesSync(dir, now, now);
    } catch {}
  }

  /**
   * Атомарная подмена активного каталога ядра: staging → live.
   * Сначала переименовываем live во временную точку отката (.dsh-rollback-tmp-*), затем переименовываем staging в live (одна файловая система, миллисекунды).
   * При сбое любого шага точка отката немедленно восстанавливается — гарантированно «либо всё старое, либо всё новое», полусостояния исключены.
   */
  _atomicSwapCore(stagingDirPath) {
    const backupDir = path.join(LIVE_CORE_PARENT, `.dsh-rollback-tmp-${process.pid}-${Date.now()}`);
    let moved = false;
    if (fs.existsSync(LIVE_CORE_DIR)) {
      // Сначала убираем работающее ядро в точку отката (каталог lower-слоя на overlayfs деградирует до копирования с удалением)
      try {
        moveDirOrCopy(LIVE_CORE_DIR, backupDir);
      } catch (e) {
        // Подвешиваем уже созданную (возможно, полную) точку отката на объект ошибки — вызывающий код сможет восстановиться из неё
        const err = new Error(`Сбой подмены каталога ядра (не удалось сохранить исходное ядро): ${e.message}`);
        if (fs.existsSync(backupDir)) err.rollbackDir = backupDir;
        throw err;
      }
      moved = true;
    }
    try {
      fs.renameSync(stagingDirPath, LIVE_CORE_DIR);
    } catch (e) {
      // Подмена не удалась: немедленно восстанавливаемся из точки отката — гарантируем «либо всё старое, либо всё новое»
      if (moved) {
        try { restoreCoreFromBackup(backupDir); }
        catch (err) { console.error('[dsh-manager] 💥 Не удалось восстановить исходное ядро (нужно ручное вмешательство/перезапуск контейнера для самовосстановления):', err.message); }
      }
      throw new Error(`Сбой подмены каталога ядра (попытка восстановления исходного ядра выполнена): ${e.message}`);
    }
    // Целевой путь симлинка bin не меняется, сбой обновления на работоспособность не влияет → best-effort
    try {
      runSyncSafe('ln', ['-sfn', path.join(LIVE_CORE_DIR, 'lib/bin.js'), DSH_BIN_LINK]);
    } catch (e) {
      console.warn(`[dsh-manager] ⚠️ Не удалось обновить симлинк dsh (на работу не влияет): ${e.message}`);
    }
    // Ключево: точку отката здесь не удаляем. Она сохраняется до «успешной проверки готовности»,
    // чтобы при неудаче проверки аварийный откат мог восстановиться напрямую локально — без персистентного архива и без сети.
    return moved ? backupDir : null;
  }

  /**
   * Продвигаем временную точку отката в защищённый однослотовый слот точки отката на месте (.dsh-rollback-preserved) в контейнерном слое
   * Если старый резервный экземпляр уже есть, он удаляется только после успешного продвижения — ротация не разрушает ничего преждевременно
   */
  _promoteToPreservedRollback(tmpDir, version = '') {
    if (!tmpDir || !fs.existsSync(tmpDir)) return;
    if (path.resolve(tmpDir) === path.resolve(ROLLBACK_PRESERVED_DIR)) return;

    let ver = version;
    if (!ver) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
        ver = pkg.version || '';
      } catch {}
    }
    // Записываем полную метку .ready (с nodeAbi / arch / sizeBytes / createdAt и т.д.)
    try {
      writeReadyMarker(tmpDir, ver || 'unknown');
    } catch (e) {
      console.warn(`[dsh-manager] ⚠️ Запись метаданных точки отката пропущена: ${e.message}`);
    }

    const oldPreserved = path.join(LIVE_CORE_PARENT, `.dsh-rollback-old-${process.pid}-${Date.now()}`);
    let movedOld = false;

    if (fs.existsSync(ROLLBACK_PRESERVED_DIR)) {
      try {
        moveDirOrCopy(ROLLBACK_PRESERVED_DIR, oldPreserved);
        movedOld = true;
      } catch (e) {
        console.warn(`[dsh-manager] ⚠️ Не удалось сохранить старый резервный экземпляр точки отката: ${e.message}`);
      }
    }

    try {
      moveDirOrCopy(tmpDir, ROLLBACK_PRESERVED_DIR);
      if (movedOld && fs.existsSync(oldPreserved)) {
        try { fs.rmSync(oldPreserved, { recursive: true, force: true }); } catch {}
      }
    } catch (err) {
      if (movedOld && fs.existsSync(oldPreserved) && !fs.existsSync(ROLLBACK_PRESERVED_DIR)) {
        try { moveDirOrCopy(oldPreserved, ROLLBACK_PRESERVED_DIR); } catch {}
      }
      throw new Error(`Сбой продвижения точки отката в защищённый слот: ${err.message}`);
    }
  }

  /** Уборка временной точки отката, созданной на время переключения */
  _disposeRollbackDir(dir) {
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.warn(`[dsh-manager] ⚠️ Не удалось убрать точку отката (на работу не влияет): ${e.message}`); }
  }

  /** Восстановление активного ядра из каталога точки отката (путь аварийного отката или восстановления на месте, с проверкой ABI) */
  _restoreFromRollbackDir(dir) {
    if (!dir || !fs.existsSync(dir)) throw new Error('Точка отката не существует, восстановление невозможно');
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      throw new Error('Каталог точки отката неполон (отсутствует package.json), восстановление невозможно');
    }
    const marker = readReadyMarker(dir);
    if (marker) {
      if (marker.nodeAbi && String(marker.nodeAbi) !== String(process.versions.modules)) {
        throw new Error(`Node ABI точки отката (${marker.nodeAbi}) не совпадает с текущей средой выполнения (${process.versions.modules}), восстановление отклонено`);
      }
      if (marker.arch && marker.arch !== process.arch) {
        throw new Error(`Архитектура точки отката (${marker.arch}) не совпадает с текущей средой выполнения (${process.arch}), восстановление отклонено`);
      }
    }
    restoreCoreFromBackup(dir);
  }

  /** Предварительная проверка места на диске: перед переключением убеждаемся, что в целевых путях хватает места, иначе — чистое прерывание (работающий сервис не затрагивается) */
  _assertDiskSpace(paths, needBytes, log = () => {}) {
    for (const p of paths) {
      try {
        const st = fs.statfsSync(p);
        const free = st.bavail * st.bsize;
        if (free < needBytes) {
          let hint = ' (сначала можно освободить место: удалите точку отката на странице резервного копирования)';
          try {
            const rb = this.getRollbackPoint ? this.getRollbackPoint() : null;
            if (rb && rb.exists && rb.sizeFormatted) {
              hint = ` (сначала можно освободить ${rb.sizeFormatted}: удалите точку отката на странице резервного копирования)`;
            }
          } catch {}
          throw new Error(`Недостаточно дискового пространства: ${p} доступно ${formatBytes(free)}, для переключения требуется не менее ${formatBytes(needBytes)}${hint} (переключение отклонено, сервис продолжает работать)`);
        }
        log(`✔ Проверка дискового пространства пройдена ${p}: доступно ${formatBytes(free)}`);
      } catch (e) {
        if (/Недостаточно дискового пространства/.test(e.message)) throw e;
        log(`ℹ️ Пропуск проверки места на диске ${p}: ${e.message}`);
      }
    }
  }

  /** Статистика хранилища версий: ёмкость, состояние монтирования, объём и статус каждой версии */
  getVersionsStoreStats() {
    const activeVersion = this.getCurrentVersion();
    const pinnedVersion = FALLBACK_DSH_VERSION;
    let freeBytes = null;
    let totalBytes = null;
    try {
      const st = fs.statfsSync(this.versionsCacheDir);
      freeBytes = st.bavail * st.bsize;
      totalBytes = st.blocks * st.bsize;
    } catch {}
    const versions = listStoreEntries().map(e => ({
      version: e.version,
      ready: e.ready,
      sizeBytes: e.sizeBytes,
      lastUsedAt: new Date(e.mtimeMs).toISOString(),
      active: e.version === activeVersion,
      pinned: e.version === pinnedVersion,
      imageRevision: (e.marker && e.marker.imageRevision) || null
    })).sort((a, b) => (a.version < b.version ? 1 : -1));
    return {
      ok: true,
      dir: this.versionsCacheDir,
      persisted: isMountedPath(this.versionsCacheDir),
      freeBytes,
      totalBytes,
      keepN: GC_KEEP_DEFAULT,
      activeVersion,
      pinnedVersion,
      totalSizeBytes: versions.reduce((s, v) => s + (v.sizeBytes || 0), 0),
      versions
    };
  }

  /**
   * Очистка хранилища версий по LRU: сохраняем keepN недавно использованных версий + активную версию + базовую версию образа.
   * Возвращаем список удалённых и освобождённое место; dryRun только показывает, ничего не удаляя.
   */
  gcVersions({ keepN = GC_KEEP_DEFAULT, dryRun = false, activeVersion = null } = {}) {
    if (this.installing) return { ok: false, error: 'Идёт переключение версии, параллельная очистка отклонена' };
    const entries = listStoreEntries().filter(e => e.ready);
    const keep = new Set();
    const n = Math.max(1, Number(keepN) || GC_KEEP_DEFAULT);
    for (const e of [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, n)) keep.add(e.version);
    for (const v of [activeVersion || this.getCurrentVersion(), FALLBACK_DSH_VERSION]) {
      if (v) keep.add(v);
    }
    const removed = [];
    for (const e of entries) {
      if (keep.has(e.version)) continue;
      if (dryRun) { removed.push({ version: e.version, bytes: e.sizeBytes, dryRun: true }); continue; }
      try {
        fs.rmSync(e.dir, { recursive: true, force: true });
        removed.push({ version: e.version, bytes: e.sizeBytes });
      } catch (err) {
        console.warn(`[dsh-manager] Сбой очистки в хранилище версий ${e.version}: ${err.message}`);
      }
    }
    // Заодно убираем просроченные остатки staging (>1 часа)
    if (!dryRun) this.cleanupStagingOrphans();
    this.lastGcAt = Date.now();
    return { ok: true, dir: this.versionsCacheDir, kept: [...keep], removed, freedBytes: removed.reduce((s, r) => s + (r.bytes || 0), 0), dryRun };
  }

  /** Уборка остатков staging в хранилище версий и staging/rollback в контейнерном слое (вызывается при запуске и при GC) */
  cleanupStagingOrphans(maxAgeMs = 3600 * 1000) {
    const now = Date.now();
    for (const dir of [STORE_STAGING_DIR, LIVE_CORE_PARENT]) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        // Явно пропускаем защищённый однослотовый резервный экземпляр точки отката на месте — автоочистке не подлежит
        if (name === '.dsh-rollback-preserved') continue;
        const isStoreStaging = dir === STORE_STAGING_DIR;
        if (!isStoreStaging && !/^\.dsh-(staging|rollback)-/.test(name)) continue;
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs < maxAgeMs) continue;
          fs.rmSync(p, { recursive: true, force: true });
          console.log(`[dsh-manager] Убраны просроченные остатки: ${p}`);
        } catch {}
      }
    }
  }

  /** Удалить указанную версию из хранилища (активная версия и базовая версия образа защищены) */
  deleteCachedVersion(version) {
    if (this.installing) return { ok: false, error: 'Идёт переключение версии, параллельное удаление отклонено' };
    if (!isValidVersion(version)) return { ok: false, error: 'Некорректный формат номера версии' };
    const activeVersion = this.getCurrentVersion();
    if (version === activeVersion) return { ok: false, error: `Версия ${version} сейчас запущена, удаление запрещено` };
    if (version === FALLBACK_DSH_VERSION) return { ok: false, error: `Версия ${version} является базовой версией образа, удаление запрещено` };
    let dir;
    try { dir = resolveWithinDir(this.versionsCacheDir, version); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(dir)) return { ok: false, error: `Версии ${version} нет в хранилище версий` };
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, version, dir };
  }

  // === Управление защищённой точкой отката на месте и восстановление на месте (Issue #7) ===

  /**
   * Получить состояние защищённой точки отката на месте в контейнерном слое
   * @returns {{ exists: boolean, version: string|null, sizeBytes: number, sizeFormatted: string, createdAt: string|null, nodeAbi: string|null, abiMatches: boolean, path: string, canRestore: boolean }}
   */
  getRollbackPoint() {
    const p = ROLLBACK_PRESERVED_DIR;
    if (!fs.existsSync(p)) {
      return {
        exists: false,
        version: null,
        sizeBytes: 0,
        sizeFormatted: '0 B',
        createdAt: null,
        nodeAbi: null,
        abiMatches: false,
        path: p,
        canRestore: false
      };
    }

    let version = null;
    const pkgPath = path.join(p, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        version = pkg.version || null;
      } catch {}
    }

    const marker = readReadyMarker(p);
    if (marker && marker.version) {
      version = marker.version;
    }

    const currentAbi = String(process.versions.modules);
    const currentArch = process.arch;
    const nodeAbi = marker && marker.nodeAbi ? String(marker.nodeAbi) : currentAbi;
    const arch = marker && marker.arch ? marker.arch : currentArch;
    const abiMatches = (nodeAbi === currentAbi) && (arch === currentArch);

    let sizeBytes = 0;
    if (marker && typeof marker.sizeBytes === 'number' && marker.sizeBytes > 0) {
      sizeBytes = marker.sizeBytes;
    } else {
      try { sizeBytes = dirSizeBytes(p); } catch {}
    }

    let createdAt = null;
    if (marker && marker.createdAt) {
      createdAt = marker.createdAt;
    } else {
      try {
        const st = fs.statSync(p);
        createdAt = new Date(st.mtimeMs).toISOString();
      } catch {}
    }

    const hasPkg = fs.existsSync(pkgPath);
    const canRestore = !this.installing && abiMatches && hasPkg;

    return {
      exists: true,
      version,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      createdAt,
      nodeAbi,
      abiMatches,
      path: p,
      canRestore
    };
  }

  /**
   * Вручную удалить защищённую точку отката, чтобы освободить место на диске
   * @returns {{ ok: boolean, freedBytes?: number, error?: string, path?: string }}
   */
  deleteRollbackPoint() {
    if (this.installing) {
      return { ok: false, error: 'Идёт переключение или восстановление версии, параллельное удаление отклонено' };
    }
    const p = ROLLBACK_PRESERVED_DIR;
    if (!fs.existsSync(p)) {
      return { ok: false, error: 'Точка отката не существует или уже была удалена' };
    }
    const point = this.getRollbackPoint();
    const freedBytes = point.sizeBytes || dirSizeBytes(p);
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return { ok: true, freedBytes, path: p };
    } catch (err) {
      return { ok: false, error: `Не удалось удалить точку отката: ${err.message}` };
    }
  }

  /**
   * Восстановить активное ядро на месте из защищённого резервного экземпляра точки отката (семантика восстановления Issue #7)
   * @param {function} onProgress
   * @param {function} onLog
   * @returns {Promise<{ ok: boolean, version?: string, error?: string, rolledBack?: boolean }>}
   */
  async restoreRollbackPoint(onProgress = () => {}, onLog = () => {}) {
    this.installLog = [];
    if (typeof onProgress === 'function' && typeof onLog !== 'function') {
      onLog = onProgress;
      onProgress = null;
    }
    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      this.installLog.push(line);
      if (typeof onLog === 'function') onLog(line);
      console.log(`[dsh-restore] ${msg}`);
    };
    const emitProgress = (data) => {
      if (typeof onProgress === 'function') {
        try { onProgress(data); } catch {}
      }
    };

    if (this.installing) {
      log('❌ Уже выполняется другая задача смены версии или восстановления, параллельная операция отклонена');
      return { ok: false, error: 'Другая задача уже выполняется, подождите' };
    }

    this.installing = true;
    let staging = null;
    let newRb = null;
    const previousVersion = this.getCurrentVersion();

    try {
      emitProgress({ step: 1, total: 5, percent: 10, label: 'Проверка окружения и целостности резервного экземпляра точки отката', mode: 'install' });
      log(`=== [Этап 1/5] Предварительная проверка целостности резервного экземпляра точки отката и Node ABI ===`);

      const rbPoint = this.getRollbackPoint();
      if (!rbPoint.exists) {
        throw new Error('Резервный экземпляр точки отката не существует, восстановление на месте невозможно');
      }
      if (!rbPoint.abiMatches) {
        throw new Error(`Node ABI точки отката (${rbPoint.nodeAbi}) не совпадает с текущей средой выполнения (${process.versions.modules}), безопасное восстановление невозможно`);
      }
      if (!fs.existsSync(path.join(ROLLBACK_PRESERVED_DIR, 'package.json'))) {
        throw new Error('В каталоге точки отката отсутствует package.json, данные повреждены');
      }

      const targetVersion = rbPoint.version || 'unknown';
      log(`✔ Проверка точки отката пройдена: целевая версия v${targetVersion}, размер ${rbPoint.sizeFormatted}, Node ABI совпадает`);

      // Предварительная проверка места на диске в контейнерном слое
      this._assertDiskSpace([LIVE_CORE_PARENT], MIN_FREE_BYTES, log);

      emitProgress({ step: 2, total: 5, percent: 25, label: 'Остановка сервиса и копирование резервного экземпляра в staging', mode: 'install' });
      log(`=== [Этап 2/5] Остановка работающего сервиса и копирование резервного экземпляра в staging ===`);
      log(`Останавливаем процесс DSH...`);
      await this.stop();

      // Копируем резервный экземпляр в staging-каталог контейнерного слоя (нельзя использовать rename или жёсткие ссылки — при сбое резервный экземпляр должен остаться нетронутым, а патчи не должны его загрязнить)
      staging = path.join(LIVE_CORE_PARENT, `.dsh-staging-restore-${process.pid}-${Date.now()}`);
      fs.mkdirSync(staging, { recursive: true });
      log(`> Копируем резервный экземпляр в изолированный staging-каталог: ${staging}`);
      runSyncSafe('cp', ['-a', ROLLBACK_PRESERVED_DIR + '/.', staging + '/']);
      log(`✔ Копия резервного экземпляра готова в изолированном staging-каталоге`);

      emitProgress({ step: 3, total: 5, percent: 50, label: 'Атомарная подмена каталога ядра', mode: 'install' });
      log(`=== [Этап 3/5] Выполняем атомарную подмену каталога ядра (staging → live) ===`);
      newRb = this._atomicSwapCore(staging);
      staging = null; // после успешной подмены staging-каталог переименован в live
      log(`✔ Подмена каталога ядра завершена (прежнее ядро сохранено как временная точка отката ${path.basename(newRb || '')})`);

      emitProgress({ step: 4, total: 5, percent: 75, label: 'Сборка плагинов и самовосстановление патчей', mode: 'install' });
      log(`=== [Этап 4/5] Сборка окружения плагинов и внедрение клиентских патчей ===`);
      if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
        log(`> Синхронизируем и связываем зависимости плагинов с новым ядром (schemastery и dsh-browser-desktop)...`);
        const res = spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }
      if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
        log(`> Внедряем персистентный патч клиентского loopback-хоста...`);
        const res = spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }
      log(`✔ Адаптация плагинов и патчей завершена`);

      emitProgress({ step: 5, total: 5, percent: 85, label: 'Подъём сервиса и проверка готовности', mode: 'install' });
      log(`=== [Этап 5/5] Поднимаем восстанавливаемое ядро и выполняем проверку готовности ===`);
      this.lastExitInfo = null;
      this.recentLogs = [];

      const bootRes = await this.restart((probe) => {
        const dynamicPercent = Math.min(97, 85 + Math.floor(probe.attempts * 0.8));
        log(`🔍 [Проверка готовности] Опрашиваем порт ${DSH_PORT} на отклик о готовности (попытка ${probe.attempts}, ждём ${probe.elapsedSec} с)...`);
        emitProgress({
          step: 5,
          total: 5,
          percent: dynamicPercent,
          label: `Проверка готовности порта (${probe.attempts}/30)...`,
          mode: 'install'
        });
      });

      if (!bootRes.ok) {
        let failDetail = `Восстанавливаемая версия ${targetVersion} не прошла проверку готовности порта после запуска`;
        if (this.lastExitInfo) {
          failDetail = `Процесс восстанавливаемой версии аварийно завершился при запуске (Exit Code: ${this.lastExitInfo.code}, Signal: ${this.lastExitInfo.sig || 'none'})`;
        }
        throw new Error(failDetail);
      }

      // Проверка готовности успешна: старое ядро, снятое этой подменой (newRb), продвигаем в .dsh-rollback-preserved (прежний слот при этом ротируется),
      // и в слоте оказывается только что покинутая версия — что естественным образом поддерживает отмену восстановления
      if (newRb && fs.existsSync(newRb)) {
        try {
          this._promoteToPreservedRollback(newRb, previousVersion);
          newRb = null;
          log(`✔ Прежняя активная версия (v${previousVersion}) ротирована в точку отката на месте (отмена восстановления возможна повторно)`);
        } catch (promoteErr) {
          log(`⚠️ Ротация точки отката в защищённый слот завершилась с некритичным предупреждением: ${promoteErr.message}`);
        }
      }

      this.lastKnownVersion = '';
      const currentVer = this.getCurrentVersion();

      emitProgress({
        step: 5,
        total: 5,
        percent: 100,
        label: `Восстановление завершено! Активное ядро возвращено на v${currentVer}`,
        mode: 'install'
      });

      log(`======================================================================`);
      log(`🎉 [SUCCESS] Восстановление ядра DSH на месте успешно завершено!`);
      log(`🚀 Текущая работающая версия: v${currentVer} (сервис здоров и готов)`);
      log(`======================================================================`);

      return { ok: true, version: currentVer };

    } catch (err) {
      log(`======================================================================`);
      log(`❌ Восстановление не удалось: ${err.message}`);

      // Если подмена каталога ядра уже произошла (newRb существует) — запускаем безопасную отмену
      if (newRb && fs.existsSync(newRb)) {
        log(`⚠️ Срабатывает защитная отмена: восстанавливаем прежнее активное ядро (v${previousVersion}) до восстановления...`);
        emitProgress({
          step: 1,
          total: 3,
          percent: 40,
          label: `🛡️ Отменяем подмену и восстанавливаем прежнее активное ядро v${previousVersion}...`,
          mode: 'rollback'
        });

        try {
          await this.stop();
          this._restoreFromRollbackDir(newRb);
          newRb = null;
          log(`✔ Прежнее активное ядро восстановлено из временной резервной копии`);

          if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
            spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
          }
          if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
            spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
          }

          emitProgress({
            step: 2,
            total: 3,
            percent: 75,
            label: `🛡️ Повторный подъём прежнего ядра и проверка готовности...`,
            mode: 'rollback'
          });

          await this.restart();
          log(`✔ Прежнее активное ядро снова готово, прежний резервный экземпляр точки отката цел и не загрязнён`);

          emitProgress({
            step: 3,
            total: 3,
            percent: 100,
            label: `🛡️ Безопасный возврат к прежней активной версии v${previousVersion} выполнен`,
            mode: 'rollback'
          });

          return {
            ok: false,
            rolledBack: true,
            error: err.message,
            version: previousVersion
          };
        } catch (revErr) {
          log(`💥 [КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ] Отмена восстановления завершилась с исключением: ${revErr.message}`);
          return {
            ok: false,
            rolledBack: false,
            error: `Восстановление не удалось, отмена завершилась с ошибкой: ${revErr.message}`,
            version: previousVersion
          };
        }
      }

      return {
        ok: false,
        rolledBack: false,
        error: err.message,
        version: previousVersion
      };

    } finally {
      // На всём протяжении убираем остатки staging и неиспользованные временные точки отката, гарантируя сброс installing
      if (staging && fs.existsSync(staging)) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      }
      if (newRb && fs.existsSync(newRb)) {
        try { fs.rmSync(newRb, { recursive: true, force: true }); } catch {}
      }
      this.installing = false;
      this.lastKnownVersion = '';
    }
  }

  // === Снимки и резервное копирование конфигурационных файлов (делегируется асинхронному неблокирующему backupService) ===
  ensureDefaultSnapshot() {
    const defaultMarker = path.join(SNAPSHOTS_DIR, '.default_snapshot_created');
    if (fs.existsSync(defaultMarker)) {
      return { ok: true, alreadyExists: true };
    }

    const existing = backupService.listBackups().snapshots || [];
    const hasDefault = existing.some(s => s.filename.includes('default') || s.filename.includes('initial'));
    if (hasDefault) {
      try { fs.writeFileSync(defaultMarker, new Date().toISOString()); } catch {}
      return { ok: true, alreadyExists: true };
    }

    console.log('[dsh-manager] Первый запуск: асинхронно и неблокирующе создаём начальный снимок конфигурации по умолчанию...');
    backupService.createBackup('default-initial')
      .then(res => {
        try { fs.writeFileSync(defaultMarker, new Date().toISOString()); } catch {}
        console.log(`[dsh-manager] Начальный снимок конфигурации по умолчанию успешно создан: ${res.snapshot.filename}`);
      })
      .catch(err => {
        console.warn('[dsh-manager] Создание начального снимка пропущено (не критично):', err.message);
      });

    return { ok: true, pending: true };
  }

  createSnapshot(name = '') {
    return backupService.createBackup(name);
  }

  listSnapshots() {
    return backupService.listBackups();
  }

  restoreSnapshot(filename) {
    return backupService.restoreBackup(filename, this);
  }

  deleteSnapshot(filename) {
    return backupService.deleteBackup(filename);
  }

  getSnapshotPath(filename) {
    return backupService.getBackupPath(filename);
  }
}

const instance = new DshManager();
module.exports = instance;
