#!/usr/bin/env node
/**
 * Этап 5 (границы доверия), локальный юнит-тест:
 *   M1  IP для лимита частоты больше не доверяет X-Forwarded-For (если TRUST_PROXY не включён
 *       явно), а таблица лимита имеет TTL-очистку
 *   M2  проверка WebSocket Origin больше не использует x-forwarded-host
 *   M14 /__internal/desktop/* требует «loopback-источник + общий внутренний ключ»
 *
 * Запуск: node scripts/trust-boundary-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

// ── Изоляция окружения: заставляем auth.js писать ключ подписи во временный каталог,
// настоящий /root/.dsh не трогаем ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trust-'));
process.env.DSH_DIR = tmp;
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef';
process.env.AUTH_TOKEN = 'unit-test-token';
delete process.env.TRUST_PROXY;
delete process.env.DSH_INTERNAL_TOKEN_FILE;

const auth = require(path.join(ROOT, 'gateway/auth.js'));
const wsOrigin = require(path.join(ROOT, 'gateway/ws-origin.js'));

function fakeReq({ remote = '203.0.113.9', headers = {} } = {}) {
  return { socket: { remoteAddress: remote }, headers };
}

console.log('\n[M1] Разбор IP для лимита частоты (XFF по умолчанию не доверяем)');
check('по умолчанию X-Forwarded-For игнорируется, берётся адрес сокета', () => {
  auth.setTrustProxy(false);
  const ip = auth.resolveClientIp(fakeReq({ remote: '203.0.113.9', headers: { 'x-forwarded-for': '1.2.3.4' } }));
  assert.equal(ip, '203.0.113.9');
});
check('подделанный XFF не меняет ключ лимита (много раундов — всё тот же IP)', () => {
  auth.setTrustProxy(false);
  const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'].map(x =>
    auth.resolveClientIp(fakeReq({ remote: '198.51.100.7', headers: { 'x-forwarded-for': x } })));
  assert.deepEqual(new Set(ips), new Set(['198.51.100.7']));
});
check('при явном TRUST_PROXY берётся самый правый XFF (та запись, что добавил доверенный прокси)', () => {
  auth.setTrustProxy(true);
  const ip = auth.resolveClientIp(fakeReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' } }));
  assert.equal(ip, '7.7.7.7');
  auth.setTrustProxy(false);
});
check('при TRUST_PROXY, когда весь XFF — мусор, откат к адресу сокета', () => {
  auth.setTrustProxy(true);
  const ip = auth.resolveClientIp(fakeReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': 'not-an-ip, ???' } }));
  assert.equal(ip, '127.0.0.1');
  auth.setTrustProxy(false);
});
check('IPv4-mapped IPv6 / с портом / с квадратными скобками нормализуются', () => {
  assert.equal(auth.normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(auth.normalizeIp('10.0.0.5:443'), '10.0.0.5');
  assert.equal(auth.normalizeIp('[::1]'), '::1');
  assert.equal(auth.normalizeIp('garbage'), '');
});
check('после 5 неудач наступает блокировка, верный пароль снимает её', () => {
  const ip = '192.0.2.1';
  for (let i = 0; i < 5; i++) auth.recordAuthAttempt(ip, false);
  assert.equal(auth.checkRateLimit(ip).allowed, false);
  auth.recordAuthAttempt(ip, true);
  assert.equal(auth.checkRateLimit(ip).allowed, true);
});
check('таблица лимита имеет TTL-очистку (куча просроченных записей не остаётся навсегда)', () => {
  // Делаем >1000 записей «не заблокированных и давно просроченных», затем триггерим
  // одну неудачную попытку, чтобы запустилась очистка
  const RealNow = Date.now;
  const t0 = RealNow();
  const keys = [];
  for (let i = 0; i < 1200; i++) {
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    keys.push(ip);
    auth.recordAuthAttempt(ip, false);
  }
  assert.ok(auth.getRateLimitTableSize() >= 1000, 'предусловие: в таблице уже накоплено много записей');
  // «Отматываем» время вперёд на 20 минут, чтобы все записи вышли за TTL
  Date.now = () => t0 + 20 * 60 * 1000;
  try {
    auth.recordAuthAttempt('10.99.99.99', false);
  } finally {
    Date.now = RealNow;
  }
  const size = auth.getRateLimitTableSize();
  assert.ok(size < 100, 'просроченные записи обязаны вычиститься по TTL, остаток=' + size);
});

console.log('\n[M2] Проверка WebSocket Origin (x-forwarded-host не доверяем)');
check('same-origin (Origin == Host) пропускается', () => {
  const req = fakeReq({ remote: '198.51.100.20', headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), true);
});
check('подделанный x-forwarded-host больше не обманывает проверку (ключевая регрессия)', () => {
  const req = fakeReq({
    remote: '198.51.100.20',
    headers: { host: 'dsh.example.com', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' }
  });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false);
});
check('чужой сайт Origin отклоняется', () => {
  const req = fakeReq({ remote: '198.51.100.20', headers: { host: 'dsh.example.com', origin: 'http://evil.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false);
});
check('работает whitelist настроенных внешних имён хоста', () => {
  const req = fakeReq({ remote: '198.51.100.20', headers: { host: '127.0.0.1:3080', origin: 'https://dsh.example.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false);
  assert.equal(wsOrigin.isAllowedWsOrigin(req, ['dsh.example.com']), true);
});
check('источники не-http(s) отклоняются (file:// / null / chrome-extension://)', () => {
  for (const origin of ['file:///etc/passwd', 'chrome-extension://abc', 'null']) {
    const req = fakeReq({ headers: { host: 'dsh.example.com', origin } });
    assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false, origin + ' должен отклоняться');
  }
});
check('без Origin (не-браузерный клиент) пропускается', () => {
  const req = fakeReq({ headers: { host: 'dsh.example.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), true);
});
check('loopback-источник допускает варианты localhost / 127.0.0.1', () => {
  const ok = fakeReq({ remote: '127.0.0.1', headers: { host: '127.0.0.1:3080', origin: 'http://localhost:3080' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(ok, []), true);
  const bad = fakeReq({ remote: '203.0.113.5', headers: { host: 'dsh.example.com', origin: 'http://localhost:3080' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(bad, []), false);
});

console.log('\n[M14] Общий ключ внутренних интерфейсов');
const tokenFile = path.join(tmp, '.internal-api-token');
process.env.DSH_INTERNAL_TOKEN_FILE = tokenFile;
const internalToken = require(path.join(ROOT, 'gateway/internal-token.js'));

check('первый вызов генерирует ключ и сохраняет его на диск с правами 0600', () => {
  const t = internalToken.getInternalToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(tokenFile), 'файл ключа должен существовать');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, 'права обязаны быть 0600');
});
check('ключ персистентен: повторное чтение совпадает (после перезапуска шлюза плагин работает)', () => {
  const t1 = internalToken.getInternalToken();
  const t2 = internalToken.readToken();
  assert.equal(t1, t2);
});
check('запрос с корректным ключом проходит проверку', () => {
  const t = internalToken.getInternalToken();
  assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': t } }), true);
});
check('отсутствующий / неверный / пустой ключ всегда отклоняется', () => {
  assert.equal(internalToken.verifyInternalToken({ headers: {} }), false);
  assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': 'deadbeef' } }), false);
  assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': '' } }), false);
  assert.equal(internalToken.verifyInternalToken({}), false);
});

console.log('\n[M14] Регрессия исходников шлюза: внутренние интерфейсы обязаны требовать одновременно loopback + ключ');
check('index.js больше не определяет loopback через фиксированный список строк', () => {
  const src = fs.readFileSync(path.join(ROOT, 'gateway/index.js'), 'utf8');
  assert.ok(!/includes\(req\.socket\.remoteAddress\)/.test(src), 'не должно использоваться includes(remoteAddress) для определения loopback');
  assert.ok(/verifyInternalToken\(req\)/.test(src), 'внутренние интерфейсы должны проверять внутренний ключ');
});
check('проверка WS Origin в index.js делегирована модулю ws-origin', () => {
  const src = fs.readFileSync(path.join(ROOT, 'gateway/index.js'), 'utf8');
  assert.ok(/wsOrigin\.isAllowedWsOrigin\(req, PUBLIC_HOSTS\)/.test(src));
  assert.ok(!/req\.headers\['x-forwarded-host'\]/.test(src), 'index.js не должен читать x-forwarded-host');
});

console.log(`\nРезультат: ${pass} пройдено, ${fail} провалено`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
