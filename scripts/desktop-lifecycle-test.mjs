#!/usr/bin/env node
/**
 * Регрессионный тест жизненного цикла контейнерного браузера / виртуального рабочего стола
 *
 * Напрямую гоняет gateway/desktop-manager.js (синглтон), покрывает ключевые сценарии
 * из отчёта и плана:
 *   T1 смена разрешения на ходу (прежний сценарий мёртвой блокировки)
 *   T2 после остановки можно запустить снова
 *   T3 быстрый цикл stop -> start
 *   T4 самовосстановление start после краха дочернего процесса
 *   T5 идемпотентная повторная попытка после сбоя запуска (без остатка :99)
 *   T6 restart с новым разрешением
 *   T7 немедленный перезапуск после автоостановки (простой / истёкшее время)
 *   T8 горячее обновление runtime-конфигурации (порт CDP) и её вступление в силу
 *
 * Запуск:
 *   node scripts/desktop-lifecycle-test.mjs            # все
 *   node scripts/desktop-lifecycle-test.mjs T1 T3      # выборочные случаи
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { execSync, spawnSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const dm = require('../gateway/desktop-manager.js');

const DISPLAY = process.env.DISPLAY || ':99';
const DISPLAY_NUM = DISPLAY.replace(/^:/, '').split('.')[0];

let pass = 0, fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { console.log(`   ✔ ${msg}`); }
  else { throw new Error(`Ошибка утверждения: ${msg}`); }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Тайм-аут ${ms}мс: ${label}`)), ms); })
  ]);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-af', pattern], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function xLockExists() {
  return existsSync(`/tmp/.X${DISPLAY_NUM}-lock`);
}

function countFds() {
  try {
    const pid = process.pid;
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch { return -1; }
}

async function cleanSlate() {
  await withTimeout(dm.stop(), 25000, 'cleanSlate stop').catch(() => {});
  await sleep(1500);
}

const tests = {};

// T1: смена разрешения на ходу —— прежний код здесь намертво блокировался
tests.T1 = async () => {
  await cleanSlate();
  const r1 = await withTimeout(dm.start({ width: 1920, height: 1080 }), 40000, 'T1 start 1920x1080');
  ok(r1.ok, `первый запуск успешен (${JSON.stringify(r1.status?.width)}x${r1.status?.height})`);

  const r2 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T1 switch to 1280x720');
  ok(r2.ok, 'смена разрешения вернула ok (без мёртвой блокировки)');
  ok(r2.status?.width === 1280 && r2.status?.height === 720, `разрешение переключено на 1280x720 (факт ${r2.status?.width}x${r2.status?.height})`);

  // После переключения управление со стороны панели должно по-прежнему работать
  // (прежний мёртвый блок ломал все последующие start/stop)
  const r3 = await withTimeout(dm.start({}), 20000, 'T1 start after switch');
  ok(r3.ok, 'повторный start после переключения работает');
  ok(r3.alreadyRunning === true, 'повторный start с тем же разрешением возвращает alreadyRunning (без лишнего перезапуска всего стола)');
  await withTimeout(dm.stop(), 25000, 'T1 stop');
};

// T2: после остановки можно снова запустить
tests.T2 = async () => {
  await cleanSlate();
  const a = await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T2 start #1');
  ok(a.ok, 'первый запуск успешен');
  const s = await withTimeout(dm.stop(), 25000, 'T2 stop');
  ok(s.ok, 'остановка успешна');
  await sleep(1500);
  const b = await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T2 start #2');
  ok(b.ok, 'после остановки повторный запуск успешен');
  ok(b.status?.running === true, 'флаг running = true');
  await withTimeout(dm.stop(), 25000, 'T2 final stop');
};

// T3: быстрый цикл stop -> start, проверка конкуренции портов/локов
tests.T3 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T3 initial start');
  for (let i = 1; i <= 5; i++) {
    await withTimeout(dm.stop(), 25000, `T3 stop #${i}`);
    const r = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, `T3 immediate start #${i}`);
    ok(r.ok, `в ${i}-м цикле start сразу после stop успешен`);
  }
  await withTimeout(dm.stop(), 25000, 'T3 final stop');
};

// T4: самовосстановление start после краха дочернего процесса
tests.T4 = async () => {
  await cleanSlate();
  const r1 = await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T4 start');
  ok(r1.ok, 'первичный запуск успешен');
  await sleep(2000);
  spawnSync('pkill', ['-9', '-f', 'chromium'], { encoding: 'utf8' });
  await sleep(2500);
  const st = dm.getStatus();
  console.log(`   status.running=${st.running} healthy=${st.healthy} после краха`);
  const r2 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T4 restart after crash');
  ok(r2.ok, 'после краха start возвращает ok');
  const alive = pgrep('chromium');
  ok(alive.length > 0, 'процесс Chromium перезапущен');
  await withTimeout(dm.stop(), 25000, 'T4 stop');
};

// T5: идемпотентная повторная попытка после сбоя запуска (искусственно занимаем :99 для первого сбоя)
tests.T5 = async () => {
  await cleanSlate();
  // Искусственно занимаем :99 (порождаем асинхронно, ни в коем случае не блокируем;
  // spawnSync сейчас будет ждать не завершающийся Xvfb)
  const blocker = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x720x24', '-ac', '-nolisten', 'tcp'], {
    detached: true, stdio: 'ignore'
  });
  blocker.unref();
  await sleep(2500);
  const r1 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T5 failing start');
  console.log(`   результат start при занятом :99: ok=${r1.ok} error=${r1.error || '-'}`);
  // Освобождаем занятие
  spawnSync('pkill', ['-9', '-f', `Xvfb ${DISPLAY}`], { encoding: 'utf8' });
  if (blocker.pid) { try { process.kill(blocker.pid, 'SIGKILL'); } catch {} }
  await sleep(2000);
  const r2 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T5 retry start');
  ok(r2.ok, 'повторный запуск после освобождения успешен (без остаточных блокировок)');
  await withTimeout(dm.stop(), 25000, 'T5 stop');
};

// T6: restart с новым разрешением
tests.T6 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T6 start');
  const r = await withTimeout(dm.restart({ width: 1440, height: 900 }), 60000, 'T6 restart 1440x900');
  ok(r.ok, 'restart возвращает ok');
  ok(r.status?.width === 1440, `после restart разрешение 1440 (факт ${r.status?.width})`);
  await withTimeout(dm.stop(), 25000, 'T6 stop');
};

// T7: имитация автоостановки по простою/истёкшему времени и немедленный перезапуск
tests.T7 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720, durationMinutes: 1 }), 40000, 'T7 start');
  // Просто переводим expiresAt в прошлое, чтобы watchdog сработал на автоостановку
  dm.expiresAt = Date.now() - 1000;
  dm.checkIdleWatchdog();
  await sleep(2000);
  const r = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T7 restart after auto-stop');
  ok(r.ok, 'немедленный перезапуск после автоостановки успешен');
  await withTimeout(dm.stop(), 25000, 'T7 stop');
};

// T8: горячее обновление runtime-конфигурации (порт CDP) и вступление в силу
tests.T8 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720, enableCdp: true, cdpPort: 9222 }), 45000, 'T8 start');
  const changed = dm.applyConfig({ cdpPort: 9333 });
  ok(changed.cdpPort === 9333, 'applyConfig сообщает изменение cdpPort');
  // Ждём завершения асинхронного перезапуска (очередь сериализует)
  await withTimeout(dm._opChain, 70000, 'T8 wait restart');
  const st = dm.getStatus();
  ok(st.cdpPort === 9333, `конфигурация вступила в силу cdpPort=${st.cdpPort}`);
  ok(st.running === true, 'после перезапуска рабочий стол работает');
  let cdpOk = false;
  for (let i = 0; i < 25; i++) {
    try { const r = await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1500) }); if (r.ok) { cdpOk = true; break; } } catch {}
    await sleep(400);
  }
  ok(cdpOk, 'новый порт CDP 9333 слушает');
  await withTimeout(dm.stop(), 25000, 'T8 stop');
};

async function main() {
  const only = process.argv.slice(2).filter(a => /^T\d+$/.test(a));
  const names = (only.length ? only : Object.keys(tests));
  console.log(`\n===== Регрессионный тест жизненного цикла рабочего стола (DISPLAY=${DISPLAY}) =====\n`);
  for (const name of names) {
    if (!tests[name]) { console.log(`Пропуск неизвестного случая ${name}`); continue; }
    console.log(`▶ ${name}`);
    const fdsBefore = countFds();
    try {
      await withTimeout(tests[name](), 180000, `${name} общий тайм-аут`);
      console.log(`   ✅ ${name} пройден\n`);
      pass++;
    } catch (err) {
      console.log(`   ❌ ${name} провален: ${err.message}\n`);
      failures.push(`${name}: ${err.message}`);
      fail++;
      await cleanSlate().catch(() => {});
    }
  }
  console.log('===== Итог =====');
  console.log(`Пройдено ${pass} / провалено ${fail}`);
  if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
}

main().catch(err => { console.error('Ошибка выполнения теста:', err); process.exit(1); });
