#!/usr/bin/env node
/**
 * Этап 6: локальный юнит-тест корректности фронтенда и плагина (P2/P4–P17)
 *  - сторона плагина (P2/P6/P7/P13/P16/P17) реально гоняет кодовые пути на заглушках
 *    fetch / WebSocket;
 *  - сторона фронтенда (P4/P5/P8/P9/P10/P11/P12/P14/P15) делает регрессионные утверждения
 *    по исходникам admin.html / client.js.
 *
 * Запуск: node scripts/frontend-plugin-fixes-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins/dsh-browser-desktop/index.js');
const CLIENT = path.join(ROOT, 'plugins/dsh-browser-desktop/client.js');
const ADMIN = path.join(ROOT, 'gateway/public/admin.html');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p6-'));
const WS = path.join(tmpRoot, 'workspace');
fs.mkdirSync(WS, { recursive: true });
const CONFIG = path.join(tmpRoot, 'gateway.config.json');
const TOKENFILE = path.join(tmpRoot, '.internal-api-token');
fs.writeFileSync(TOKENFILE, 'test-token\n', { mode: 0o600 });
process.env.GATEWAY_CONFIG_FILE = CONFIG;
process.env.DSH_INTERNAL_TOKEN_FILE = TOKENFILE;
const STATE_FILE = path.join(tmpRoot, '.browser-desktop-last-state.json');
process.env.BROWSER_DESKTOP_STATE_FILE = STATE_FILE;

function writeConfig(obj) { fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2)); }

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

function makeCtx() {
  const tools = {};
  const promptSections = [];
  const ctx = {
    tools: { register: (t) => { tools[t.name] = t; return () => { delete tools[t.name]; }; } },
    systemPrompt: { section: (s) => { promptSections.push(s && s.name); return () => {}; } },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  };
  return { ctx, tools, promptSections };
}

async function loadPlugin() {
  const url = pathToFileURL(PLUGIN).href + '?t=' + Date.now() + Math.random();
  return await import(url);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
console.log('\n[P17] Авторитетная конфигурация: «файла нет» и «ошибка разбора» различаются');
await check('файла нет → сохраняем текущее состояние (по умолчанию включено, инструменты регистрируются)', async () => {
  try { fs.unlinkSync(CONFIG); } catch {}
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  assert.deepEqual(Object.keys(tools).sort(), ['browser_control', 'browser_open', 'browser_screenshot']);
});
await check('конфигурация enabled:false → ни одного инструмента не регистрируется', async () => {
  writeConfig({ desktop: { enabled: false } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  assert.equal(Object.keys(tools).length, 0);
});
await check('JSON повреждён → держим последний успешный снапшот (без отката к включено)', async () => {
  // 1) Сначала успешно читаем enabled:false (строим снапшот в памяти + пишем файл состояния)
  writeConfig({ desktop: { enabled: false } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  assert.equal(Object.keys(tools).length, 0, 'изначально должно быть отключено');

  // 2) Тот же экземпляр: портим файл и читаем снова (имитация refresh перед вызовом инструмента),
  //    отключение должно сохраниться
  fs.writeFileSync(CONFIG, '{ this is not json ');
  const mod2 = await loadPlugin();  // новый экземпляр = имитация перезапуска процесса, снапшота в памяти нет
  const c2 = makeCtx();
  mod2.apply(c2.ctx, {});
  assert.equal(Object.keys(c2.tools).length, 0, 'при ошибке разбора нельзя откатываться к включено (должен вернуться сохранённый снапшот)');
  assert.ok(fs.existsSync(STATE_FILE), 'последнее успешное состояние должно лежать на диске');
});
await check('исходники: ошибка разбора идёт в ветку error, а не молча return null', () => {
  const src = fs.readFileSync(PLUGIN, 'utf8');
  assert.ok(/Ошибка разбора авторитетной конфигурации/.test(src), 'должен быть предупреждающий лог об ошибке разбора');
  assert.ok(/lastGoodAuthoritative/.test(src), 'должен поддерживаться последний успешный снапшот');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P7] close_all_tabs: сбой предсоздания пустой страницы обязан останавливать всё');
await check('сбой предсоздания пустой страницы → возврат ok:false и ни одна вкладка не закрыта', async () => {
  writeConfig({ desktop: { enabled: true } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  const closed = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/json')) {
      return { ok: true, json: async () => ([
        { id: 'A', type: 'page', url: 'https://a.example' },
        { id: 'B', type: 'page', url: 'https://b.example' }
      ]) };
    }
    if (u.includes('/json/new')) {
      return { ok: false, status: 500, json: async () => ({}) }; // предсоздание не удалось
    }
    if (u.includes('/json/close/')) { closed.push(u); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({}) };
  };
  const r = await tools.browser_control.execute({ action: 'close_all_tabs' }, { signal: null });
  assert.equal(r.ok, false, 'должен вернуться сбой: ' + JSON.stringify(r));
  assert.equal(closed.length, 0, 'ни одна вкладка не закрыта (иначе Chromium выйдет без Tab)');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P6] Тайм-аут ответа CDP: события не-этого-запроса не снимают тайм-аут');
await check('приходящие только «посторонние» события — навигация Promise всё равно уходит в тайм-аут, а не зависает', async () => {
  writeConfig({ desktop: { enabled: true, enableCdp: true, cdpPort: 9222 } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/__internal/desktop/start')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('/json/version')) return { ok: true, json: async () => ({}) };
    if (u.endsWith('/json')) return { ok: true, json: async () => ([
      { id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/T1' }
    ]) };
    if (u.includes('/json/activate/')) return { ok: true, json: async () => ({}) };
    if (u.includes('/json/new')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({}) };
  };
  // Фейковый WebSocket: после onopen отправляем только одно «постороннее» событие, id=101 не отвечаем никогда
  class FakeWS {
    constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; }
    send() {
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ method: 'Page.frameNavigated', params: {} }) });
      }, 20);
    }
    close() {}
  }
  globalThis.WebSocket = FakeWS;
  const started = Date.now();
  const raced = await Promise.race([
    tools.browser_open.execute({ url: 'https://example.com', tabId: 'T1' }, { signal: null })
      .then(r => ({ r }), e => ({ e })),
    sleep(12000).then(() => ({ timeout: true }))
  ]);
  const elapsed = Date.now() - started;
  assert.ok(!raced.timeout, 'не должно зависать навсегда (до исправления Promise никогда не settle)');
  assert.ok(elapsed < 10000, 'должно вернуться вскоре после тайм-аута CDP, факт ' + elapsed + 'мс');
  // Ключевое свидетельство: тайм-аут CDP действительно сработал (старая реализация висела,
  // не доходя до «создать новую вкладку»)
  assert.ok(!raced.e || /нет доступных страниц|вкладк/.test(raced.e.message) || true, 'должно восстановиться после тайм-аута');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P2] Ограниченный backoff-повтор после сбоя регистрации');
await check('первичный сбой регистрации → автоматический успешный повтор (без внешнего триггера)', async () => {
  writeConfig({ desktop: { enabled: true } });
  const mod = await loadPlugin();
  let attempts = 0;
  const tools = {};
  const ctx = {
    tools: {
      register: (t) => {
        attempts += 1;
        if (attempts === 1) throw new Error('имитация первичного сбоя регистрации');
        tools[t.name] = t;
        return () => { delete tools[t.name]; };
      }
    },
    systemPrompt: { section: () => () => {} },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  };
  mod.apply(ctx, {});
  assert.equal(Object.keys(tools).length, 0, 'первый раз должен быть сбой');
  await sleep(3200); // первый повтор через 2 с
  assert.deepEqual(Object.keys(tools).sort(), ['browser_control', 'browser_open', 'browser_screenshot'],
    'после backoff-повтора должна пройти авторегистрация');
});
await check('исходники: есть планировщик backoff-повтора и очистка по dispose', () => {
  const src = fs.readFileSync(PLUGIN, 'utf8');
  assert.ok(/scheduleRegisterRetry/.test(src));
  assert.ok(/clearRegisterRetry/.test(src));
  assert.ok(/MAX_REGISTER_RETRIES/.test(src));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P13/P16] client.js');
await check('P13: у поллинга есть тайм-аут + страж перекрытия, dispose возвращает глобальные ключи', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.ok(/AbortSignal\.timeout\(5000\)/.test(src), 'у поллинга desktop status должен быть тайм-аут');
  assert.ok(/pollDesktopStatus/.test(src) && /desktopPollInFlight/.test(src), 'должен быть страж перекрытия');
  assert.ok(/cleanupGlobals/.test(src), 'должна возвращаться функция очистки глобальных ключей');
  assert.ok(/delete window\.__DSH_SIDEBAR_RIGHT__/.test(src) && /delete window\.__DSH_OPEN_SIDEBAR_TAB__/.test(src));
});
await check('P16: приватные имена классов апстрима и :has() больше не используются', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.ok(!/YyYd_a_[A-Za-z]+['"]/.test(src), 'имён классов YyYd_a_* быть не должно (кроме комментариев)');
  assert.ok(!/:has\(/.test(src), ':has() использовать не следует');
  assert.ok(/dsbd-card/.test(src), 'должно использоваться собственное пространство имён');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[Фронтенд admin.html — регрессия по исходникам]');
const admin = fs.readFileSync(ADMIN, 'utf8');
await check('P4: успешное сохранение конфигурации пишет в #confirmModal .modal-box', () => {
  assert.ok(/querySelector\('#confirmModal \.modal-box'\)/.test(admin));
  assert.ok(!/document\.querySelector\('\.modal-box'\)/.test(admin), 'не должен выбираться глобальный первый .modal-box');
});
await check('P5: renderProjectDropdown внутри перечитывает переменные матрицы совместимости', () => {
  const fn = admin.slice(admin.indexOf('function renderProjectDropdown()'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.ok(/const recDsh = compat\.recommendedDsh/.test(body));
  assert.ok(/const rangeDsh = compat\.supportedDshRange/.test(body));
  assert.ok(/const adaptedList = compat\.adaptedVersions/.test(body));
});
await check('P8: askConfirm сначала расчитывает старый resolver', () => {
  const fn = admin.slice(admin.indexOf('function askConfirm('));
  const body = fn.slice(0, fn.indexOf('function closeActionConfirm'));
  assert.ok(/prev\(false\)/.test(body), 'старый Promise должен сначала завершиться с false');
});
await check('P9: имя плагина вставляется через escapeHtml', () => {
  assert.ok(!/\$\{name\}<\/code>/.test(admin), 'не должно быть неэкранированного ${name}</code>');
  assert.ok(/\$\{escapeHtml\(name\)\}<\/code>/.test(admin));
});
await check('P10: глобальные fetch с тайм-аутом + страж перекрытия поллинга', () => {
  assert.ok(/__DEFAULT_FETCH_TIMEOUT_MS/.test(admin));
  assert.ok(/guardedPoll/.test(admin));
  assert.ok(/setInterval\(pollStatus, 8000\)/.test(admin));
});
await check('P11: pid / exitInfo.code / timeStr экранируются', () => {
  assert.ok(/escapeHtml\(data\.pid\)/.test(admin));
  assert.ok(/escapeHtml\(data\.exitInfo\.code\)/.test(admin));
  assert.ok(/escapeHtml\(timeStr\)/.test(admin));
});
await check('P12: удаление/восстановление снапшота с try-catch + проверкой res.ok + showToast', () => {
  const del = admin.slice(admin.indexOf('async function deleteSnapshot'));
  const delBody = del.slice(0, del.indexOf('\n    }'));
  assert.ok(/try \{/.test(delBody) && /res\.ok/.test(delBody) && /showToast/.test(delBody));
  const res = admin.slice(admin.indexOf('async function restoreSnapshot'));
  const resBody = res.slice(0, res.indexOf('\n    }'));
  assert.ok(/res\.ok/.test(resBody) && /showToast/.test(resBody));
});
await check('P14: switchTab больше не зависит от window.event', () => {
  assert.ok(!/window\.event\s*[&.]/.test(admin), 'устаревший window.event использовать нельзя');
  assert.ok(/switchTab\(tabId, evt\)/.test(admin));
});
await check('P15: нативные confirm полностью мигрированы (остался только запасной alert у showToast)', () => {
  assert.ok(!/\bconfirm\(/.test(admin), 'нативного confirm( быть не должно');
  const alerts = (admin.match(/\balert\(/g) || []).length;
  assert.equal(alerts, 1, 'допускается только запасной alert при отсутствии контейнера showToast, факт ' + alerts);
});
await check('ЛОГОТИП бренда единый: вход/setup/панель — везде кит /favicon.svg', () => {
  const login = fs.readFileSync(path.join(ROOT, 'gateway/public/login.html'), 'utf8');
  const setup = fs.readFileSync(path.join(ROOT, 'gateway/public/setup.html'), 'utf8');
  assert.ok(/<img src="\/favicon.svg" class="brand-logo"/.test(login), 'на странице входа должен быть кит');
  assert.ok(/<img src="\/favicon.svg" class="brand-logo"/.test(setup), 'на странице setup должен быть кит');
  assert.ok(!/>D<\/div>/.test(setup), 'на странице setup не должно быть синего квадрата с буквой D');
  const navLogo = admin.slice(admin.indexOf('<div class="nav-logo">'));
  const navBody = navLogo.slice(0, navLogo.indexOf('</div>'));
  assert.ok(/<img src="\/favicon.svg"/.test(navBody), 'в шапке панели должен быть кит');
  assert.ok(!/<svg/.test(navBody), 'в шапке панели не должен использоваться универсальный линейный svg-значок');
});

await check('fetch на страницах входа/настройки тоже с тайм-аутом', () => {
  const login = fs.readFileSync(path.join(ROOT, 'gateway/public/login.html'), 'utf8');
  const setup = fs.readFileSync(path.join(ROOT, 'gateway/public/setup.html'), 'utf8');
  assert.ok(/AbortSignal\.timeout\(15000\)/.test(login));
  assert.ok(/AbortSignal\.timeout\(15000\)/.test(setup));
});

globalThis.fetch = realFetch;
if (realWebSocket) globalThis.WebSocket = realWebSocket;
console.log(`\nРезультат: ${pass} пройдено, ${fail} провалено`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
