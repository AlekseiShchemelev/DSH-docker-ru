'use strict';
/**
 * Write-lock профиля — семантика выровнена с `withFileLock` официального `@deepseek-ai/dsh-atomic-write`.
 *
 * Предыстория (P6): нативный менеджер плагинов и редактор настроек DSH 0.1.7 перед изменением
 * `profiles/web/package.json` и `profiles/web/cordis.patch.yml` сначала берут
 * `profiles/web/package.json.lock` (эксклюзивное создание через `wx`).
 * Это межпроцессная взаимоисключающая блокировка; наш шлюз раньше вообще в ней не участвовал,
 * и обе стороны делали собственное «читать-менять-писать» целого файла: последний пишущий
 * целиком затирал изменения предыдущего → потеря обновлений (дрейф состояния включения
 * плагинов, пропажа записей настроек вроде `llm-pi-ai`).
 *
 * Этот модуль делает консоль легальным участником протокола блокировки. Пункт-в-пункт с апстримом:
 *   | пункт       | поведение апстрима                                                |
 *   |----------|-----------------------------------------------------------------|
 *   | файл блокировки | `${filename}.lock` (здесь `<profileDir>/package.json.lock`)    |
 *   | создание  | writeFile(lock, `${pid}\n`, { flag: 'wx', mode: 0o600 })         |
 *   | конкуренция | EEXIST; на Windows EPERM и при существующем файле блокировки    |
 *   | backoff    | с 20ms ×2, максимум 200ms                                        |
 *   | предел ожидания | у апстрима по умолчанию 2s; менеджер плагинов явно передаёт lockWaitMs=120s ⇒ у нас тоже 120s по умолчанию |
 *   | освобождение | `finally { rm(lock, { force: true }) }`                          |
 *   | читатели  | не держат lock (атомарный commit через rename гарантирует читателю целый файл) |
 *
 * Сверх апстрима добавлены две вещи (обе не меняют семантику взаимоисключения с DSH):
 *   1) **внутрипроцессная очередь взаимоисключения**: файловая блокировка взаимоисключает
 *      только между процессами; в одном процессе два параллельных запроса, войдя одновременно
 *      в «читать-менять-писать», тоже потеряют обновления. Поэтому поверх файлового lock
 *      сериализуем получения внутри данного процесса.
 *      Внимание: **вложенное получение не поддерживается** (повторное взятие того же lock
 *      в том же процессе бросает PROFILE_LOCK_REENTRANT, чтобы не получить молчаливый
 *      self-дедлок). Если нужно «сделать что-то ещё внутри lock» — вызывайте внутренние
 *      функции `*Locked` соответствующих модулей, а не берите lock повторно.
 *   2) **уборка устаревшего lock**: удаляем только когда PID, записанный в lock, **не существует**
 *      и mtime файла блокировки превысил порог. Апстрим не убирает; после краша он ждёт до тайм-аута.
 *      Здесь же, пока PID жив, lock никогда не убираем — взаимоисключение не нарушается.
 *      Отключить можно через DSH_PROFILE_LOCK_STALE_MS=0.
 *
 * Также предоставляется `assertProfileLockHeld()`: превращает «сначала обязательно держи lock»
 * в runtime-защиту, чтобы «забыли залочиться и пишем profile» мгновенно падало и в тестах,
 * и в проде, а не молча теряло обновления.
 */

const fs = require('fs');
const path = require('path');

const RETRY_INITIAL_MS = 20;
const RETRY_MAX_MS = 200;
/** Совпадает со значением lockWaitMs по умолчанию у dsh-plugin-manager (он держит lock под pnpm-установкой, что может быть долго) */
const DEFAULT_WAIT_MS = 120000;
/** Порог уборки устаревшего lock (ms); <=0 значит уборка выключена */
const STALE_MS = process.env.DSH_PROFILE_LOCK_STALE_MS === undefined
  ? 600000
  : Number(process.env.DSH_PROFILE_LOCK_STALE_MS);
/** Ожидание дольше этого порога — предупреждение (значит, есть конкуренция с DSH) */
const WARN_WAIT_MS = Number(process.env.DSH_PROFILE_LOCK_WARN_MS || 500);

/** lockPath -> { waitedMs }; указывает, что **данный процесс** сейчас держит этот файловый lock */
const held = new Map();
/** lockPath -> Promise: хвост очереди получения внутри текущего процесса */
const chains = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Путь write-lock профиля (полностью совпадает с DSH) */
function profileLockPath(profileDir) {
  return path.join(profileDir, 'package.json.lock');
}

function isProfileLockHeld(profileDir) {
  return held.has(profileLockPath(profileDir));
}

/**
 * Runtime-защита: при попытке писать файлы profile без удержания lock — мгновенная ошибка.
 * Это последний рубеж против «молчаливой потери обновлений» (надёжнее статической проверки).
 */
function assertProfileLockHeld(profileDir) {
  const lockPath = profileLockPath(profileDir);
  if (held.has(lockPath)) return;
  const err = new Error(
    `profile-lock: попытка записи в ${profileDir} без удержания write-lock профиля; ` +
    `оберните весь блок «читать-менять-писать» в withProfileLock() (файл lock: ${lockPath})`
  );
  err.code = 'PROFILE_LOCK_NOT_HELD';
  throw err;
}

function timeoutError(lockPath, waitMs, label) {
  const err = new Error(
    `profile-lock: тайм-аут ожидания write-lock профиля (${waitMs}мс)${label}: ${lockPath}; ` +
    `владелец, вероятно, выполняет pnpm-установку DSH, повторите позже`
  );
  err.code = 'PROFILE_LOCK_TIMEOUT';
  return err;
}

/** Совпадает с апстримной isLockContention */
function isLockContention(error, lockPath) {
  const code = error && error.code;
  if (code === 'EEXIST') return true;
  if (code !== 'EPERM') return false;
  try {
    fs.lstatSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function readHolderPid(lockPath) {
  try {
    const n = Number.parseInt(String(fs.readFileSync(lockPath, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: процесс существует, но у этого процесса нет прав слать сигнал ⇒ считаем живым (консервативно)
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * Консервативная уборка устаревшего lock: удаляем, только когда PID из lock подтверждённо
 * не существует и файл lock не менялся дольше STALE_MS. Если что-то не подтверждено
 * (PID жив / PID не прочитался / порог не превышен) — не трогаем.
 */
function tryReclaimStale(lockPath) {
  if (!(STALE_MS > 0)) return false;
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - stat.mtimeMs <= STALE_MS) return false;
  const pid = readHolderPid(lockPath);
  if (pid !== null && isProcessAlive(pid)) return false;
  try {
    fs.rmSync(lockPath, { force: true });
    console.warn(`[profile-lock] Убран устаревший lock (владелец PID=${pid === null ? 'неизвестен' : pid}, mtime старше ${STALE_MS}мс): ${lockPath}`);
    return true;
  } catch {
    return false;
  }
}

/** Ожидание с дедлайном (для внутрипроцессной очереди, чтобы и ожидание могло истечь) */
async function waitUntil(promise, deadline, lockPath, waitMs, label) {
  const remain = deadline - Date.now();
  if (remain <= 0) throw timeoutError(lockPath, waitMs, label);
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(lockPath, waitMs, label)), remain); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Внутрипроцессное взаимоисключение: получатели одного lock внутри текущего процесса выстраиваются в очередь.
 * @returns {{ prev: Promise<void>, release: () => void }}
 */
function enqueueInProcessTurn(lockPath) {
  const prev = chains.get(lockPath) || Promise.resolve();
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const tail = prev.then(() => gate);
  chains.set(lockPath, tail);
  const release = () => {
    releaseGate();
    if (chains.get(lockPath) === tail) chains.delete(lockPath);
  };
  return { prev, release };
}

/** Получение межпроцессного файлового lock (с дедлайном и уборкой устаревшего lock) */
async function acquireFileLock(lockPath, profileDir, deadline, waitMs, label) {
  fs.mkdirSync(profileDir, { recursive: true });
  let delay = RETRY_INITIAL_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (!isLockContention(error, lockPath)) throw error;
      tryReclaimStale(lockPath);
    }
    if (Date.now() >= deadline) throw timeoutError(lockPath, waitMs, label);
    await sleep(delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
}

/**
 * Получает write-lock профиля и возвращает функцию освобождения (обязательно вызывать в finally).
 * @param {string} profileDir каталог профиля (например `<DSH_HOME>/.dsh/profiles/web`)
 * @param {{ waitMs?: number, label?: string }} [options]
 * @returns {Promise<() => void>} функция освобождения
 */
async function acquireProfileLock(profileDir, options = {}) {
  const lockPath = profileLockPath(profileDir);
  const waitMs = Number.isFinite(options.waitMs) ? Number(options.waitMs) : DEFAULT_WAIT_MS;
  const label = options.label ? ` (${options.label})` : '';

  // Вложенное получение не поддерживается: если процесс уже держит этот lock — сразу ошибка,
  // а не молчаливый self-дедлок
  if (held.has(lockPath)) {
    const err = new Error(
      `profile-lock: процесс уже держит write-lock профиля ${lockPath}, повторное получение; ` +
      `вызывайте внутри lock внутренние функции *Locked модулей, а не берите lock снова`
    );
    err.code = 'PROFILE_LOCK_REENTRANT';
    throw err;
  }

  const started = Date.now();
  const deadline = started + waitMs;

  // 1) Очередь внутри процесса (конкурентные в одном процессе обязаны идти последовательно,
  //   иначе снова потеряем обновления)
  const turn = enqueueInProcessTurn(lockPath);
  try {
    await waitUntil(turn.prev, deadline, lockPath, waitMs, label);
  } catch (error) {
    turn.release();
    throw error;
  }

  // 2) Межпроцессный файловый lock
  try {
    await acquireFileLock(lockPath, profileDir, deadline, waitMs, label);
  } catch (error) {
    turn.release();
    throw error;
  }

  const waitedMs = Date.now() - started;
  held.set(lockPath, { waitedMs });
  if (waitedMs >= WARN_WAIT_MS) {
    console.warn(`[profile-lock] Ожидание write-lock профиля ${waitedMs}мс${label} (есть конкуренция с DSH): ${lockPath}`);
  }

  return () => {
    if (!held.has(lockPath)) {
      turn.release();
      return;
    }
    held.delete(lockPath);
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* Сбой освобождения не должен влиять на вызывающего; устаревший lock добирает tryReclaimStale */
    }
    turn.release();
  };
}

/** Совместимый вход: освобождение по пути (срабатывает, только если lock действительно держит этот процесс) */
function releaseProfileLock(lockPath) {
  if (!held.has(lockPath)) return;
  held.delete(lockPath);
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {}
}

/**
 * Выполняет операцию внутри write-lock профиля (весь блок «читать-менять-писать» обязан оказаться здесь).
 * @template T
 * @param {string} profileDir
 * @param {() => T | Promise<T>} operation
 * @param {{ waitMs?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
async function withProfileLock(profileDir, operation, options = {}) {
  const release = await acquireProfileLock(profileDir, options);
  try {
    return await operation();
  } finally {
    release();
  }
}

module.exports = {
  DEFAULT_WAIT_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
  profileLockPath,
  isProfileLockHeld,
  assertProfileLockHeld,
  acquireProfileLock,
  releaseProfileLock,
  withProfileLock
};
