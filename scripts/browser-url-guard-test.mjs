/**
 * P3 регрессионный тест: whitelist протоколов URL для browser_open.
 * Запуск: node scripts/browser-url-guard-test.mjs
 *
 * Проверка происходит до отправки любых сетевых запросов, поэтому шлюз/CDP не нужны.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-url-'));
const CFG = path.join(TMP, 'gateway.config.json');
fs.writeFileSync(CFG, JSON.stringify({ desktop: { enabled: true, width: 1280, height: 720 }, vncPath: '/vnc' }));
process.env.GATEWAY_CONFIG_FILE = CFG;
process.env.PROXY_PORT = '9'; // мёртвый порт: гарантируем, что запросы реально не уйдут

const mod = await import(new URL('../plugins/dsh-browser-desktop/index.js', import.meta.url).href);
const tools = {};
mod.apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  systemPrompt: { section: () => () => {} },
  settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
  on: () => {}
}, {});

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

async function expectReject(url, label) {
  try {
    await tools.browser_open.execute({ url }, { signal: null });
    ok(false, `${label} (должно быть отклонено)`);
  } catch (e) {
    const msg = String(e && e.message || e);
    ok(/только http\/https|не может быть пустым|неверный формат|отсутствует имя хоста/.test(msg), `${label} → отклонено: ${msg.slice(0, 70)}`);
  }
}

console.log('\n=== A. Опасные протоколы должны отклоняться ===');
await expectReject('file:///root/.dsh/gateway.config.json', 'file:// чтение локального файла');
await expectReject('file:///etc/passwd', 'file:// чтение системного файла');
await expectReject('javascript:alert(1)', 'javascript:');
await expectReject('data:text/html,<h1>x</h1>', 'data:');
await expectReject('chrome://settings', 'chrome://');
await expectReject('ftp://example.com/x', 'ftp://');
await expectReject('', 'пустой URL');
await expectReject('   ', 'пробельный URL');

console.log('\n=== B. Обычные http(s) не должны отклоняться на проверке протокола ===');
for (const url of ['http://127.0.0.1:9/login', 'https://example.com/a?b=1']) {
  try {
    await tools.browser_open.execute({ url }, { signal: null });
    ok(false, `${url} вдруг удался (не должно, мёртвый порт)`);
  } catch (e) {
    const msg = String(e && e.message || e);
    ok(!/только http\/https|неверный формат/.test(msg), `${url} прошёл проверку протокола (дальнейший сбой ожидаем: ${msg.slice(0, 40)})`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
