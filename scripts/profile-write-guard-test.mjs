/**
 * P6 регрессионный тест: запись profile со стороны консоли обязана участвовать в write-lock DSH.
 *
 * Покрытие:
 *   A. статика: шлюз и сборочные скрипты подключают модули лок/патч, а ключевые точки записи
 *      несут runtime-защиту
 *   B. статика: число физических точек записи profile ограничено (каждая внутри lock)
 *   C. динамика (важно): имитация «DSH пишет первым и держит lock», затем запускается настоящий
 *      install-plugin.mjs — утверждается, что запись DSH **не перекрывается нашим сборочным
 *      ходом** (это и есть потеря обновлений из P6)
 *
 * Запуск: node scripts/profile-write-guard-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const LOCK_MOD = path.join(here, 'profile-lock.cjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== A. Статика: подключение модулей и runtime-защита ===');
const pmSrc = read('gateway/plugin-manager.js');
ok(/profile-lock\.cjs/.test(pmSrc), 'gateway/plugin-manager.js подключает profile-lock.cjs');
ok(/patch-yaml\.cjs/.test(pmSrc), 'gateway/plugin-manager.js подключает patch-yaml.cjs');
ok(/function writePackageJson[\s\S]{0,400}assertProfileLockHeld\(PROFILE_DIR\)/.test(pmSrc),
  'writePackageJson несёт защиту assertProfileLockHeld');
ok(/function cleanPatchForPluginLocked[\s\S]{0,400}assertProfileLockHeld\(PROFILE_DIR\)/.test(pmSrc),
  'cleanPatchForPluginLocked несёт защиту assertProfileLockHeld');
for (const fn of ['togglePlugin', 'uninstallPlugin', 'installPlugin']) {
  const re = new RegExp(`async function ${fn}\\([\\s\\S]*?withProfileLock\\(PROFILE_DIR`);
  ok(re.test(pmSrc), `${fn} выполняет читать-менять-писать внутри withProfileLock`);
}
ok(/async function cleanPatchForPlugin\b[\s\S]{0,200}withProfileLock\(/.test(pmSrc),
  'внешний вход cleanPatchForPlugin сам берёт lock');
ok(/await pluginManager\.togglePlugin\(/.test(read('gateway/index.js')), 'index.js await togglePlugin');
ok(/await pluginManager\.uninstallPlugin\(/.test(read('gateway/index.js')), 'index.js await uninstallPlugin');
ok(/await pluginManager\.installPlugin\(/.test(read('gateway/index.js')), 'index.js await installPlugin');
ok(/await pm\.togglePlugin\(/.test(read('gateway/dsh-manager.js')), 'путь самовосстановления dsh-manager await togglePlugin');

const ipSrc = read('scripts/install-plugin.mjs');
ok(/profile-lock\.cjs/.test(ipSrc), 'install-plugin.mjs подключает profile-lock.cjs');
ok(/patch-yaml\.cjs/.test(ipSrc), 'install-plugin.mjs подключает patch-yaml.cjs');
ok(/function writeProfile[\s\S]{0,300}withProfileLock\(profileDir/.test(ipSrc), 'writeProfile у install-plugin внутри lock');
ok(/assertPatchSafe\(/.test(ipSrc), 'очистка патча у install-plugin несёт предохранитель');
ok(/removePatchEntries\(/.test(ipSrc), 'install-plugin использует хирургическое удаление');

console.log('\n=== B. Статика: число физических точек записи profile ограничено ===');
const pkgWrites = (ipSrc.match(/atomicWrite\(pkgPath/g) || []).length;
const patchWrites = (ipSrc.match(/atomicWrite\(patchPath/g) || []).length;
ok(pkgWrites === 2, `install-plugin пишет package.json только в 2 местах (факт ${pkgWrites}: writeProfile / ensureProfilePackage)`);
ok(patchWrites === 1, `install-plugin пишет cordis.patch.yml только в 1 месте (факт ${patchWrites})`);
const gateCount = (ipSrc.match(/assertProfileLockHeld\(profileDir\)/g) || []).length;
ok(gateCount >= 3, `защита у install-plugin встречается ${gateCount} раз (>=3)`);

console.log('\n=== C. Динамика: конкурентная запись DSH не перекрывается нашим сборочным ходом ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-guard-'));
const profileDir = path.join(tmp, '.dsh/profiles/web');
fs.mkdirSync(profileDir, { recursive: true });
const pkgPath = path.join(profileDir, 'package.json');
fs.writeFileSync(pkgPath, JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2) + '\n');

// Имитация DSH: сначала берём lock → записываем свою правку → держим lock какое-то время → освобождаем
const competitor = path.join(tmp, 'competitor.cjs');
fs.writeFileSync(competitor, `
const { withProfileLock } = require(${JSON.stringify(LOCK_MOD)});
const fs = require('fs');
const path = require('path');
const profileDir = process.argv[2];
const pkgPath = path.join(profileDir, 'package.json');
(async () => {
  await withProfileLock(profileDir, async () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.dsh.profile.bundles.includes('dsh-side-plugin')) pkg.dsh.profile.bundles.push('dsh-side-plugin');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n');
    process.stdout.write('ACQUIRED\\n');
    await new Promise((r) => setTimeout(r, 2500)); // имитируем pnpm-установку DSH, которая идёт внутри lock
  }, { label: 'competitor' });
})();
`);

const child = spawn(process.execPath, [competitor, profileDir], { stdio: ['ignore', 'pipe', 'inherit'] });
// Обработчик exit нужно повесить сразу после spawn, иначе дочерний процесс может завершиться
// раньше, чем Promise устоит
const childExited = new Promise((resolve) => child.on('exit', resolve));
let acquired = false;
child.stdout.on('data', (d) => { if (String(d).includes('ACQUIRED')) acquired = true; });
await Promise.race([(async () => { while (!acquired) await sleep(25); })(), sleep(5000)]);
ok(acquired, 'конкурент взял write-lock профиля и записал свой плагин (dsh-side-plugin)');

// Пока lock занят — запускаем настоящий сборочный скрипт
const installer = spawn(process.execPath, [path.join(ROOT, 'scripts/install-plugin.mjs')], {
  env: { ...process.env, DSH_HOME: tmp, DSH_PROFILE_DIR: profileDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
const installerExited = new Promise((resolve) => installer.on('exit', resolve));
let installerOut = '';
installer.stdout.on('data', (d) => { installerOut += String(d); });
installer.stderr.on('data', (d) => { installerOut += String(d); });

await installerExited;
await childExited;

const finalPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const bundles = finalPkg.dsh.profile.bundles;
ok(bundles.includes('dsh-side-plugin'), 'записанный DSH dsh-side-plugin не перекрыт (без потери обновлений)');
ok(bundles.includes('@dsh-custom/dsh-browser-desktop'), 'собственная правка сборочного скрипта применилась');
ok(installerOut.includes('Регистрация bundle-зависимости в package.json успешна'), 'сборочный скрипт действительно прошёл путь записи');
ok(!fs.existsSync(path.join(profileDir, 'package.json.lock')), 'по завершении файл lock освобождён (без остатков)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
