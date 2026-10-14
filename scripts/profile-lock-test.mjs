/**
 * P6 регрессионный тест: write-lock профиля (scripts/profile-lock.cjs).
 *
 * Покрытие:
 *   A. путь файла lock совпадает с DSH (<profileDir>/package.json.lock)
 *   B. получение/освобождение, в файл lock пишется PID владельца
 *   C. запись profile без удержания lock отсекается runtime-защитой (PROFILE_LOCK_NOT_HELD)
 *   D. вложенное получение в одном процессе явно отклоняется (без self-дедлока)
 *   E. конкурентные задачи сериализуются (не перемешиваются)
 *   F. когда lock держит другой — тайм-аут по waitMs (PROFILE_LOCK_TIMEOUT)
 *   G. уборка устаревшего lock: PID умер + mtime превысил порог → уборка; PID жив → никогда
 *   H. межпроцессное взаимоисключение: несколько процессов «читают-меняют-пишут»
 *      один и тот же счётчик — ноль потерянных обновлений
 *
 * Запуск: node scripts/profile-lock-test.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Должно быть выставлено до require: уменьшаем порог уборки устаревшего lock для удобства теста
process.env.DSH_PROFILE_LOCK_STALE_MS = '1200';
process.env.DSH_PROFILE_LOCK_WARN_MS = '100000';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MOD = path.join(here, 'profile-lock.cjs');
const {
  withProfileLock,
  acquireProfileLock,
  isProfileLockHeld,
  assertProfileLockHeld,
  profileLockPath
} = require(LOCK_MOD);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-lock-'));
const profileDir = path.join(tmp, 'profiles/web');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), '{}\n');
const lockPath = profileLockPath(profileDir);

console.log('\n=== A. Путь файла lock совпадает с DSH ===');
ok(lockPath === path.join(profileDir, 'package.json.lock'), 'файл lock — <profileDir>/package.json.lock');

console.log('\n=== B. Получение/освобождение и содержимое lock ===');
const rel = await acquireProfileLock(profileDir);
ok(fs.existsSync(lockPath), 'пока держится lock, файл существует');
ok(fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid), 'в файл lock записан PID владельца');
ok((fs.statSync(lockPath).mode & 0o777) === 0o600, 'права файла lock — 0600');
ok(isProfileLockHeld(profileDir), 'isProfileLockHeld возвращает true');
rel();
ok(!fs.existsSync(lockPath), 'после освобождения файл lock удалён');
ok(!isProfileLockHeld(profileDir), 'isProfileLockHeld возвращает false');

console.log('\n=== C. Запись profile без lock отсекается защитой ===');
let guardCode = null;
try { assertProfileLockHeld(profileDir); } catch (e) { guardCode = e.code; }
ok(guardCode === 'PROFILE_LOCK_NOT_HELD', 'без удержания lock бросается PROFILE_LOCK_NOT_HELD');

console.log('\n=== D. Вложенное получение явно отклоняется (без self-дедлока) ===');
const r1 = await acquireProfileLock(profileDir);
let nestedCode = null;
try { await acquireProfileLock(profileDir, { waitMs: 200 }); } catch (e) { nestedCode = e.code; }
ok(nestedCode === 'PROFILE_LOCK_REENTRANT', 'повторный захват lock в том же процессе бросает PROFILE_LOCK_REENTRANT');
r1();
ok(!isProfileLockHeld(profileDir), 'после освобождения всё полностью освобождено');

console.log('\n=== E. Конкурентные задачи сериализуются ===');
const order = [];
await Promise.all([
  withProfileLock(profileDir, async () => { order.push('a-in'); await sleep(120); order.push('a-out'); }),
  withProfileLock(profileDir, async () => { order.push('b-in'); await sleep(20); order.push('b-out'); })
]);
ok(order.join(',') === 'a-in,a-out,b-in,b-out', `без перемешивания (факт ${order.join(',')})`);

console.log('\n=== F. Ожидание через процессы: тайм-аут ===');
const holderScript = path.join(tmp, 'holder.cjs');
fs.writeFileSync(holderScript, `
const { acquireProfileLock } = require(${JSON.stringify(LOCK_MOD)});
(async () => {
  const rel = await acquireProfileLock(process.argv[2], { label: 'holder' });
  process.stdout.write('HELD\\n');
  await new Promise((r) => setTimeout(r, 2000));
  rel();
})();
`);
const holder = spawn(process.execPath, [holderScript, profileDir], { stdio: ['ignore', 'pipe', 'inherit'] });
const holderExited = new Promise((resolve) => holder.on('exit', resolve));
const holderReady = new Promise((resolve) => {
  let done = false;
  holder.stdout.on('data', (d) => { if (!done && String(d).includes('HELD')) { done = true; resolve(); } });
});
await Promise.race([holderReady, sleep(5000)]);
let timeoutCode = null;
try { await withProfileLock(profileDir, async () => {}, { waitMs: 150 }); } catch (e) { timeoutCode = e.code; }
ok(timeoutCode === 'PROFILE_LOCK_TIMEOUT', 'когда lock держит другой, тайм-аут по waitMs и бросок PROFILE_LOCK_TIMEOUT');
await holderExited;
ok(!fs.existsSync(lockPath), 'после освобождения владельцем файл lock исчезает');

console.log('\n=== G. Уборка устаревшего lock (консервативная) ===');
// G1: PID не существует + mtime превысил порог → уборка ожидается
fs.writeFileSync(lockPath, '999999\n', { flag: 'wx' });
const oldTs = Date.now() / 1000 - 3600;
fs.utimesSync(lockPath, oldTs, oldTs);
let reclaimed = false;
try {
  const r = await acquireProfileLock(profileDir, { waitMs: 3000 });
  reclaimed = true;
  r();
} catch { reclaimed = false; }
ok(reclaimed, 'PID в lock мёртв и срок превышен → уборка и успешное получение');

// G2: PID жив (пишем PID этого процесса) + mtime превысил порог → никогда не убираем
fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
fs.utimesSync(lockPath, oldTs, oldTs);
let liveKept = false;
try { await withProfileLock(profileDir, async () => {}, { waitMs: 300 }); } catch (e) { liveKept = e.code === 'PROFILE_LOCK_TIMEOUT'; }
ok(liveKept, 'PID в lock жив → даже при превышенном mtime не убираем (консервативно)');
fs.rmSync(lockPath, { force: true });

console.log('\n=== H. Межпроцессное взаимоисключение (ноль потерь) ===');
const childScript = path.join(tmp, 'child.cjs');
fs.writeFileSync(childScript, `
const { withProfileLock } = require(${JSON.stringify(LOCK_MOD)});
const fs = require('fs');
const profileDir = process.argv[2];
const counter = process.argv[3];
(async () => {
  for (let i = 0; i < 10; i++) {
    await withProfileLock(profileDir, async () => {
      const n = Number(fs.readFileSync(counter, 'utf8'));
      await new Promise((r) => setTimeout(r, 15));
      fs.writeFileSync(counter, String(n + 1));
    });
  }
})();
`);
const counter = path.join(tmp, 'counter.txt');
fs.writeFileSync(counter, '0');
const CHILDREN = 3;
const runs = Array.from({ length: CHILDREN }, () => new Promise((resolve) => {
  const p = spawn(process.execPath, [childScript, profileDir, counter], { stdio: 'ignore' });
  p.on('exit', resolve);
}));
await Promise.all(runs);
const finalCount = Number(fs.readFileSync(counter, 'utf8'));
ok(finalCount === CHILDREN * 10, `${CHILDREN} процесса × 10 чтений/записей = ${CHILDREN * 10} (факт ${finalCount}, без потерь)`);
ok(!fs.existsSync(lockPath), 'после завершения всех дочерних процессов файл lock освобождён');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
