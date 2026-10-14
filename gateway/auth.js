const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

let AUTH_TOKEN = (process.env.AUTH_TOKEN || process.env.ACCESS_CODE || '').trim();
const COOKIE_NAME = 'dsh_auth_session';
const COOKIE_MAX_AGE = Number(process.env.COOKIE_MAX_AGE) || 30 * 24 * 3600; // 30 days

// Инициализация ключа подписи: сначала переменная окружения -> затем файл на диске -> впервые генерируем
// 256-битный криптографически стойкий случайный ключ и сохраняем (CWE-330)
function initSigningSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }

  const secretFile = process.env.SESSION_SECRET_FILE || path.join(process.env.DSH_DIR || '/root/.dsh', '.session_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, 'utf8').trim();
      if (stored.length >= 32) {
        return stored;
      }
    }
  } catch (e) {
    console.warn('[auth] Ошибка чтения сохранённого session_secret:', e.message);
  }

  // Генерируем криптографически стойкий 256-битный по-настоящему случайный ключ, решая проблему CWE-330 «предсказуемый ключ»
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    const secretDir = path.dirname(secretFile);
    if (!fs.existsSync(secretDir)) {
      fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
    console.log('[auth] Ключ подписи Session инициализирован и сохранён на диск:', secretFile);
  } catch (e) {
    console.warn('[auth] Не удалось сохранить session_secret, хранение временно в памяти:', e.message);
  }

  return generated;
}

let SIGNING_SECRET = initSigningSecret();

function getSigningSecret() {
  return SIGNING_SECRET;
}

function updateAuthToken(newToken) {
  AUTH_TOKEN = (newToken !== undefined ? String(newToken) : '').trim();
  console.log('[auth] Код доступа обновлён, состояние:', isAuthEnabled() ? 'аутентификация включена' : 'аутентификация выключена (прозрачный проход без входа)');
}

function getAuthToken() {
  return AUTH_TOKEN;
}

// IP-based rate limiting for brute-force protection
const failedAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil, lastSeen }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60 * 1000; // 1 minute
const ATTEMPT_TTL_MS = 10 * 60 * 1000; // 10 минут: устаревшие записи периодически чистим, чтобы Map не рос бесконечно

// Доверять ли X-Forwarded-For с обратного прокси. По умолчанию выключено: используется адрес
// сокета напрямую, иначе любой, подделывая заголовок XFF, сможет «менять IP» при каждой
// попытке, и лимит частоты станет бесполезен.
// Включать явно только когда шлюз действительно стоит за доверенным обратным прокси (Nginx/Traefik…).
let TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function setTrustProxy(value) {
  TRUST_PROXY = value === true || value === '1' || value === 'true';
}

function getTrustProxy() {
  return TRUST_PROXY;
}

/** Нормализация строки IP: убираем префикс IPv4-mapped IPv6, порт, квадратные скобки; не-IP сводим к unknown */
function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (!ip) return '';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return net.isIP(ip) ? ip : '';
}

/**
 * Разбор IP клиента для лимита частоты.
 * Только при включённом TRUST_PROXY используется X-Forwarded-For; иначе всегда адрес сокета.
 * Даже доверяя прокси, берём первый хоп за пределами доверенной цепочки (здесь упрощено:
 * самый правый корректный IP), чтобы подделанное клиентом значение в начале строки
 * не принималось за реальный источник.
 */
function resolveClientIp(req) {
  const direct = normalizeIp(req && req.socket && req.socket.remoteAddress) || 'unknown';
  if (!TRUST_PROXY) return direct;

  const header = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || !header.trim()) return direct;

  const parts = header.split(',').map(s => normalizeIp(s)).filter(Boolean);
  if (parts.length === 0) return direct;
  // Берём самый правый (ближайший к хосту, записанный доверенным прокси)
  return parts[parts.length - 1];
}

function isAuthEnabled() {
  return AUTH_TOKEN.length > 0;
}

// Код доступа не задан ⇒ обязателен мастер инициализации (режима «проход без пароля» больше нет)
function isSetupRequired() {
  return !isAuthEnabled();
}

// Чёрный список распространённых слабых паролей (минимальное препятствие, в паре с подсказками на фронтенде)
const WEAK_PASSWORDS = new Set([
  'admin', 'administrator', 'password', 'passw0rd', '123456', '12345678', '123456789',
  '1234567890', 'qwertyuiop', '111111', '11111111', '000000', '00000000', '888888', '88888888',
  '666666', 'deepseek', 'admin123', 'root', 'letmein', 'changeme'
]);

/** Слабый ли пароль (длина < 6 или входит в чёрный список) */
function isWeakPassword(pwd) {
  if (typeof pwd !== 'string') return true;
  const p = pwd.trim();
  if (p.length < 6 || p.length > 256) return true;
  return WEAK_PASSWORDS.has(p.toLowerCase());
}

// Сравнение за константное время: сначала HMAC-SHA256, затем сравнение дайджестов фиксированной длины,
// чтобы «неравенство длин → немедленный возврат» не выдавало длину пароля через время выполнения (незначительный момент).
const COMPARE_KEY = crypto.randomBytes(32);
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest();
  const hb = crypto.createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Запрос идёт по HTTPS (прямой TLS или доверенный прокси заявил x-forwarded-proto=https) */
function isSecureRequest(req) {
  if (!req) return false;
  try {
    if (req.socket && req.socket.encrypted) return true;
    const proto = req.headers && req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') return true;
  } catch {}
  return false;
}

function checkRateLimit(clientIp) {
  const now = Date.now();
  const record = failedAttempts.get(clientIp);
  if (!record) return { allowed: true };

  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      allowed: false,
      error: `Слишком много попыток входа, повторите через ${remainingSeconds} с`
    };
  }

  // Reset if window has passed (сброс, если окно истекло)
  if (record.lockedUntil && now >= record.lockedUntil) {
    failedAttempts.delete(clientIp);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordAuthAttempt(clientIp, success) {
  if (success) {
    failedAttempts.delete(clientIp);
    return;
  }

  const now = Date.now();
  const record = failedAttempts.get(clientIp) || { count: 0, firstAttempt: now, lockedUntil: 0 };
  record.count += 1;
  record.lastSeen = now;

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_WINDOW_MS;
  }

  failedAttempts.set(clientIp, record);
  sweepExpiredAttempts(now);
}

/**
 * Очистка устаревших записей: удаляются записи, у которых срок блокировки прошёл и дольше TTL
 * не появлялись снова. Очистка выполняется попутно при каждой фиксации неуспешной попытки
 * (O(n), но только на пути ошибки и под защитой порога), чтобы таблица лимита не разрасталась
 * бесконечно из-за поддельных атак множеством IP (TTL как страховка).
 */
function sweepExpiredAttempts(now) {
  if (failedAttempts.size < 1000) return;
  for (const [ip, entry] of failedAttempts) {
    const expiredLock = !entry.lockedUntil || entry.lockedUntil < now;
    const stale = !entry.lastSeen || (now - entry.lastSeen) > ATTEMPT_TTL_MS;
    if (expiredLock && stale) failedAttempts.delete(ip);
  }
}

/** Только для диагностики/тестов: число записей в таблице лимита частоты */
function getRateLimitTableSize() {
  return failedAttempts.size;
}

function verifyToken(tokenInput) {
  if (!isAuthEnabled()) return true;
  if (!tokenInput || typeof tokenInput !== 'string') return false;
  return safeEqual(tokenInput, AUTH_TOKEN);
}

function signSession() {
  const ts = Date.now().toString();
  const payload = `${ts}:${AUTH_TOKEN}`;
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  return `${ts}.${sig}`;
}

function verifySession(sessionCookie) {
  if (!isAuthEnabled()) return true;
  if (!sessionCookie || typeof sessionCookie !== 'string') return false;

  const parts = sessionCookie.split('.');
  if (parts.length !== 2) return false;

  const [ts, sig] = parts;
  const time = Number(ts);
  const now = Date.now();

  // Validate timestamp format and limits (allow 60s clock skew)
  if (!Number.isSafeInteger(time) || time <= 0) return false;
  if (time - now > 60000) return false; // Token from future
  if (now - time > COOKIE_MAX_AGE * 1000) return false; // Expired

  const payload = `${ts}:${AUTH_TOKEN}`;
  const expectedSig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  return safeEqual(sig, expectedSig);
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const k = parts[0].trim();
      const v = parts.slice(1).join('=').trim();
      try {
        list[k] = decodeURIComponent(v);
      } catch {
        list[k] = v;
      }
    }
  });
  return list;
}

function checkRequestAuth(req) {
  if (!isAuthEnabled()) return true;

  // 1. Check Bearer / Token header if API caller
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (verifyToken(bearerToken)) return true;
  }

  // 2. Check custom header
  const customToken = req.headers['x-dsh-auth-token'];
  if (typeof customToken === 'string' && verifyToken(customToken.trim())) {
    return true;
  }

  // 3. Check cookie
  const cookies = parseCookies(req.headers['cookie']);
  const sessionCookie = cookies[COOKIE_NAME];
  return verifySession(sessionCookie);
}

function setAuthCookie(res, req) {
  const sessionVal = signSession();
  // SameSite=Strict полностью предотвращает CSRF и Cross-Site WebSocket Hijacking (CSWSH)
  // Незначительно: по HTTPS добавляем Secure, чтобы сессионная cookie не ходила открытым каналом
  const secureFlag = isSecureRequest(req) ? '; Secure' : '';
  const cookieStr = `${COOKIE_NAME}=${encodeURIComponent(sessionVal)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secureFlag}`;
  res.setHeader('Set-Cookie', cookieStr);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

module.exports = {
  isAuthEnabled,
  isSetupRequired,
  isWeakPassword,
  isSecureRequest,
  verifyToken,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie,
  checkRateLimit,
  recordAuthAttempt,
  resolveClientIp,
  setTrustProxy,
  getTrustProxy,
  normalizeIp,
  getRateLimitTableSize,
  updateAuthToken,
  getAuthToken,
  getSigningSecret,
  COOKIE_NAME
};
