/**
 * Сквозной тест «инструментного слоя плагина» внутри контейнера.
 * Напрямую загружает плагин dsh-browser-desktop, регистрирует инструменты на mock-ctx
 * и реально их вызывает, покрывая полный путь browser_open / browser_screenshot /
 * browser_control (плагин -> шлюз /__internal/desktop -> DesktopManager -> настоящий Chromium).
 *
 * Запуск в контейнере: node /app/scripts/plugin-tool-e2e.mjs
 */
const mod = await import('/app/plugins/dsh-browser-desktop/index.js');

// Общий ключ внутренних интерфейсов (M14): шлюз при старте создаёт файл 0600, скрипт
// в контейнере читает и подставляет его
import fs from 'node:fs';
const INTERNAL_TOKEN_FILE = process.env.DSH_INTERNAL_TOKEN_FILE || '/root/.dsh/.internal-api-token';
const internalHeaders = (extra = {}) => {
  const h = { 'Content-Type': 'application/json', ...extra };
  try {
    const t = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim();
    if (t) h['x-dsh-internal-token'] = t;
  } catch {}
  return h;
};

const tools = {};
const mockCtx = {
  tools: { register: (t) => { tools[t.name] = t; } },
  systemPrompt: { section: () => {} },
  settings: {
    register: () => ({ get: () => ({}), watch: () => {} }),
    section: () => undefined
  }
};
mod.apply(mockCtx, {});

function assert(cond, msg) {
  if (!cond) throw new Error('Ошибка утверждения: ' + msg);
  console.log('   ✔ ' + msg);
}

console.log('1. browser_open открывает страницу');
const open = await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login' }, { signal: null });
console.log('   tabId =', open.tabId, 'status =', open.status);
assert(open.tabId, 'browser_open вернул tabId');

console.log('2. browser_screenshot делает скриншот');
const shot = await tools.browser_screenshot.execute({ savePath: 'doc/plugin-e2e.png' }, { signal: null });
console.log('   path =', shot.path, 'bytes =', shot.bytes);
assert(shot.bytes > 0, 'browser_screenshot успешно создал скриншот');

console.log('3. Смена разрешения на ходу (прежний сценарий мёртвой блокировки через инструментную цепочку)');
const open2 = await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login', resolution: '1280x720' }, { signal: null });
console.log('   tabId =', open2.tabId, 'resolution =', open2.resolution);
assert(open2.resolution === '1280x720', 'разрешение переключено на 1280x720 (без мёртвой блокировки)');

console.log('4. browser_control tabs');
const tabs = await tools.browser_control.execute({ action: 'tabs' });
assert(tabs.ok && tabs.count >= 1, 'browser_control tabs вернул список вкладок');

console.log('5. browser_control close_all_tabs + stop');
await tools.browser_control.execute({ action: 'close_all_tabs' });
const stopped = await tools.browser_control.execute({ action: 'stop' });
assert(stopped.ok, 'browser_control stop успешен');

console.log('6. Admin «полностью отключить браузер» → плагин даёт ноль регистраций (R1: инструменты и промпт исчезают)');
const GW = `http://127.0.0.1:${process.env.PROXY_PORT || 3080}/__internal/desktop`;
const masterCall = async (enabled) => {
  const r = await fetch(`${GW}/master`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({ enabled })
  });
  return r.json();
};
const offRes = await masterCall(false);
assert(offRes.ok && offRes.enabled === false, 'главный переключатель Admin полностью отключил браузер');
await new Promise(r => setTimeout(r, 1500));

const disabledTools = {};
let disabledPrompt = null;
const disabledCtx = {
  tools: { register: (t) => { disabledTools[t.name] = true; return () => { delete disabledTools[t.name]; }; } },
  systemPrompt: { section: (s) => { disabledPrompt = s.name; return () => { disabledPrompt = null; }; } },
  settings: { register: () => ({ get: () => ({}), watch: () => (() => {}) }), section: () => undefined },
  on: () => {}
};
mod.apply(disabledCtx, {});
await new Promise(r => setTimeout(r, 2500)); // ждём первичной синхронизации
assert(Object.keys(disabledTools).length === 0, 'после отключения браузера в Admin плагин не регистрирует инструментов');
assert(disabledPrompt === null, 'после отключения браузера в Admin секция системного промпта не внедряется');

console.log('7. Восстановление включения браузера');
const onRes = await masterCall(true);
assert(onRes.ok && onRes.enabled === true, 'браузер снова включён');

console.log('PLUGIN_E2E_OK');
