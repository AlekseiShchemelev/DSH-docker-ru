const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const {
  readSidecar,
  writeSidecarAtomic,
  removeSidecar,
  inspectArchive
} = require('./snapshot-manifest');

// Issue #9: единый источник истины для списка каталогов данных
// (на стороне создания — исключения режима «только конфигурация», на стороне восстановления —
// что сохраняется в режиме «только конфигурация»)
const DATA_ENTRIES = ['sessions', 'attachments', 'storages', 'plugin-data', 'logs', 'cache'];

const SNAPSHOTS_DIR = process.env.DSH_SNAPSHOTS_DIR || '/root/.dsh-snapshots';
// M11: поддерживается перенос корневого каталога через DSH_HOME (при развёртывании
// не от root указывайте /home/<user>)
const DSH_DIR = path.join(process.env.DSH_HOME || '/root', '.dsh');
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB

function getCurrentDshVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json', 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  try {
    const vMeta = JSON.parse(fs.readFileSync(path.join(__dirname, '../version.json'), 'utf8'));
    if (vMeta?.supply?.dshVersion) return vMeta.supply.dshVersion;
  } catch {}
  return '0.1.7-rc.2';
}

function getCurrentProjectVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  return '0.1.9';
}

try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}

let activeTask = null; // { type: 'backup'|'restore'|'import', label: string, startedAt: number }

function isBusy() {
  return activeTask !== null;
}

function getActiveTask() {
  return activeTask;
}

function sanitizeName(name) {
  return (name || 'manual').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 50);
}

function verifyGzipMagic(headerBuffer) {
  if (!headerBuffer || headerBuffer.length < 2) return false;
  return headerBuffer[0] === 0x1f && headerBuffer[1] === 0x8b;
}

function hasPigz() {
  try {
    const res = spawnSync('which', ['pigz'], { encoding: 'utf8' });
    return res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Асинхронный запуск команды tar, полностью развязанный с главным циклом событий Node.js.
 *
 * ⚠️ Параметр maxOutputBytes здесь — лишь защитный предохранитель «чтобы дочерний процесс
 * не выдал гигабайты текста и не забил память родителя»; он НЕ ПРИГОДЕН для решения о том,
 * заслуживает ли архив доверия: список элементов корректного снимка растёт с объёмом данных
 * без верхней границы. Для проверки каждого элемента (restore / import) используйте
 * validateArchiveMembers() — она разбирает вывод построчно в потоке, без жёсткого лимита
 * в байтах, и потому не отбраковывает большие снимки (Issue #8).
 */
function runTarAsync(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10 * 60 * 1000;
  // Запас по «полному захвату stderr для сообщения об ошибке»; решение о безопасности
  // от этого значения не зависит
  const maxOutputBytes = Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : 64 * 1024 * 1024;
  const spawnOptions = { ...options };
  delete spawnOptions.timeoutMs;
  delete spawnOptions.maxOutputBytes;

  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });

    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`tar: превышено время выполнения (${Math.round(timeoutMs / 1000)} c): tar ${args.join(' ')}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const onData = (chunk, isErr) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`tar: превышен лимит вывода (прочитано ${outBytes} байт, лимит ${maxOutputBytes} байт): tar ${args.join(' ')}`));
        return;
      }
      if (isErr) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', d => onData(d, false));
    child.stderr.on('data', d => onData(d, true));

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Все снимки, создаваемые этим сервисом, упаковываются как `tar -cf <file> -C /root .dsh`,
// поэтому все элементы обязаны находиться внутри `.dsh/`.
const ALLOWED_ARCHIVE_PREFIX = '.dsh';
// Симлинки в node_modules снимка указывают на эти места установки зависимостей
// (создаются install-plugin.mjs / pnpm) — это легальные цели
const ALLOWED_LINK_PREFIXES = [
  '/usr/local/lib/node_modules/',
  '/usr/lib/node_modules/',
  '/app/plugins/',
  '/app/node_modules/',
  '/opt/'
];

// ── Лимиты ресурсов для проверки архива (validateArchiveMembers) ─────────────
// Урок Issue #8: **нельзя решать, заслуживает ли архив доверия, по числу байтов
// вывода списка tar**. Число элементов корректного снимка растёт вместе с плагинами,
// сессиями и вложениями (на практике около 138~160 байт на элемент), поэтому
// жёсткий лимит манифеста 8 MiB в v0.1.4~v0.1.9 ошибочно помечал как «вредоносный/
// повреждённый» нормальные снимки с числом элементов свыше примерно 50–60 тысяч.
// Теперь разбор идёт построчно в потоке, а лимит распространяется только на число
// элементов: память O(1), а запас предела достаточен, чтобы не отбраковать настоящие
// большие снимки.
const DEFAULT_MAX_ARCHIVE_MEMBERS = Number(process.env.DSH_MAX_ARCHIVE_MEMBERS) > 0
  ? Number(process.env.DSH_MAX_ARCHIVE_MEMBERS)
  : 1000 * 1000;
// Запас по длине строки: строка `tar -tv` не бывает длиннее «PATH_MAX + метаданные»;
// превышение означает, что выводу уже нельзя доверять
const MAX_LISTING_LINE_BYTES = 64 * 1024;
// Запас по суммарному числу байтов списка: страхует только от случая «tar безудержно
// сыплет мусор» (сам потоковый разбор память не потребляет)
const DEFAULT_MAX_LISTING_BYTES = 512 * 1024 * 1024;
// Разделители для элементов-ссылок: символическая ссылка выводится как ` -> ` (не локализуется);
// жёсткая ссылка — локализованной строкой. Здесь LC_ALL=C фиксируется при spawn,
// но строка для zh_CN (` 连接到 `) тоже сохранена, чтобы снова не попасться на локаль.
const LINK_SEPARATORS = [' -> ', ' link to ', ' 连接到 '];
// Допустимые префиксы «корня архива» для абсолютных целей симлинков: в снимках реально
// встречаются симлинки вида `.dsh-module-fallback/node_modules/<pkg> -> <home>/.dsh/profiles/web/node_modules/<pkg>` —
// их цель по-прежнему внутри восстанавливаемого дерева, поэтому это легальные элементы
// (старая реализация отклоняла весь архив → старые снимки вообще не восстанавливались).
// 1-й элемент = DSH home текущего запуска; 2-й элемент = `.dsh` под «корнем развёртывания
// по умолчанию» — чтобы после переезда «с развёртывания от root по умолчанию на
// собственный DSH_HOME (не от root)» старые снимки по-прежнему восстанавливались;
// как и DSH_DIR, вычисляется из env (можно переопределить DSH_LEGACY_HOME), конкретный
// home не зашит жёстко.
const LEGACY_DSH_DIR = path.join(process.env.DSH_LEGACY_HOME || '/root', '.dsh');
const ARCHIVE_ROOT_ABS_PREFIXES = Array.from(new Set([DSH_DIR + '/', LEGACY_DSH_DIR + '/']));
// Issue #9: кандидаты «корня архива» при пересчёте относительных целей симлинков
// по реальному месту восстановления (текущий home + корень развёртывания по умолчанию).
// Относительные симлинки, созданные pnpm для зависимостей `link:` в старых снимках,
// «выползают вверх за корень архива», но после пересчёта по месту восстановления они
// указывают ровно на каталоги из белого списка (например /usr/local/lib/node_modules/...),
// что полностью эквивалентно записи абсолютного пути.
const ARCHIVE_ROOT_BASES = Array.from(new Set([DSH_DIR, LEGACY_DSH_DIR]));
const toPosix = (p) => String(p).replace(/\\/g, '/');
// Оборона в глубину: отслеживаем элементы-симлинки и отказываем любым элементам,
// находящимся под симлинком (GNU tar при распаковке отклоняет такие записи, но белый
// список не должен зависеть от поведения соседнего ПО); заодно ограничиваем множество
// отслеживаемых ссылок, чтобы патологический архив не забил память мириадами симлинков.
const MAX_TRACKED_SYMLINK_MEMBERS = 100 * 1000;

/**
 * Проверка допустимости пути элемента архива (обязан находиться под `.dsh/` и не содержать
 * `..` / `.` / пустых сегментов).
 * @param {string} memberPath имя элемента внутри архива
 * @param {string} who кого касается сообщение об ошибке (например «элемент архива», «цель жёсткой ссылки архива»)
 */
function assertSafeMemberPath(memberPath, who) {
  const clean = memberPath.replace(/\/+$/, '');
  if (clean !== ALLOWED_ARCHIVE_PREFIX && !clean.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) {
    throw new Error(`${who}: выходит за разрешённые пределы (допустимо только под ${ALLOWED_ARCHIVE_PREFIX}/): ${String(memberPath).slice(0, 120)}`);
  }
  const segs = clean.split('/');
  if (segs.some(s => s === '..' || s === '.' || s === '')) {
    throw new Error(`${who}: недопустимый сегмент пути: ${String(memberPath).slice(0, 120)}`);
  }
}

/**
 * Контролируется ли абсолютная цель симлинка: **сначала нормализация, затем сравнение
 * префиксов** (иначе цель вида `/opt/../etc/passwd` обманет белый список через `startsWith`).
 * Разрешены легальные места установки зависимостей этого проекта, а также **собственный
 * корень самого архива** (`$DSH_HOME/.dsh`) — цель всё равно остаётся внутри
 * восстанавливаемого дерева, а остаток пути проверяется как обычный путь элемента.
 * @param {string} absPath нормализованный абсолютный путь
 */
function isAllowedAbsoluteLinkTarget(absPath) {
  if (!absPath.startsWith('/')) return false;
  if (ALLOWED_LINK_PREFIXES.some(p => absPath.startsWith(p))) return true;
  for (const root of ARCHIVE_ROOT_ABS_PREFIXES) {
    if (!absPath.startsWith(root)) continue;
    const rel = absPath.slice(root.length);
    if (!rel) return false;
    try {
      assertSafeMemberPath(ALLOWED_ARCHIVE_PREFIX + '/' + rel, 'цель ссылки архива');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Контролируется ли цель симлинка.
 *  - Относительная цель:
 *      1. после нормализации всё ещё внутри `.dsh/` (внутренняя ссылка архива) → пропускаем;
 *      2. **Issue #9**: относительные симлинки, созданные pnpm для зависимостей `link:` в старых
 *         снимках, «выползают вверх за корень архива»
 *         (пример: `.dsh/profiles/web/node_modules/dshmarket -> ../../../../../usr/local/lib/node_modules/dshmarket`).
 *         По реальному месту восстановления они указывают ровно на каталог из белого списка, то есть
 *         по уровню доверия **полностью эквивалентны записи абсолютного пути**,
 *         поэтому здесь цель превращается в абсолютный путь по реальному месту назначения и
 *         проверяется тем же белым списком, что и абсолютные цели (новых зон доверия не появляется).
 *  - Абсолютная цель: сначала нормализация, затем сравнение префиксов.
 * Примечание: базой для разрешения служит `ARCHIVE_ROOT_BASES` (текущий DSH home + корень
 * развёртывания по умолчанию); относительные цели, которые не разрешились (например, ушли
 * в /etc), по-прежнему отклоняются `isAllowedAbsoluteLinkTarget` → сохраняется fail-closed.
 */
function isAllowedSymlinkTarget(memberName, linkTarget) {
  if (!linkTarget.startsWith('/')) {
    const insideArchive = path.posix.normalize(path.posix.join(path.posix.dirname(memberName), linkTarget));
    if (insideArchive.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) return true;
    // Относительная цель, вылезшая за корень архива → пересчитываем в абсолютный путь
    // по реальному месту восстановления и прогоняем через тот же белый список
    const memberDirInArchive = path.posix.dirname(memberName);
    for (const base of ARCHIVE_ROOT_BASES) {
      const memberDirAbs = path.posix.join(toPosix(path.posix.dirname(toPosix(base))), memberDirInArchive);
      const resolved = path.posix.resolve(memberDirAbs, linkTarget);
      if (isAllowedAbsoluteLinkTarget(resolved)) return true;
    }
    return false;
  }
  return isAllowedAbsoluteLinkTarget(path.posix.normalize(linkTarget));
}

/**
 * Вырезает из текста имени элемента в выводе `tar -tv` «имя + цель ссылки».
 *
 * ⚠️ Разделители (` -> ` / ` link to ` / ` 连接到 `) — обычный текст, который вставляет сам tar,
 * но и само имя, и цель **могут содержать ту же строку** — тогда одну строку текста
 * однозначно разрезать невозможно. Старая реализация брала «первый» разделитель и
 * поддавалась на обман вида `.dsh/leak -> dummy -> /etc/passwd` (имя обрезалось, а настоящая
 * абсолютная цель воспринималась как относительный путь и пропускалась).
 * Поэтому здесь: **если разделителей больше одного — сразу fail-closed**
 * (имена элементов настоящих снимков этих строк не содержат).
 */
function splitLinkMember(rawName) {
  let count = 0;
  let firstIdx = -1;
  let firstSep = null;
  for (const sep of LINK_SEPARATORS) {
    let from = 0;
    let idx;
    while ((idx = rawName.indexOf(sep, from)) >= 0) {
      count += 1;
      if (firstIdx < 0 || idx < firstIdx) { firstIdx = idx; firstSep = sep; }
      from = idx + sep.length;
    }
  }
  if (count === 0) return { name: rawName, linkTarget: null, ambiguous: false };
  if (count > 1) return { name: rawName, linkTarget: null, ambiguous: true };
  return {
    name: rawName.slice(0, firstIdx),
    linkTarget: rawName.slice(firstIdx + firstSep.length),
    ambiguous: false
  };
}

/** Разбор одной строки `tar -tvzf`; недопустимый элемент сразу приводит к ошибке (fail-closed). */
function classifyArchiveMemberLine(rawLine) {
  const line = rawLine.replace(/\s+$/, '');
  if (!line) return null;

  const parts = line.trim().split(/\s+/);
  // `-rw-r--r-- owner/group size date time name`
  if (parts.length < 6) throw new Error(`Не удалось разобрать элемент архива: ${line.slice(0, 120)}`);

  const typeChar = parts[0][0];
  const rawName = parts.slice(5).join(' ');
  const isLink = typeChar === 'l' || typeChar === 'h';

  // Разрез по разделителю выполняем только для элементов-ссылок: если у обычного имени
  // случайно встречается ` -> ` / ` link to `, разрез обрежет настоящее имя и мы можем
  // **пропустить** сегмент `..` во второй его половине.
  let name = rawName;
  let linkTarget = null;
  if (isLink) {
    const split = splitLinkMember(rawName);
    if (split.ambiguous) {
      throw new Error(`Элемент-ссылка архива содержит несколько разделителей ссылки, разбор однозначно невозможен: ${rawName.slice(0, 120)}`);
    }
    name = split.name;
    linkTarget = split.linkTarget;
  }

  if (isLink) {
    if (!linkTarget) {
      const kind = typeChar === 'h' ? 'жёсткой' : 'символической';
      throw new Error(`У ${kind} ссылки элемента архива отсутствует цель (формат вывода tar не распознан): ${name.slice(0, 120)}`);
    }
    assertSafeMemberPath(name, 'элемент-ссылка архива');
    // Сам корень архива обязан быть каталогом и никогда не быть ссылкой: иначе после
    // распаковки `.dsh` превратится в симлинку куда-то в сторону, а последующие шаги
    // restoreBackup вроде «копирования gateway.config.json в staging» запишут файл мимо дерева.
    if (name.replace(/\/+$/, '') === ALLOWED_ARCHIVE_PREFIX) {
      throw new Error(`Корень архива ${ALLOWED_ARCHIVE_PREFIX} не может быть элементом-ссылкой: ${name.slice(0, 120)}`);
    }
    if (typeChar === 'h') {
      // Цель жёсткой ссылки — «уже существующий элемент архива», поэтому проверяем её
      // как обычное имя элемента: если цель уходит за `.dsh/` или содержит `..`,
      // при распаковке она может завести запись за пределы архива.
      assertSafeMemberPath(linkTarget, 'цель жёсткой ссылки архива');
      return { type: 'hardlink', name, linkTarget };
    }
    if (!isAllowedSymlinkTarget(name, linkTarget)) {
      throw new Error(`Архив содержит элемент-ссылку, указывающий на недопустимое место: ${name.slice(0, 60)} -> ${String(linkTarget).slice(0, 60)}`);
    }
    return { type: 'symlink', name };
  }

  if (typeChar !== '-' && typeChar !== 'd') {
    throw new Error(`Архив содержит недопустимый тип элемента (${typeChar}); разрешены только обычные файлы, каталоги и контролируемые ссылки: ${name.slice(0, 120)}`);
  }
  assertSafeMemberPath(name, 'элемент архива');
  return { type: typeChar === 'd' ? 'dir' : 'file', name };
}

/**
 * Проверка белого списка для элементов архива (вызывается до распаковки / переименования в итоговое имя).
 *
 * Блокируются: абсолютные пути, сегменты `..`, элементы за префиксом `.dsh/`
 * (например `.ssh/authorized_keys`, `.bashrc`), а также элементы-устройства / FIFO
 * и прочее помимо обычных файлов (чтобы при распаковке ничего не записалось мимо каталога).
 * Разрешаются: обычные файлы / каталоги / симлинки (цель ограничена) / жёсткие ссылки
 * (цель обязана оставаться элементом `.dsh/` внутри архива).
 * При любой ошибке выбрасывается исключение, вызывающая сторона не выполняет распаковку (fail-closed).
 *
 * Ключевые моменты реализации (исправление Issue #8):
 *  1. stdout команды `tar -tvzf` разбирается **построчно в потоке**: манифест целиком
 *     в память больше не буферизуется, жёсткого лимита в байтах больше нет;
 *     ограничение — по числу элементов и подобрано так, чтобы не отбраковывать
 *     корректные большие снимки (старый лимит 8 MiB считал повреждёнными нормальные
 *     снимки с числом элементов ≥50–60 тысяч).
 *  2. При spawn жёстко задаётся `LC_ALL=C`: GNU tar печатает жёсткие ссылки локализованно
 *     (C: ` link to ` / zh_CN: ` 连接到 `), а старый код распознавал только символическую
 *     ссылку ` -> `, из-за чего **любой корректный снимок с жёсткими ссылками** ошибочно
 *     считался «элементом-ссылкой без цели».
 *  3. В тексте ошибки превышение масштаба больше не называется «файл повреждён», и в
 *     сообщение добавлены фактические счётчики для удобства диагностики.
 *
 * @param {string} archivePath путь к архиву
 * @param {object} [opts] { maxMembers, maxListingBytes, timeoutMs }
 * @returns {Promise<{members:number, listingBytes:number, hardLinks:number, symLinks:number}>}
 */
function validateArchiveMembers(archivePath, opts = {}) {
  const maxMembers = Number(opts.maxMembers) > 0 ? Number(opts.maxMembers) : DEFAULT_MAX_ARCHIVE_MEMBERS;
  const maxListingBytes = Number(opts.maxListingBytes) > 0 ? Number(opts.maxListingBytes) : DEFAULT_MAX_LISTING_BYTES;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['--numeric-owner', '-tvzf', archivePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: '' }
    });

    let settled = false;
    let timer = null;
    let members = 0;
    let listingBytes = 0;
    let hardLinks = 0;
    let symLinks = 0;
    let stderr = '';
    let pending = '';
    const decoder = new StringDecoder('utf8');
    // Симлинк-имя элемента → для обороны в глубину «никакой элемент не может находиться под симлинком»
    const symlinkNames = new Set();

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      reject(err);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(
      () => fail(new Error(`Проверка архива превысила время ожидания (${Math.round(timeoutMs / 1000)} c): ${path.basename(String(archivePath))}`)),
      timeoutMs
    );
    if (timer.unref) timer.unref();

    const handleLine = (rawLine) => {
      if (settled) return;
      const cls = classifyArchiveMemberLine(rawLine);
      if (!cls) return;
      members += 1;
      if (members > maxMembers) {
        // Здесь речь о «масштабе», а не о «повреждении»: формулировка должна позволять
        // пользователю это различать, плюс дан явный путь выхода из ситуации
        throw new Error(
          `Число элементов архива превысило предел (${members} > ${maxMembers}), проверка прервана. ` +
          `Возможно, это корректный, но необычно большой снимок; если он вам доверен, поднимите предел ` +
          `(переменная окружения DSH_MAX_ARCHIVE_MEMBERS) либо создайте снимок «только конфигурация» и повторите.`
        );
      }

      // Оборона в глубину: ни один из предков элемента не может быть симлинком.
      // GNU tar при распаковке отклоняет такие записи («не удалось открыть: не каталог»),
      // но белый список не должен целиком делегировать безопасность соседнему ПО —
      // иначе при смене реализации распаковки появится окно для записи мимо дерева.
      if (symlinkNames.size > 0) {
        const segs = cls.name.split('/');
        // Начинаем с i=1: сам `.dsh` тоже проверяем (корень-ссылку мы уже отклонили выше,
        // здесь это второй рубеж защиты)
        for (let i = 1; i < segs.length; i++) {
          if (symlinkNames.has(segs.slice(0, i).join('/'))) {
            throw new Error(`Элемент архива находится под символической ссылкой (при распаковке возможна запись за пределы архива): ${cls.name.slice(0, 120)}`);
          }
        }
      }

      if (cls.type === 'hardlink') {
        // Жёсткая ссылка на симлинк «наследует» семантику симлинка; без регистрации цепочки
        // `.dsh/sym` (симлинк) → `.dsh/h4 link to .dsh/sym` → `.dsh/h4/evil` обошла бы
        // последующую проверку предков.
        const target = cls.linkTarget ? cls.linkTarget.replace(/\/+$/, '') : null;
        if (target && symlinkNames.has(target) && symlinkNames.size < MAX_TRACKED_SYMLINK_MEMBERS) {
          symlinkNames.add(cls.name.replace(/\/+$/, ''));
        }
        hardLinks += 1;
      } else if (cls.type === 'symlink') {
        if (symlinkNames.size >= MAX_TRACKED_SYMLINK_MEMBERS) {
          throw new Error(`В архиве слишком много символьных ссылок (> ${MAX_TRACKED_SYMLINK_MEMBERS}), безопасная проверка невозможна`);
        }
        symlinkNames.add(cls.name.replace(/\/+$/, ''));
        symLinks += 1;
      }
    };

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      listingBytes += chunk.length;
      if (listingBytes > maxListingBytes) {
        return fail(new Error(
          `Вывод списка архива аномально вырос (прочитано ${listingBytes} байт > запасного предела ${maxListingBytes} байт), проверка прервана`
        ));
      }
      pending += decoder.write(chunk);
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.length > MAX_LISTING_LINE_BYTES) {
          return fail(new Error(`Аномально длинная строка элемента архива (${line.length} байт), безопасный разбор невозможен`));
        }
        try {
          handleLine(line);
        } catch (e) {
          return fail(e);
        }
      }
      if (pending.length > MAX_LISTING_LINE_BYTES) {
        return fail(new Error(`Аномально длинная строка элемента архива (>${MAX_LISTING_LINE_BYTES} байт), безопасный разбор невозможен`));
      }
    });

    // Из stderr для сообщения об ошибке сохраняются только первые 8 КиБ, чтобы битый
    // архив, сыплющий мусор, не забил память
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= 8192) return;
      stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
    });

    child.on('error', (err) => fail(new Error('Не удалось запустить tar для проверки архива: ' + err.message)));

    child.on('close', (code) => {
      if (settled) return;
      pending += decoder.end();
      if (pending) {
        try {
          handleLine(pending);
        } catch (e) {
          return fail(e);
        }
      }
      if (code !== 0) {
        return fail(new Error('Файл архива повреждён или не является корректным tar.gz: ' + (stderr.trim() || `код завершения tar ${code}`)));
      }
      if (members === 0) return fail(new Error('Архив пуст'));
      succeed({ members, listingBytes, hardLinks, symLinks });
    });
  });
}

/**
 * Issue #9: **автоматически** чинит относительные симлинки, «выползающие за корень архива»
 * (совместимость со старыми снимками, от пользователя ничего не требуется).
 *
 * В старых снимках pnpm создаёт для зависимостей `link:` **относительные** симлинки, например
 *   .dsh/profiles/web/node_modules/dshmarket -> ../../../../../usr/local/lib/node_modules/dshmarket
 * корректно они разрешаются только если DSH home имеет ровно двухуровневую глубину вроде
 * /root/.dsh; при смене пути развёртывания или повторной упаковке ссылки «плывут».
 * Здесь внутри песочницы staging такой симлинок **на месте переписывается в эквивалентный
 * абсолютный** (только если разрешённая цель попадает в существующий белый список),
 * чтобы восстановленное дерево не зависело от глубины каталогов — смена образа или точки
 * монтирования не ломает разрешение ссылок.
 *
 * Безопасность: переписываются только цели, которые пропускает `isAllowedAbsoluteLinkTarget()`,
 * остальные остаются как есть; обход не следует за симлинками (Dirent для симлинка не считается
 * каталогом), поэтому обхода границ невозможен.
 *
 * @param {string} stagedDsh абсолютный путь к `.dsh` внутри каталога staging
 * @returns {{repaired:number, kept:number, samples:string[]}}
 */
function repairEscapingRelativeLinks(stagedDsh) {
  const report = { repaired: 0, kept: 0, samples: [] };
  const stack = [stagedDsh];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(p); } catch { continue; }
        if (!target || target.startsWith('/')) continue; // за абсолютные цели отвечает белый список на этапе проверки, переписывать не нужно
        const memberName = ALLOWED_ARCHIVE_PREFIX + '/' + toPosix(path.relative(stagedDsh, p));
        const insideArchive = path.posix.normalize(path.posix.join(path.posix.dirname(memberName), target));
        if (insideArchive.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) continue; // внутренняя относительная ссылка архива, переписывать не нужно
        const memberDirInArchive = path.posix.dirname(memberName);
        let resolved = null;
        for (const base of ARCHIVE_ROOT_BASES) {
          const candidate = path.posix.resolve(
            path.posix.join(toPosix(path.posix.dirname(toPosix(base))), memberDirInArchive), target);
          if (isAllowedAbsoluteLinkTarget(candidate)) { resolved = candidate; break; }
        }
        if (!resolved) { report.kept += 1; continue; } // цель не из белого списка: оставляем как есть (этап проверки всё равно отклонит архив)
        try {
          fs.unlinkSync(p);
          fs.symlinkSync(resolved, p);
          report.repaired += 1;
          if (report.samples.length < 20) report.samples.push(`${memberName} -> ${resolved}`);
        } catch (e) {
          report.kept += 1;
          console.warn(`[backup-service] Не удалось переписать относительный симлинок (оставлен как есть): ${memberName}: ${e.message}`);
        }
      } else if (entry.isDirectory()) {
        stack.push(p);
      }
    }
  }
  return report;
}

/**
 * Асинхронное неблокирующее создание снимка конфигурации
 * @param {string|object} nameOrOpts - имя-заметка снимка или объект параметров { name, type }
 * @param {string} [backupType='full'] - тип резервной копии: 'full' (полная) или 'config' (только конфигурация, без сессий)
 */
async function createBackup(nameOrOpts = '', backupType = 'full') {
  if (activeTask) {
    throw new Error(`Сейчас выполняется операция «${activeTask.label}», повторите позже`);
  }

  let name = '';
  let type = 'full';
  if (typeof nameOrOpts === 'object' && nameOrOpts !== null) {
    name = nameOrOpts.name || '';
    type = nameOrOpts.type || nameOrOpts.backupType || 'full';
  } else {
    name = nameOrOpts || '';
    type = backupType || 'full';
  }

  const isConfigOnly = type === 'config';
  const safeName = sanitizeName(name);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = isConfigOnly
    ? `dsh-config-${ts}-${safeName}.tar.gz`
    : `dsh-snapshot-${ts}-${safeName}.tar.gz`;
  const finalPath = path.join(SNAPSHOTS_DIR, filename);
  const tmpPath = path.join(SNAPSHOTS_DIR, `.${filename}.tmp`);

  const taskDesc = isConfigOnly ? 'снимок «только конфигурация» (без сессий)' : 'полный снимок';
  activeTask = { type: 'backup', label: `создание: ${taskDesc}`, startedAt: Date.now() };

  console.log(`[backup-service] Начинаем асинхронное создание ${taskDesc}: ${filename}...`);

  try {
    // Исключаем объёмные временные и кэшируемые каталоги, не влияющие на конфигурацию,
    // — упаковка заметно ускоряется
    const isMultiThread = hasPigz();
    if (isMultiThread) {
      console.log('[backup-service] Обнаружен pigz, включено многопоточное сжатие по всем ядрам');
    }

    const tarArgs = [
      '--warning=no-file-changed',
      '--exclude=.dsh/.pnpm-store',
      '--exclude=**/node_modules/.cache',
      '--exclude=.dsh/tmp',
      '--exclude=.dsh/gateway.config.json'
    ];

    // Режим «только конфигурация»: полностью исключаем все каталоги данных
    // (сессии диалогов, вложения, индексы и хранилища рабочих областей, данные плагинов,
    // журналы и кэш). Используем общий константный список DATA_ENTRIES; здесь историческое
    // исключение только session_projcache* исправлено на исключение всего storages —
    // так устранена старая неточность, из-за которой снимок config мог унести
    // storages/workspace.json и затереть индекс сессий рабочего окружения; содержимое
    // снимка full не менялось.
    if (isConfigOnly) {
      for (const entry of DATA_ENTRIES) {
        tarArgs.push(`--exclude=.dsh/${entry}`);
      }
    }

    if (isMultiThread) {
      tarArgs.push('-I', 'pigz');
    } else {
      tarArgs.push('-z');
    }

    tarArgs.push('-cf', tmpPath, '-C', '/root', '.dsh');

    const res = await runTarAsync(tarArgs);

    // Ненулевой код завершения tar означает неполный архив (ошибки чтения / пропуски по правам
    // и т.п.) — ни в коем случае нельзя превращать его в корректный снимок
    if (res.code !== 0) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`Не удалось упаковать tar (exit=${res.code}): ${String(res.stderr || '').slice(0, 300)}`);
    }

    if (!fs.existsSync(tmpPath)) {
      throw new Error('Файл снимка не был создан: ' + (res.stderr || 'tar завершился с ошибкой'));
    }

    const stat = fs.statSync(tmpPath);
    if (stat.size === 0) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error('Созданный файл снимка имеет размер 0 байт и был удалён');
    }

    // Атомарное переименование
    fs.renameSync(tmpPath, finalPath);
    console.log(`[backup-service] ${taskDesc} создан: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} МБ)`);

    const dshVersion = getCurrentDshVersion();
    const projectVersion = getCurrentProjectVersion();
    try {
      writeSidecarAtomic(SNAPSHOTS_DIR, filename, {
        meta: {
          dshVersion,
          projectVersion,
          dockerSuiteVersion: projectVersion,
          schemaVersion: 2,
          configModel: 'patch-layer',
          backupType: isConfigOnly ? 'config' : 'full',
          createdAt: stat.mtime.toISOString(),
          name: safeName
        },
        archive: {
          sizeBytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs)
        }
      });
    } catch (e) {
      console.warn('[backup-service] Не удалось записать sidecar метаданных снимка:', e.message);
    }

    return {
      ok: true,
      snapshot: {
        filename,
        type: isConfigOnly ? 'config' : 'full',
        typeLabel: isConfigOnly ? 'Только конфигурация (без сессий)' : 'Полная резервная копия',
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        createdAt: stat.mtime.toISOString(),
        dshVersion,
        projectVersion,
        name: safeName
      }
    };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    console.error(`[backup-service] Не удалось создать ${taskDesc}:`, err.message);
    throw err;
  } finally {
    activeTask = null;
  }
}

/**
 * Асинхронное неблокирующее восстановление снимка конфигурации
 * @param {string} filename имя файла снимка
 * @param {object} dshManager менеджер процессов DSH
 * @param {object} [opts] параметры восстановления { mode: 'full' | 'config-only' }
 *
 * Issue #9:
 * 1. Выбор объёма восстановления: mode 'full' (полная замена, по умолчанию — 100 % обратная
 *    совместимость) или 'config-only' (восстанавливается только конфигурация, действующие
 *    сессии/вложения/данные сохраняются).
 * 2. Восстановление **автоматически** совместимо со старыми снимками — в старых версиях
 *    (эпоха 0.1.x) относительные симлинки, созданные pnpm для зависимостей `link:`, в виде
 *    архива «выползают за корень `.dsh/`» (этап проверки уже пропускает их по реальному месту
 *    восстановления); здесь они дополнительно автоматически переписываются в эквивалентные
 *    абсолютные симлинки до переключения, чтобы результат не зависел от глубины развёртывания
 *    (смена образа / точки монтирования не ломает ссылки).
 * 3. Точный обратный откат при сбое: в режиме config-only запрещена тотальная очистка
 *    clearDir, чтобы сохранить оставленные на месте каталоги данных; удаляются только
 *    элементы, перенесённые из staging, затем они возвращаются из rollbackRoot.
 */
async function restoreBackup(filename, dshManager, opts = {}) {
  if (activeTask) {
    throw new Error(`Сейчас выполняется операция «${activeTask.label}», повторите позже`);
  }

  const mode = (opts && opts.mode) ? opts.mode : 'full';
  if (mode !== 'full' && mode !== 'config-only') {
    throw new Error(`Недопустимый режим восстановления: ${mode} (поддерживаются только 'full' и 'config-only')`);
  }

  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    throw new Error('Недопустимое имя файла снимка');
  }

  const snapshotPath = path.join(SNAPSHOTS_DIR, safeFilename);
  if (!fs.existsSync(snapshotPath)) {
    throw new Error('Файл снимка не найден: ' + safeFilename);
  }

  activeTask = { type: 'restore', label: `восстановление снимка (${mode === 'config-only' ? 'только конфигурация' : 'полное'})`, startedAt: Date.now() };
  console.log(`[backup-service] Начинаем безопасное восстановление снимка: ${safeFilename} (режим: ${mode})...`);

  let rollbackRoot = null; // точка отката конфигурации до восстановления (для отмены при сбое)
  let stagedItems = [];    // относительные пути, перенесённые из staging — для точного обратного отката
  const isPreserved = (relPath) => {
    if (relPath === '.restore-staging' || relPath === '.restore-rollback') return true;
    if (mode === 'config-only') {
      const top = relPath.split(/[/\\]/)[0];
      if (DATA_ENTRIES.includes(top)) return true;
      const parts = relPath.split(/[/\\]/);
      if (parts.includes('node_modules')) return true;
    }
    return false;
  };

  const hasPreservedDescendant = (dir, currentRel, shouldSkip) => {
    try {
      const children = fs.readdirSync(dir);
      for (const child of children) {
        const childRel = currentRel ? path.join(currentRel, child) : child;
        if (shouldSkip(childRel)) return true;
        const childPath = path.join(dir, child);
        try {
          if (fs.lstatSync(childPath).isDirectory()) {
            if (hasPreservedDescendant(childPath, childRel, shouldSkip)) return true;
          }
        } catch {}
      }
    } catch {}
    return false;
  };

  const moveChildren = (from, to, shouldSkip = () => false, relBase = '') => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      const rel = relBase ? path.join(relBase, entry) : entry;
      if (shouldSkip(rel)) continue;

      const srcPath = path.join(from, entry);
      const dstPath = path.join(to, entry);
      let stat;
      try {
        stat = fs.lstatSync(srcPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (fs.existsSync(dstPath)) {
          moveChildren(srcPath, dstPath, shouldSkip, rel);
          try { fs.rmdirSync(srcPath); } catch {}
        } else if (hasPreservedDescendant(srcPath, rel, shouldSkip)) {
          fs.mkdirSync(dstPath, { recursive: true });
          moveChildren(srcPath, dstPath, shouldSkip, rel);
          try { fs.rmdirSync(srcPath); } catch {}
        } else {
          fs.renameSync(srcPath, dstPath);
        }
      } else {
        fs.renameSync(srcPath, dstPath);
      }
    }
  };

  function listAllRelPaths(dir, base = '') {
    let list = [];
    if (!fs.existsSync(dir)) return list;
    for (const f of fs.readdirSync(dir)) {
      const rel = base ? path.join(base, f) : f;
      const full = path.join(dir, f);
      try {
        const isDir = fs.lstatSync(full).isDirectory();
        list.push({ rel, isDir });
        if (isDir) {
          list = list.concat(listAllRelPaths(full, rel));
        }
      } catch {}
    }
    return list;
  }

  const rollback = () => {
    if (!rollbackRoot || !fs.existsSync(rollbackRoot)) return;
    console.warn('[backup-service] Выполняется точный обратный откат к конфигурации до восстановления...');
    // 1. Удаляем только элементы, перенесённые из staging в DSH_DIR; ни в коем случае
    //    не трогаем ничего из сохранённого (preserved)
    const sortedStaged = [...stagedItems].sort((a, b) => b.rel.length - a.rel.length);
    for (const item of sortedStaged) {
      if (isPreserved(item.rel)) continue;
      const targetPath = path.join(DSH_DIR, item.rel);
      if (!fs.existsSync(targetPath)) continue;
      if (item.isDir) {
        try {
          if (fs.readdirSync(targetPath).length === 0) {
            fs.rmdirSync(targetPath);
          }
        } catch {}
      } else {
        try { fs.rmSync(targetPath, { force: true }); } catch {}
      }
    }
    // 2. Возвращаем из rollbackRoot старые элементы конфигурации в рабочее окружение
    moveChildren(rollbackRoot, DSH_DIR, () => false);
    try { fs.rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}
  };

  try {
    // 1. Заранее проверяем целостность снимка и белый список элементов, чтобы битый
    //    или вредоносный архив не разрушил текущее окружение
    await validateArchiveMembers(snapshotPath);

    // 2. Корректно останавливаем DSH и полностью убираем внешние «сироты», возможные
    //    владельцы порта
    if (dshManager && typeof dshManager.stop === 'function') {
      await dshManager.stop();
    }
    try { spawnSync('fuser', ['-k', '-9', `${DSH_PORT}/tcp`], { stdio: 'ignore' }); } catch {}
    try {
      const psOut = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
      if (psOut.status === 0 && psOut.stdout) {
        for (const line of psOut.stdout.split('\n')) {
          if (/dsh\s+web|dsh-market-restart/i.test(line)) {
            const m = line.trim().match(/^(\d+)/);
            if (m && Number(m[1]) !== process.pid) {
              try { process.kill(Number(m[1]), 'SIGKILL'); } catch {}
            }
          }
        }
      }
    } catch {}

    // 3. Распаковываем в отдельный каталог staging (рабочее окружение не трогаем вовсе),
    //    после успешной проверки выполняем атомарное переключение.
    //    Обратите внимание: /root/.dsh — смонтированный том, rename между устройствами
    //    даст EXDEV, поэтому staging и точка отката обязаны находиться внутри этого тома
    //    (на том же устройстве), а при переключении эти два имени пропускаются.
    const stagingRoot = path.join(DSH_DIR, '.restore-staging');
    rollbackRoot = path.join(DSH_DIR, '.restore-rollback');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true });

    const isMultiThread = hasPigz();
    const extractArgs = ['--warning=no-file-changed', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'];
    if (isMultiThread) {
      extractArgs.push('-I', 'pigz');
    } else {
      extractArgs.push('-z');
    }

    // В режиме config-only на этапе распаковки исключаются каталоги данных и profiles/*/node_modules
    // Завершающий слэш запрещён: на практике с ним исключение GNU tar не срабатывает
    if (mode === 'config-only') {
      for (const entry of DATA_ENTRIES) {
        extractArgs.push(`--exclude=.dsh/${entry}`);
      }
      extractArgs.push('--exclude=.dsh/profiles/*/node_modules', '--exclude=*/node_modules');
    }

    extractArgs.push('-xf', snapshotPath, '-C', stagingRoot);
    const extractRes = await runTarAsync(extractArgs);
    if (extractRes.code !== 0) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('Не удалось распаковать tar в staging (рабочее окружение не пострадало): ' + (extractRes.stderr || 'неизвестная ошибка'));
    }

    const stagedDsh = path.join(stagingRoot, '.dsh');
    if (!fs.existsSync(stagedDsh)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('Некорректное содержимое снимка: каталог .dsh не найден, работа прервана (рабочее окружение не пострадало)');
    }

    // 3.0 Уборка песочницы (второй рубеж защиты): если в режиме config-only в staging всё ещё
    //     есть DATA_ENTRIES или node_modules — принудительно удаляем их через rmSync
    if (mode === 'config-only') {
      // Политика: не переносить в новое окружение старый storages/workspace.json из снимка.
      // Обоснование: в режиме config-only данные сессий полностью исключаются, поэтому
      // индексы вида sessionIds из старого workspace.json без соответствующих файлов сессий
      // превратились бы в «мёртвые» ссылки; безопаснее и чище, чтобы DSH сам инициализировал
      // пустой workspace.json.
      for (const entry of DATA_ENTRIES) {
        const p = path.join(stagedDsh, entry);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
      const profilesDir = path.join(stagedDsh, 'profiles');
      if (fs.existsSync(profilesDir)) {
        for (const child of fs.readdirSync(profilesDir)) {
          if (child === 'node_modules') {
            fs.rmSync(path.join(profilesDir, child), { recursive: true, force: true });
          } else {
            const subNm = path.join(profilesDir, child, 'node_modules');
            if (fs.existsSync(subNm)) {
              fs.rmSync(subNm, { recursive: true, force: true });
            }
          }
        }
      }
    }

    // Снимок намеренно не содержит собственные gateway.config.json шлюза (содержит authToken)
    // и .session_secret — переносим их из текущего рабочего окружения
    for (const keep of ['gateway.config.json', '.session_secret']) {
      const cur = path.join(DSH_DIR, keep);
      if (fs.existsSync(cur)) { try { fs.copyFileSync(cur, path.join(stagedDsh, keep)); } catch {} }
    }

    // 3.1 Issue #9: автоматически переписываем относительные симлинки, «выползающие за корень
    //     архива», в эквивалентные абсолютные (только цели из белого списка).
    //     Всё происходит внутри staging до атомарного переключения — рабочее окружение не
    //     затрагивается вовсе; от пользователя никаких действий не требуется.
    const linkRepair = repairEscapingRelativeLinks(stagedDsh);
    if (linkRepair.repaired > 0) {
      console.log(`[backup-service] Автоматически исправлено относительных симлинков в старом снимке: ${linkRepair.repaired} (оставлено как есть: ${linkRepair.kept})`);
      for (const s of linkRepair.samples) console.log(`[backup-service]   · ${s}`);
    }

    // Записываем все элементы из staging — для точного обратного отката при переключении
    // или неудачной проверке готовности
    stagedItems = listAllRelPaths(stagedDsh);

    // 4. Атомарное переключение: учтите, /root/.dsh — точка монтирования тома Docker,
    //    поэтому целиком rename даст EBUSY; вместо этого выполняем «перенос поэлементно» —
    //    содержимое рабочего окружения сначала уезжает в точку отката (в режиме config-only
    //    каталоги данных и node_modules остаются на месте), затем переезжает содержимое staging.
    try {
      moveChildren(DSH_DIR, rollbackRoot, isPreserved); // рабочее окружение → точка отката (сохранённое не переносим)
      moveChildren(stagedDsh, DSH_DIR, () => false);     // staging → рабочее окружение
      console.log(`[backup-service] Конфигурация переключена атомарно (старая сохранена в ${rollbackRoot} и будет удалена после успеха)`);
    } catch (switchErr) {
      try {
        rollback();
      } catch (rb) {
        console.error('[backup-service] Ошибка немедленного отката после неудачного переключения:', rb.message);
      }
      throw new Error('Не удалось переключить конфигурацию, выполнен откат к прежней: ' + switchErr.message);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }

    const webProfileDir = path.join(DSH_DIR, 'profiles', 'web');

    // 5. Если после распаковки node_modules пуст (лёгкий манифест резервной копии) —
    //    автоматически достраиваем зависимости по package.json.
    //    Переход к pnpm install выполняется только если после переключения в рабочем
    //    окружении нет profiles/web/node_modules (в config-only node_modules сохранён на месте,
    //    поэтому ложное срабатывание исключено)
    const targetNodeModules = path.join(webProfileDir, 'node_modules');
    const targetPkgJson = path.join(webProfileDir, 'package.json');
    if (fs.existsSync(targetPkgJson) && (!fs.existsSync(targetNodeModules) || fs.readdirSync(targetNodeModules).length === 0)) {
      console.log('[backup-service] Обнаружен неполный node_modules в снимке, автоматически достраиваем зависимости через pnpm...');
      await new Promise(resolve => {
        const pnpmInstall = spawn('pnpm', ['install', '--no-frozen-lockfile'], {
          cwd: webProfileDir,
          stdio: 'ignore'
        });
        pnpmInstall.on('close', resolve);
        pnpmInstall.on('error', resolve);
      });
    }

    // 6. Восстановление прав доступа и применение патчей
    try {
      if (fs.existsSync(DSH_DIR)) fs.chmodSync(DSH_DIR, 0o700);
      const credPath = path.join(DSH_DIR, '.credentials.yaml');
      if (fs.existsSync(credPath)) fs.chmodSync(credPath, 0o600);
    } catch {}

    if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
      await new Promise(r => {
        const c = spawn('node', ['/app/scripts/install-plugin.mjs'], { stdio: 'ignore' });
        c.on('close', r);
      });
    }
    if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
      await new Promise(r => {
        const c = spawn('node', ['/app/scripts/patch-dsh-client.mjs'], { stdio: 'ignore' });
        c.on('close', r);
      });
    }

    // 7. Поднимаем DSH заново и по-настоящему проверяем готовность
    let dshReady = false;
    if (dshManager && typeof dshManager.boot === 'function') {
      const bootRes = await dshManager.boot();
      dshReady = bootRes.ok === true;
      if (!dshReady) {
        throw new Error('Распаковка снимка завершена, но DSH не успел запуститься или не стал готовым, подробности — в журнале в терминале');
      }
    }

    // Успех: удаляем точку отката
    try { fs.rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}

    const preservedCount = mode === 'config-only'
      ? DATA_ENTRIES.filter(e => fs.existsSync(path.join(DSH_DIR, e))).length +
        (fs.existsSync(path.join(DSH_DIR, 'profiles', 'web', 'node_modules')) ? 1 : 0)
      : 0;

    if (mode === 'config-only') {
      console.log(`[backup-service] Снимок ${safeFilename} восстановлен (режим: ${mode}, сохранено каталогов данных/зависимостей: ${preservedCount}), готовность службы DSH: ${dshReady}`);
    } else {
      console.log(`[backup-service] Снимок ${safeFilename} восстановлен (режим: ${mode}), готовность службы DSH: ${dshReady}`);
    }

    return { ok: true, filename: safeFilename, mode, dshReady, repairedLinks: linkRepair.repaired };
  } catch (err) {
    // Неудача: если переключение уже выполнялось и точка отката ещё существует —
    // стараемся вернуть конфигурацию до восстановления и снова поднять службу
    try {
      if (rollbackRoot && fs.existsSync(rollbackRoot)) {
        rollback();
        if (dshManager && typeof dshManager.boot === 'function') {
          await dshManager.boot().catch(() => {});
        }
        console.log('[backup-service] Выполнен откат к конфигурации до восстановления');
      }
    } catch (rbErr) {
      console.error('[backup-service] Откат не удался:', rbErr.message);
    }
    console.error('[backup-service] Ошибка восстановления снимка:', err.message);
    throw err;
  } finally {
    activeTask = null;
  }
}

/**
 * Асинхронный потоковый приём импортируемого файла снимка (.tar.gz)
 */
function importBackupStream(req, rawFilename) {
  // Исправление антипаттерна: любое исключение внутри прежнего `new Promise(async executor)`
  // превращалось в необработанный отказ, из-за чего Promise никогда не завершался.
  // Теперь — «синхронный executor + асинхронная функция реализации», исключения единообразно
  // уходят в reject.
  return new Promise((resolve, reject) => {
    // Аналогично: catch перехватывает исключения только функции реализации, её возвращаемое
    // значение не используется (сама функция делает resolve/reject)
    Promise.resolve()
      .then(() => importBackupStreamImpl(req, rawFilename, resolve, reject))
      .catch(reject);
  });
}

async function importBackupStreamImpl(req, rawFilename, resolve, reject) {
    if (activeTask) {
      return reject(new Error(`Сейчас выполняется операция «${activeTask.label}», повторите позже`));
    }

    const origName = path.basename(rawFilename || 'imported-snapshot.tar.gz');
    const safeBase = sanitizeName(origName.replace(/\.tar\.gz$/i, ''));
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `dsh-snapshot-${ts}-imported_${safeBase}.tar.gz`;
    const finalPath = path.join(SNAPSHOTS_DIR, filename);
    const tmpPath = path.join(SNAPSHOTS_DIR, `.${filename}.tmp`);

    activeTask = { type: 'import', label: 'импорт снимка', startedAt: Date.now() };
    console.log(`[backup-service] Принимаем потоковую загрузку импортируемого снимка: ${filename}...`);

    const outStream = fs.createWriteStream(tmpPath);
    // При переполнении диска / изменении прав WriteStream излучает 'error'; без слушателя
    // это необработанное исключение → завершается весь шлюз
    outStream.on('error', (e) => {
      aborted = true;
      try { req.destroy(); } catch {}
      cleanup();
      reject(new Error('Не удалось записать файл снимка: ' + e.message));
    });
    let totalBytes = 0;
    let headerBytes = Buffer.alloc(0);
    let headerChecked = false;
    let aborted = false;

    const cleanup = () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      activeTask = null;
    };

    req.on('data', chunk => {
      if (aborted) return;
      totalBytes += chunk.length;

      // Проверка лимита размера
      if (totalBytes > MAX_UPLOAD_BYTES) {
        aborted = true;
        req.destroy();
        outStream.destroy();
        cleanup();
        return reject(new Error('Размер загруженного файла превышает лимит (максимум 300 МБ)'));
      }

      // Быстрая проверка магии Gzip (1f 8b)
      if (!headerChecked) {
        headerBytes = Buffer.concat([headerBytes, chunk]);
        if (headerBytes.length >= 2) {
          headerChecked = true;
          if (!verifyGzipMagic(headerBytes)) {
            aborted = true;
            req.destroy();
            outStream.destroy();
            cleanup();
            return reject(new Error('Некорректный формат файла, поддерживается только сжатый архив .tar.gz'));
          }
        }
      }

      outStream.write(chunk);
    });

    req.on('error', err => {
      aborted = true;
      outStream.destroy();
      cleanup();
      reject(err);
    });

    req.on('end', async () => {
      if (aborted) return;
      outStream.end();
      outStream.on('finish', async () => {
        try {
          if (totalBytes < 100) {
            cleanup();
            return reject(new Error('Загруженный файл пуст или данные неполны'));
          }

          // Повторная проверка целостности архива и белого списка элементов
          // (некорректный файл отбрасывается и не превращается в снимок)
          await validateArchiveMembers(tmpPath);

          // Атомарное переименование в итоговое имя
          fs.renameSync(tmpPath, finalPath);
          const stat = fs.statSync(finalPath);
          console.log(`[backup-service] Снимок успешно импортирован: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} МБ)`);

          // Асинхронно выводим и записываем sidecar метаданных (не блокирует ответ на загрузку)
          inspectArchive(finalPath, { filename, snapshotsDir: SNAPSHOTS_DIR }).catch(() => {});

          resolve({
            ok: true,
            snapshot: {
              filename,
              sizeBytes: stat.size,
              sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
              createdAt: stat.mtime.toISOString(),
              name: safeBase
            }
          });
        } catch (verErr) {
          cleanup();
          reject(verErr);
        } finally {
          activeTask = null;
        }
      });
    });
}

function listBackups() {
  try {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.tar.gz') && !f.startsWith('.'));
    const list = files.map(filename => {
      try {
        const filePath = path.join(SNAPSHOTS_DIR, filename);
        const stat = fs.statSync(filePath);
        let backupType = null;
        let dshVersion = null;
        let projectVersion = null;
        let configModel = null;
        try {
          const sc = readSidecar(SNAPSHOTS_DIR, filename);
          if (sc && sc.meta) {
            dshVersion = sc.meta.dshVersion || null;
            projectVersion = sc.meta.projectVersion || sc.meta.dockerSuiteVersion || null;
            configModel = sc.meta.configModel || null;
            if (sc.meta.backupType) {
              backupType = sc.meta.backupType;
            }
          }
        } catch {}
        // Предпочитаем реальный тип из метаданных sidecar; подсказка по имени файла —
        // только запасной вариант, если sidecar отсутствует
        if (!backupType) {
          backupType = (filename.startsWith('dsh-config-') || filename.includes('-config-') || filename.includes('_config_'))
            ? 'config'
            : 'full';
        }
        const isConfig = backupType === 'config';
        return {
          filename,
          type: isConfig ? 'config' : 'full',
          typeLabel: isConfig ? 'Только конфигурация (без сессий)' : 'Полная резервная копия',
          sizeBytes: stat.size,
          sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
          createdAt: stat.mtime.toISOString(),
          dshVersion,
          projectVersion,
          configModel
        };
      } catch {
        return null;
      }
    }).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return {
      ok: true,
      snapshots: list,
      activeTask: getActiveTask()
    };
  } catch (err) {
    return { ok: false, error: err.message, snapshots: [], activeTask: getActiveTask() };
  }
}

/**
 * Потоковое сканирование элементов архива снимка: определяется наличие каталога сессий
 * (.dsh/sessions) и каталога вложений (.dsh/attachments). Как только оба подтверждены,
 * процесс tar немедленно завершается досрочно — так осмотр больших архивов требует
 * меньше времени и меньше нагружает диск.
 * @param {string} archivePath абсолютный путь к архиву
 * @returns {Promise<{ hasSessions: boolean, hasAttachments: boolean }>}
 */
function scanArchiveContents(archivePath) {
  return new Promise((resolve, reject) => {
    let hasSessions = false;
    let hasAttachments = false;
    const isMultiThread = hasPigz();
    const args = isMultiThread ? ['-I', 'pigz', '-tf', archivePath] : ['-tzf', archivePath];
    const proc = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: '' }
    });
    const rl = readline.createInterface({ input: proc.stdout });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
      resolve({ hasSessions, hasAttachments });
    };

    rl.on('line', (rawLine) => {
      const line = rawLine.trim().replace(/^\.\//, '').replace(/\/+$/, '');
      if (line === '.dsh/sessions' || line.startsWith('.dsh/sessions/')) {
        hasSessions = true;
      }
      if (line === '.dsh/attachments' || line.startsWith('.dsh/attachments/')) {
        hasAttachments = true;
      }
      if (hasSessions && hasAttachments) {
        finish();
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      reject(err);
    });

    proc.on('close', () => {
      if (!settled) {
        settled = true;
        try { rl.close(); } catch {}
        resolve({ hasSessions, hasAttachments });
      }
    });
  });
}

/**
 * Подсчёт числа сессий в текущем каталоге выполнения службы (DSH_DIR/sessions)
 * Следуем реальной структуре: /root/.dsh/sessions/<workspaceId>/<sessionId>
 * либо каталог сессии, хранящийся напрямую
 * @param {string} sessionsDir абсолютный путь к корневому каталогу sessions
 * @returns {number}
 */
function countCurrentSessions(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      // Начинается с session- — считаем одной сессией
      if (ent.name.startsWith('session-')) {
        count++;
        continue;
      }
      // Иначе это каталог рабочей области — обходим и считаем вложенные каталоги сессий
      const subDir = path.join(sessionsDir, ent.name);
      try {
        const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
        for (const subEnt of subEntries) {
          if (!subEnt.isDirectory() || subEnt.name.startsWith('.')) continue;
          count++;
        }
      } catch {}
    }
  } catch {}
  return count;
}

/**
 * Только чтение: осмотр свойств снимка (для диалога выбора объёма восстановления)
 * Возвращаются наличие сессий/вложений в снимке, тип снимка по содержимому
 * и число сессий в текущем окружении
 * @param {string} filename имя файла снимка
 */
async function inspectSnapshot(filename) {
  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    return { ok: false, error: 'Недопустимое имя файла снимка' };
  }
  const filePath = path.join(SNAPSHOTS_DIR, safeFilename);
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'Файл снимка не найден: ' + safeFilename };
  }

  const { hasSessions, hasAttachments } = await scanArchiveContents(filePath);
  const backupType = hasSessions ? 'full' : 'config';
  const sessionCount = countCurrentSessions(path.join(DSH_DIR, 'sessions'));

  // Заодно помечаем или обновляем sidecar, чтобы последующий listBackups тоже мог за O(1)
  // точно знать выведенный backupType
  try {
    const sc = readSidecar(SNAPSHOTS_DIR, safeFilename);
    const stat = fs.statSync(filePath);
    if (sc && sc.meta) {
      if (sc.meta.backupType !== backupType) {
        sc.meta.backupType = backupType;
        writeSidecarAtomic(SNAPSHOTS_DIR, safeFilename, sc);
      }
    } else {
      writeSidecarAtomic(SNAPSHOTS_DIR, safeFilename, {
        meta: {
          backupType,
          name: safeFilename.replace(/\.tar\.gz$/i, ''),
          createdAt: stat.mtime.toISOString()
        },
        archive: {
          sizeBytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs)
        }
      });
    }
  } catch {}

  return {
    ok: true,
    filename: safeFilename,
    hasSessions,
    hasAttachments,
    backupType,
    current: {
      sessionCount
    }
  };
}

function deleteBackup(filename) {
  try {
    const safeFilename = path.basename(filename || '');
    if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
      return { ok: false, error: 'Недопустимое имя файла' };
    }
    const filePath = path.join(SNAPSHOTS_DIR, safeFilename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      try { removeSidecar(SNAPSHOTS_DIR, safeFilename); } catch {}
      return { ok: true };
    }
    return { ok: false, error: 'Файл снимка не найден' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getBackupPath(filename) {
  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    return null;
  }
  const filePath = path.join(SNAPSHOTS_DIR, safeFilename);
  return fs.existsSync(filePath) ? filePath : null;
}

module.exports = {
  createBackup,
  restoreBackup,
  importBackupStream,
  listBackups,
  deleteBackup,
  getBackupPath,
  getActiveTask,
  isBusy,
  validateArchiveMembers,
  // Для регрессионных тестов: поуровневые проверки (разбор одной строки / одного пути
  // и автоматический ремонт относительных симлинков в старых снимках)
  classifyArchiveMemberLine,
  assertSafeMemberPath,
  repairEscapingRelativeLinks,
  runTarAsync,
  scanArchiveContents,
  countCurrentSessions,
  inspectSnapshot,
  DATA_ENTRIES,
  SNAPSHOTS_DIR
};
