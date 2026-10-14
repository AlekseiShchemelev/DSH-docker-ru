'use strict';

/**
 * Общий ключ внутренних интерфейсов (/__internal/desktop/*).
 *
 * Предыстория: раньше эти интерфейсы пускались только по «адресу источника = loopback».
 * Как только шлюз встаёт за обратный прокси (когда Nginx и шлюз на одной машине,
 * все внешние запросы видятся с адреса 127.0.0.1), внешние посетители смогут
 * напрямую дёргать их (запуск/остановка рабочего стола, смена конфигурации).
 * Поэтому добавлен общий ключ, который знают только плагины внутри контейнера:
 *   - при старте шлюз генерирует/читает 256-битный случайный ключ, кладёт файл с правами 0600;
 *   - плагин перед каждым вызовом читает файл и передаёт ключ в заголовке `x-dsh-internal-token`;
 *   - проверка идёт сравнением за константное время и по-прежнему требует loopback-источник (эшелонированная оборона).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TOKEN_FILE = path.join(process.env.DSH_HOME || '/root', '.dsh/.internal-api-token');

function tokenFilePath() {
  return process.env.DSH_INTERNAL_TOKEN_FILE || DEFAULT_TOKEN_FILE;
}

let cachedToken = null;

/** Читает существующий ключ; при отсутствии или пустом значении возвращает null */
function readToken() {
  try {
    const raw = fs.readFileSync(tokenFilePath(), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Генерирует и сохраняет на диск новый ключ (0600); возвращает строку ключа */
function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const file = tokenFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return token;
}

/**
 * Возвращает действующий внутренний ключ (при первом вызове генерирует и сохраняет, дальше переиспользует).
 * Сохранение на диск гарантирует, что плагинам не придётся заново учить ключ после перезапуска шлюза;
 * права 0600 не дадут остальным non-root пользователям контейнера прочитать его.
 */
function getInternalToken() {
  if (cachedToken) return cachedToken;
  cachedToken = readToken() || generateToken();
  return cachedToken;
}

function safeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Проверяет, корректен ли внутренний ключ, переданный в запросе */
function verifyInternalToken(req) {
  const provided = req && req.headers ? req.headers['x-dsh-internal-token'] : undefined;
  if (typeof provided !== 'string' || !provided) return false;
  return safeEqualStr(provided.trim(), getInternalToken());
}

module.exports = {
  tokenFilePath,
  getInternalToken,
  readToken,
  verifyInternalToken
};
