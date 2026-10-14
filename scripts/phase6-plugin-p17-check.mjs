/**
 * P17 проверка внутри контейнера: поведение регистрации инструментов при авторитетной
 * конфигурации в трёх ситуациях: «нет файла / отключено / ошибка разбора».
 * Используется временный файл конфигурации, онлайн-файл /root/.dsh/gateway.config.json не трогается.
 * Запуск (в контейнере): node /tmp/phase6-plugin-p17-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p17-'));
const CFG = path.join(tmp, 'gateway.config.json');
const STATE = path.join(tmp, '.browser-desktop-last-state.json');
process.env.GATEWAY_CONFIG_FILE = CFG;
process.env.BROWSER_DESKTOP_STATE_FILE = STATE;
process.env.DSH_INTERNAL_TOKEN_FILE = path.join(tmp, '.tok');
fs.writeFileSync(process.env.DSH_INTERNAL_TOKEN_FILE, 'x\n', { mode: 0o600 });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('   ✔ ' + m); } else { fail++; console.log('   ❌ ' + m); } };

function makeCtx() {
  const registered = {};
  const ctx = {
    tools: { register: (t) => { registered[t.name] = t; return () => { delete registered[t.name]; }; } },
    systemPrompt: { section: () => () => {} },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  };
  return { ctx, registered };
}

// В приоритете исходник репозитория: /app в контейнере — копия, запечённая на стадии сборки,
// после обновления репозитория она может отставать; раньше жёсткий import /app утверждал
// по устаревшей копии и ложно рапортовал об ошибке (по факту 1/4 против 4/4 у исходника репозитория).
const PLUGIN_ENTRY = [
  process.env.DSH_PLUGIN_ENTRY,
  path.resolve(process.cwd(), 'plugins/dsh-browser-desktop/index.js'),
  '/app/plugins/dsh-browser-desktop/index.js'
].filter(Boolean).find((p) => fs.existsSync(p));

async function freshPlugin() {
  if (!PLUGIN_ENTRY) throw new Error('dsh-browser-desktop/index.js не найден (можно указать через DSH_PLUGIN_ENTRY)');
  return await import(PLUGIN_ENTRY + '?t=' + Date.now() + Math.random());
}

// A. Конфигурации нет → сохраняем текущее состояние (включено по умолчанию)
try { fs.unlinkSync(CFG); } catch {}
{
  const mod = await freshPlugin();
  const { ctx, registered } = makeCtx();
  mod.apply(ctx, {});
  ok(Object.keys(registered).length === 3, 'A конфигурации нет → регистрируется 3 инструмента (включено по умолчанию)');
}

// B. Явно отключено → не регистрируем и пишем на диск «последнее успешное состояние»
fs.writeFileSync(CFG, JSON.stringify({ desktop: { enabled: false } }));
{
  const mod = await freshPlugin();
  const { ctx, registered } = makeCtx();
  mod.apply(ctx, {});
  ok(Object.keys(registered).length === 0, 'B enabled:false → ни одного инструмента не регистрируется');
  ok(fs.existsSync(STATE), 'B файл последнего успешного состояния записан');
}

// C. Конфигурация сломана + перезапуск процесса (новый экземпляр, снапшота в памяти нет)
// → обязателен откат к записанному отключённому состоянию
fs.writeFileSync(CFG, '{ broken json');
{
  const mod = await freshPlugin();
  const { ctx, registered } = makeCtx();
  mod.apply(ctx, {});
  ok(Object.keys(registered).length === 0, 'C JSON повреждён → остаёмся отключёнными (без отката к включено)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`===== Итог P17: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
