#!/usr/bin/env node
/**
 * Этап 7: локальный юнит-тест инженерии и полировки (M10–M13 + мелкие пункты)
 *  - выполнимые части: тайм-аут/лимит вывода runTarAsync, atomicWrite, safeEqual(HMAC),
 *    Cookie Secure, isSecureRequest;
 *  - остальное фиксируется утверждениями по исходникам (Dockerfile / compose / workflow / gateway / entrypoint).
 *
 * Запуск: node scripts/phase7-hardening-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p7-'));
process.env.DSH_DIR = tmp;
process.env.SESSION_SECRET = 'phase7-test-secret-0123456789';
process.env.AUTH_TOKEN = 'phase7-token';

// ─────────────────────────────────────────────────────────────
console.log('\n[Мелкие пункты] Выполнимая на лету проверка');
await check('runTarAsync: превышение времени принудительно прерывается и выводит ошибку', async () => {
  const backup = require(path.join(ROOT, 'gateway/backup-service.js'));
  assert.equal(typeof backup.runTarAsync, 'function', 'runTarAsync должен экспортироваться для теста');
  const t0 = Date.now();
  const err = await backup.runTarAsync(['-cf', '/dev/null', '--use-compress-program=sleep 30', '.'], { timeoutMs: 1200 })
    .then(() => null, e => e);
  assert.ok(err, 'должно завершиться ошибкой тайм-аута');
  assert.match(err.message, /превышено время/);
  assert.ok(Date.now() - t0 < 8000, 'должно быть прервано вовремя');
});

await check('runTarAsync: выход за лимит вывода обрывается (защита от раздувания памяти враждебным архивом)', async () => {
  const backup = require(path.join(ROOT, 'gateway/backup-service.js'));
  // Создаём каталог с очень большим числом членов, чтобы вывод tar -t превысил 1 КБ
  const dir = path.join(tmp, 'many');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x');
  const tarFile = path.join(tmp, 'many.tar.gz');
  await backup.runTarAsync(['-czf', tarFile, '-C', dir, '.']);
  const err = await backup.runTarAsync(['-tvzf', tarFile], { maxOutputBytes: 1024 }).then(() => null, e => e);
  assert.ok(err, 'должно завершиться ошибкой превышения лимита вывода');
  assert.match(err.message, /превышен лимит вывода/);
});

await check('_bootInternal-обёртка: рассчитывается по явному resolve реализации (не перекрывается ранним undefined)', async () => {
  const mgr = require(path.join(ROOT, 'gateway/dsh-manager.js'));
  const orig = mgr._bootInternalImpl;
  try {
    mgr._bootInternalImpl = async (onProbe, resolve) => {
      // Имитация «тело функции возвращается, а resolve вызывается позже во вложенном колбэке»
      setTimeout(() => resolve({ ok: true, marker: 'late-resolve' }), 40);
    };
    const r = await mgr._bootInternal();
    assert.equal(r && r.marker, 'late-resolve', 'должен ждать явного resolve реализации, а не вернуть undefined заранее');
  } finally { mgr._bootInternalImpl = orig; }
});

await check('safeEqual переведён на HMAC (при разной длине тоже не возвращается раньше времени)', () => {
  const auth = require(path.join(ROOT, 'gateway/auth.js'));
  // Через verifyToken косвенно проверяем, что поведение по-прежнему корректно
  assert.equal(auth.verifyToken('phase7-token'), true);
  assert.equal(auth.verifyToken('phase7-toke'), false);
  assert.equal(auth.verifyToken('phase7-token-longer'), false);
  assert.equal(auth.verifyToken(''), false);
  const src = read('gateway/auth.js');
  assert.ok(/createHmac\('sha256', COMPARE_KEY\)/.test(src), 'safeEqual должен сначала HMAC, затем сравнивать');
});

await check('Cookie Secure: флаг Secure добавляется только запросам HTTPS', () => {
  const auth = require(path.join(ROOT, 'gateway/auth.js'));
  assert.equal(auth.isSecureRequest({ socket: {}, headers: {} }), false);
  assert.equal(auth.isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
  assert.equal(auth.isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(auth.isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'http' } }), false);

  const grab = (req) => {
    const headers = {};
    auth.setAuthCookie({ setHeader: (k, v) => { headers[k] = v; } }, req);
    return headers['Set-Cookie'];
  };
  const plain = grab({ socket: {}, headers: {} });
  const secure = grab({ socket: {}, headers: { 'x-forwarded-proto': 'https' } });
  assert.ok(/HttpOnly/.test(plain) && /SameSite=Strict/.test(plain));
  assert.ok(!/; Secure/.test(plain), 'по HTTP не должно быть Secure');
  assert.ok(/; Secure/.test(secure), 'по HTTPS должно быть Secure');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M12] Контекст сборки и зависимости плагинов');
await check('.dockerignore существует и исключает ключевые каталоги', () => {
  const di = read('.dockerignore');
  for (const k of ['.git', '.env', 'data/', 'workspace/', '**/node_modules', 'doc/']) {
    assert.ok(di.includes(k), '.dockerignore должен содержать ' + k);
  }
});
await check('плагин явно объявляет зависимость schemastery', () => {
  const pkg = JSON.parse(read('plugins/dsh-browser-desktop/package.json'));
  assert.ok(pkg.dependencies && pkg.dependencies['@deepseek-ai/schemastery'], 'должна быть объявлена @deepseek-ai/schemastery');
});
await check('Dockerfile явно создаёт симлинк зависимости плагина (больше не полагается на остатки сборки)', () => {
  const df = read('Dockerfile');
  assert.ok(/node_modules\/@deepseek-ai/.test(df), 'Dockerfile должен создать для плагина симлинк @deepseek-ai');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M10] Цепочка поставок');
await check('version.json фиксирует версии dsh / pnpm / плагинов маркетплейса', () => {
  const v = JSON.parse(read('version.json'));
  assert.ok(v.supply && v.supply.dshVersion && v.supply.pnpmVersion, 'блок supply обязан содержать dshVersion/pnpmVersion');
  assert.ok(v.supply.marketPlugins && v.supply.marketPlugins.dshmarket);
});
await check('plugins.market.list: предустановленные плагины все идут на @latest', () => {
  const lines = read('plugins.market.list').split('\n')
    .map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(lines.length >= 2);
  // Все намеренно пишутся в @latest: при каждой сборке тянется последняя версия
  // (совместно с MARKET_REFRESH в Dockerfile обновляет слой кэша предустановок)
  for (const l of lines) {
    assert.match(l, /@latest$/, 'должно быть @latest: ' + l);
  }
});
await check('Dockerfile: --ignore-scripts + whitelist-rebuild + проверка integrity', () => {
  const df = read('Dockerfile');
  assert.ok(/--ignore-scripts/.test(df), 'должно использоваться --ignore-scripts');
  assert.ok(!/--ignore-scripts=false/.test(df), 'не должно оставаться --ignore-scripts=false');
  assert.ok(!/allow-scripts all/.test(df), 'allow-scripts не должен открываться глобально');
  assert.ok(/dist\.integrity/.test(df), 'должна проверяться dist.integrity');
  assert.ok(/npm rebuild node-pty/.test(df), 'rebuild по белому списку');
});
await check('build.sh читает фиксированные версии из version.json#supply', () => {
  const bs = read('build.sh');
  assert.ok(/read_supply/.test(bs) && /PNPM_VERSION/.test(bs));
  assert.ok(!/DSH_ALPHA=\$\(curl/.test(bs), 'версия DSH не должна определяться динамическим опросом registry');
});
await check('CI: экшены привязаны к SHA + provenance/sbom + дымовой тест', () => {
  const wf = read('.github/workflows/docker-build.yml');
  assert.ok(!/uses:\s+actions\/checkout@v4\b/.test(wf), 'экшен должен быть привязан к SHA');
  assert.ok(/actions\/checkout@[0-9a-f]{40}/.test(wf));
  assert.ok(/provenance:\s*mode=max/.test(wf));
  assert.ok(/sbom:\s*true/.test(wf));
  assert.ok(/smoke-test:/.test(wf) && /healthz/.test(wf));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M11] Укрепление контейнера');
await check('compose: no-new-privileges + cap_drop ALL + минимальный набор cap_add', () => {
  for (const f of ['docker-compose.yml', 'docker-compose.market.yml']) {
    const c = read(f);
    assert.ok(/no-new-privileges:true/.test(c), f + ' должен содержать no-new-privileges');
    assert.ok(/cap_drop:\s*\n\s*- ALL/.test(c), f + ' должен cap_drop ALL');
    assert.ok(/cap_add:/.test(c), f + ' должен возвращать минимальный набор capability');
    assert.ok(/user: "1001:1001"/.test(c), f + ' должен приводить пример non-root запуска');
  }
});
await check('Dockerfile: non-root пользователь dsh(uid 1000) и /go больше не 777', () => {
  const df = read('Dockerfile');
  assert.ok(/useradd -m -u 1001/.test(df), 'должен создаваться пользователь с uid 1001');
  assert.ok(/chmod -R 0755 \/go/.test(df), '/go должен быть 0755');
  assert.ok(!/chmod -R 777/.test(df), '777 больше не должно быть');
});
await check('шлюз/скрипты входа поддерживают перенос DSH_HOME (non-root развёртывание)', () => {
  for (const f of ['gateway/backup-service.js', 'gateway/dsh-manager.js', 'gateway/plugin-manager.js', 'gateway/internal-token.js']) {
    assert.ok(/DSH_HOME/.test(read(f)), f + ' должен поддерживать DSH_HOME');
  }
  const ep = read('scripts/entrypoint.sh');
  assert.ok(/DSH_HOME/.test(ep) && !/\/root\/\.dsh/.test(ep), 'entrypoint не должен жёстко кодировать /root/.dsh');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M13] Единый источник конфигурации');
await check('явный env имеет приоритет над сохранённой конфигурацией, а /healthz отдаёт источник', () => {
  const s = read('gateway/index.js');
  assert.ok(/const PROXY_PORT = Number\(process\.env\.PROXY_PORT \|\| persisted\.proxyPort\)/.test(s));
  assert.ok(/process\.env\.ADMIN_PATH \|\| persisted\.adminPath/.test(s));
  assert.ok(/AUTH_TOKEN_SOURCE/.test(s) && /configSource:/.test(s));
});
await check('разрешение по умолчанию совпадает с README/кодом (1920x1080)', () => {
  assert.ok(!/DSH_DESKTOP_WIDTH=1440/.test(read('.env.example')));
  assert.ok(/DSH_DESKTOP_WIDTH=1920/.test(read('.env.example')));
  assert.ok(!/DSH_DESKTOP_WIDTH=1440/.test(read('docker-compose.yml')));
  assert.ok(/DSH_DESKTOP_WIDTH=1920/.test(read('docker-compose.market.yml')));
});
await check('compose: проброс портов следует за PROXY_PORT', () => {
  assert.ok(/\$\{PROXY_PORT:-3080\}:\$\{PROXY_PORT:-3080\}/.test(read('docker-compose.yml')));
  assert.ok(/PROXY_PORT=\$\{PROXY_PORT:-3080\}/.test(read('docker-compose.market.yml')));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[Мелкие пункты] Регрессия по исходникам');
await check('больше нет анти-паттерна new Promise(async executor)', () => {
  for (const f of ['gateway/backup-service.js', 'gateway/dsh-manager.js']) {
    assert.ok(!/return new Promise\(async/.test(read(f)), f + ' всё ещё содержит анти-паттерн');
  }
});
await check('точное совпадение конечной точки websockify', () => {
  const s = read('gateway/index.js');
  assert.ok(!/pathname\.endsWith\('\/websockify'\)/.test(s));
  assert.ok(/pathname === vncWsPath \|\| pathname === '\/websockify'/.test(s));
});
await check('pkill больше не использует слишком широкое совпадение по chromium', () => {
  const s = read('gateway/desktop-manager.js');
  const body = s.slice(s.indexOf('async forceCleanupSystemProcesses()'));
  const patterns = body.slice(0, body.indexOf('_pkill(pattern)'));
  assert.ok(!/^\s*'chromium'\s*,/m.test(patterns), 'chromium не должен быть шаблоном pkill');
  assert.ok(/--user-data-dir=\$\{this\.config\.userDataDir\}/.test(patterns));
});
await check('журнал не выводит фрагменты содержимого Cookie', () => {
  const s = read('gateway/token-crawler.js');
  assert.ok(!/cookiePair\.slice\(0, 25\)/.test(s));
  assert.ok(/len=\$\{cookiePair\.length\}/.test(s));
});
await check('version-service больше не глотает исключения молча', () => {
  const s = read('gateway/version-service.js');
  assert.ok(/Ошибка чтения версии локального package\.json/.test(s));
  assert.ok(/Ошибка чтения локальных метаданных версии/.test(s));
});
await check('install-plugin использует атомарную запись', () => {
  const s = read('scripts/install-plugin.mjs');
  assert.ok(/function atomicWrite/.test(s));
  assert.ok(!/fs\.writeFileSync\(/.test(s.replace(/function atomicWrite[\s\S]*?\n}\n/, '')), 'кроме helper не должно оставаться голых writeFileSync');
  // Страж регрессии: helper обязан реально писать на диск и не вызывать сам себя рекурсивно
  // (бывало atomicWrite(tmp,data) сам в себе → переполнение стека)
  const helper = /function atomicWrite[\s\S]*?\n}\n/.exec(s);
  assert.ok(helper, 'должен находиться helper atomicWrite');
  assert.ok(/fs\.writeFileSync\(tmp/.test(helper[0]), 'внутри atomicWrite обязан быть fs.writeFileSync(tmp, ...) реально пишущий на диск');
  assert.ok(!/atomicWrite\(tmp/.test(helper[0]), 'atomicWrite не должен рекурсивно вызывать себя (будет Maximum call stack size exceeded)');
});
await check('журнал DSH пишется в том данных и ротируется', () => {
  const s = read('scripts/entrypoint.sh');
  assert.ok(/DSH_WEB_LOG:-.*\.dsh\/logs\/dsh-web\.log/.test(s));
  assert.ok(/DSH_WEB_LOG_MAX_BYTES/.test(s) && /mv -f "\$\{DSH_WEB_LOG\}"/.test(s));
});

console.log(`\nРезультат: ${pass} пройдено, ${fail} провалено`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
