/**
 * Краевая регрессия: после закрытия «последней вкладки / последнего окна» браузера
 * должна работать возможность «перезапустить браузер».
 *
 * Сценарий: пользователь или ИИ закрывает все вкладки страниц Chromium (эквивалент —
 * вручную закрыть в VNC последнее окно, после чего процесс Chromium выходит).
 * Рабочий стол при этом должен быть признан «нездоровым» и уметь самовосстанавливаться
 * через следующие входы:
 *         A) пользователь открывает /vnc (кнопка «Открыть рабочий стол» / iframe боковой панели, тот же origin)
 *         B) инструмент ИИ browser_open (внутренне идёт через /__internal/desktop/start)
 *
 * Запуск в контейнере: node /app/scripts/edge-last-tab-recovery.mjs
 */
const GW = `http://127.0.0.1:${process.env.PROXY_PORT || 3080}`;
const CDP = `http://127.0.0.1:${process.env.DSH_CDP_PORT || 9222}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Общий ключ внутренних интерфейсов (M14): шлюз при старте создаёт файл 0600, скрипт
// в контейнере читает его и подставляет
import fs from 'node:fs';
const INTERNAL_TOKEN_FILE = process.env.DSH_INTERNAL_TOKEN_FILE || '/root/.dsh/.internal-api-token';
const internalHeaders = () => {
  try {
    const t = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim();
    if (t) return { 'x-dsh-internal-token': t };
  } catch {}
  return {};
};

async function pages() {
  try {
    const r = await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    return (await r.json()).filter(t => t.type === 'page');
  } catch { return null; }
}
async function status() {
  try {
    const r = await fetch(`${GW}/__internal/desktop/status`, { headers: internalHeaders(), signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return null; }
}
async function closeAllTabs() {
  for (const p of (await pages()) || []) {
    try { await fetch(`${CDP}/json/close/${encodeURIComponent(p.id)}`); } catch {}
  }
}
// Поллинг-вызов до восстановления рабочего стола (максимум ~20 с)
async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await status();
    if (s?.running === true && s?.healthy === true) return s;
    await sleep(1000);
  }
  return await status();
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

const mod = await import('/app/plugins/dsh-browser-desktop/index.js');
const tools = {};
mod.apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  systemPrompt: { section: () => () => {} },
  settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
  on: () => {}
}, {});

console.log('\n=== 0. Убеждаемся, что рабочий стол запущен ===');
await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login' }, { signal: null });
let s = await waitHealthy(15000);
console.log('   изначально: running=' + s?.running + ' healthy=' + s?.healthy);

console.log('\n=== A. Закрыли последнюю вкладку → открытие /vnc должно самовосстановиться ===');
await closeAllTabs();
await sleep(3500);
let a1 = await status();
console.log('   после закрытия: running=' + a1?.running + ' unhealthy=' + a1?.unhealthy);
ok(a1?.running === false && a1?.unhealthy === true, 'рабочий стол корректно признан нездоровым (running=false / unhealthy=true)');
const r = await fetch(`${GW}/vnc/`, { headers: { Authorization: 'Bearer ' + (process.env.AUTH_TOKEN || '') }, redirect: 'manual' });
console.log('   GET /vnc/ -> HTTP ' + r.status);
let a2 = await waitHealthy(20000);
ok(a2?.running === true && a2?.healthy === true, 'после открытия /vnc браузер самовосстановился');

console.log('\n=== B. Снова закрываем последнюю вкладку → browser_open должен самовосстановиться ===');
await closeAllTabs();
await sleep(3500);
let b1 = await status();
ok(b1?.running === false && b1?.unhealthy === true, 'рабочий стол снова признан нездоровым');
let rec = null;
try { rec = await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login' }, { signal: null }); }
catch (e) { rec = { error: e.message }; }
console.log('   browser_open вернул:', JSON.stringify(rec).slice(0, 160));
ok(!!rec && !!rec.tabId, 'browser_open снова получил вкладку (tabId=' + (rec && rec.tabId) + ')');
let b2 = await waitHealthy(15000);
ok(b2?.running === true && b2?.healthy === true, 'рабочий стол снова запущен и здоров');
const p2 = await pages();
ok(Array.isArray(p2) && p2.length >= 1, 'в CDP снова есть страницы (' + (p2 ? p2.length : 'n/a') + ')');

console.log(`\n===== Итог краевой регрессии: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
