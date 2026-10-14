/**
 * M8 регрессионный тест: удаление cordis.patch.yml по гранулярности «запись» (вместо старого межстрочного regex).
 * Запуск: node scripts/patch-entry-removal-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { removePatchEntries } = require(path.join(here, '../gateway/plugin-manager.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

const SAMPLE = [
  '# комментарий строки',
  '- id: better-sidebar',
  '  disabled: true',
  '- id: dsh-super-injector',
  '  disabled: true',
  '- insert:',
  '    - id: dsh-archived-chats',
  '      name: dsh-archived-chats',
  '- id: keep-me',
  '  disabled: true',
  ''
].join('\n');

console.log('\n=== A. Удаляются только попавшие под критерий записи, прочие записи/комментарии не трогаются ===');
const r1 = removePatchEntries(SAMPLE, (b) => /dsh-archived-chats/.test(b));
ok(r1.removed === 1, `удалена 1 запись (факт ${r1.removed})`);
ok(r1.text.includes('better-sidebar'), 'сохранено better-sidebar');
ok(r1.text.includes('dsh-super-injector'), 'сохранено dsh-super-injector');
ok(r1.text.includes('keep-me'), 'сохранено keep-me (без случайного зацепа чужих записей)');
ok(r1.text.includes('# комментарий строки'), 'комментарий-строка сохранён');
ok(!r1.text.includes('dsh-archived-chats'), 'целевая запись удалена');

console.log('\n=== B. Имя плагина с метасимволами regex тоже не задевает чужое ===');
const SAMPLE2 = '- id: keep-a\n  disabled: true\n- insert:\n    - id: dsh-market\n- id: keep-b\n  disabled: true\n';
const r2 = removePatchEntries(SAMPLE2, (b) => b.includes('dsh-market'));
ok(r2.removed === 1 && r2.text.includes('keep-a') && r2.text.includes('keep-b'), 'метасимволы/похожие имена не дают ложных удалений');

console.log('\n=== C. Пустой контент / без совпадений ===');
const r3 = removePatchEntries('[]\n', () => true);
ok(r3.removed === 0, 'не-записи не удаляются');
const r4 = removePatchEntries(SAMPLE, () => false);
ok(r4.removed === 0 && r4.text === SAMPLE, 'без совпадений контент не меняется');

console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
