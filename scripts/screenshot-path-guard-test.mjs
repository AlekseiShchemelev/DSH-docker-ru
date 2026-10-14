/**
 * P1 регрессия: границы рабочей области для пути сохранения скриншота.
 * Запуск: node scripts/screenshot-path-guard-test.mjs
 * Путь плагина в приоритете берётся из текущего репозитория (удобно локально проверять
 * неприменённые изменения), можно переопределить через DSH_PLUGIN_PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = '/tmp/p1-workspace';
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_PLUGIN = path.resolve(HERE, '../plugins/dsh-browser-desktop/index.js');
const PLUGIN = process.env.DSH_PLUGIN_PATH
  || (fs.existsSync(REPO_PLUGIN) ? REPO_PLUGIN : '/app/plugins/dsh-browser-desktop/index.js');
console.log('Плагин: ' + PLUGIN);

const mod = await import(PLUGIN);
const tools = {};
mod.apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  systemPrompt: { section: () => () => {} },
  settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
  on: () => {}
}, {});
const exec = { signal: null, agent: { session: { header: { cwd: WS } } } };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

console.log('\n=== A. Выходящий за пределы абсолютный путь должен заворачиваться в рабочую область ===');
const esc1 = '/tmp/p1-escape-abs.png';
try { fs.unlinkSync(esc1); } catch {}
const r1 = await tools.browser_screenshot.execute({ savePath: esc1 }, exec);
ok(!fs.existsSync(esc1), 'абсолютный путь за пределами рабочей области не записан');
ok(String(r1.path).startsWith(WS), 'возвращённый путь лежит в рабочей области: ' + r1.path);

console.log('\n=== B. ../ за пределы должно заворачиваться в рабочую область ===');
const esc2 = '/tmp/p1-escape-dotdot.png';
try { fs.unlinkSync(esc2); } catch {}
const r2 = await tools.browser_screenshot.execute({ savePath: '../../../tmp/p1-escape-dotdot.png' }, exec);
ok(!fs.existsSync(esc2), '../ за пределы не записан');
ok(String(r2.path).startsWith(WS), 'возвращённый путь лежит в рабочей области: ' + r2.path);

console.log('\n=== C. Побег через символьную ссылку должен распознаваться ===');
const linkDir = WS + '/link-out';
try { fs.unlinkSync(linkDir); } catch {}
fs.symlinkSync('/tmp', linkDir);
const esc3 = '/tmp/p1-escape-symlink.png';
try { fs.unlinkSync(esc3); } catch {}
await tools.browser_screenshot.execute({ savePath: 'link-out/p1-escape-symlink.png' }, exec);
ok(!fs.existsSync(esc3), 'запись за пределы через символьную ссылку блокируется');

console.log('\n=== D. Нормальный путь в рабочей области должен работать ===');
const r4 = await tools.browser_screenshot.execute({ savePath: 'shot/ok.png' }, exec);
ok(fs.existsSync(r4.path) && String(r4.path).startsWith(WS), 'относительный путь внутри рабочей области записывается нормально: ' + r4.path);

console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
