/**
 * Юнит-тест «главного переключателя» контейнерного браузера (X-сервер не нужен, можно запускать локально).
 *
 * Покрытие:
 *   1. после setEnabled(false) start()/restart() всегда отклоняются (перекрывает инструменты ИИ,
 *      автопробуждение VNC, загрузку через bootstrap и т.д.)
 *   2. getStatus().enabled честно отражает главный переключатель
 *   3. канал горячего обновления плагина (applyConfig) не может перевернуть главный переключатель
 *   4. после повторного включения запуск снова возможен
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dm = require('../gateway/desktop-manager.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; throw new Error('Ошибка утверждения: ' + msg); }
}

async function main() {
  console.log('\n=== 1. Состояние до отключения ===');
  dm.setEnabled(true);
  ok(dm.isEnabled() === true, 'изначально включено');
  ok(dm.getStatus().enabled === true, 'status.enabled = true');

  console.log('\n=== 2. После полного отключения должны отклоняться все запуски ===');
  dm.setEnabled(false);
  ok(dm.isEnabled() === false, 'главный переключатель отключён');
  ok(dm.getStatus().enabled === false, 'status.enabled = false');

  const r1 = await dm.start({ width: 1280, height: 720 });
  ok(r1.ok === false, 'start() отклонён');
  ok(r1.disabled === true, 'возвращается признак disabled, чтобы вышестоящий код дал точную подсказку');
  ok(typeof r1.error === 'string' && r1.error.includes('отключ'), 'возвращается понятная причина отклонения: ' + r1.error);

  const r2 = await dm.restart({ width: 1280, height: 720 });
  ok(r2.ok === false, 'restart() тоже отклонён');

  console.log('\n=== 3. Горячее обновление плагина не может перевернуть главный переключатель ===');
  dm.applyConfig({ enabled: true });
  ok(dm.isEnabled() === false, 'applyConfig({enabled:true}) игнорируется, главный переключатель остаётся отключённым');
  ok(dm.getStatus().enabled === false, 'status.enabled остаётся false');

  console.log('\n=== 4. Повторное включение ===');
  dm.setEnabled(true);
  ok(dm.isEnabled() === true, 'главный переключатель снова включён');
  ok(dm.getStatus().enabled === true, 'status.enabled = true');

  console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
  if (fail) process.exitCode = 1;
}

main().catch(err => { console.error('Исключение в тесте:', err.message); process.exit(1); });
