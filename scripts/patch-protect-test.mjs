/**
 * P6 регрессионный тест: patch-yaml.cjs (хирургическое удаление записей + предохранитель).
 *
 * Покрытие:
 *   A. удаляются только попавшие под критерий записи, остальные байты **сохраняются дословно**
 *      (комментарии, пустые строки, CRLF, `!!js`-выражения)
 *   B. без совпадений результат байт-в-байт совпадает с исходником
 *   C. реальный сценарий: после удаления исторической записи dsh-browser-desktop записи
 *      llm-pi-ai / ui-theme / agent-default-model (настройки DSH и конфиг model-provider)
 *      обязаны остаться как есть
 *   D. предохранитель блокирует перезапись, «теряющую нецелевые записи»
 *   E. предохранитель блокирует удаление «защищённой записи (llm-pi-ai)»
 *   F. предохранитель блокирует «результат не является корректной YAML-последовательностью»
 *
 * Запуск: node scripts/patch-protect-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  removePatchEntries,
  assertPatchSafe,
  topLevelEntryIds,
  protectedPatchIds,
  looksLikePatchDocument
} = require(path.join(here, 'patch-yaml.cjs'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const REAL_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-08-13.1',
  '',
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: light',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      newapi:',
  '        displayName: NewAPI',
  '        models:',
  '          - id: hy4-preview',
  '',
  '- id: dsh-browser-desktop',
  '  name: "@dsh-custom/dsh-browser-desktop"',
  '  config:',
  '    enabled: true',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  ''
].join('\n');

console.log('\n=== A. Хирургическое удаление: остальные байты сохраняются дословно ===');
const rA = removePatchEntries(REAL_PATCH, (b) => b.includes('dsh-browser-desktop'));
ok(rA.removed === 1, `удалена 1 запись (факт ${rA.removed})`);
ok(!rA.text.includes('dsh-browser-desktop'), 'целевая запись удалена');
ok(rA.text.includes('llm-pi-ai') && rA.text.includes('hy4-preview'), 'llm-pi-ai / hy4-preview полностью сохранены');
ok(rA.text.includes('agent-default-model'), 'последующие записи сохранены');
ok(rA.text.startsWith('# Your patch layer'), 'комментарий в начале файла сохранён');
// Ожидаемый результат = исходный текст минус ровно эти 4 строки записи
const expectedA = REAL_PATCH.replace(
  '- id: dsh-browser-desktop\n  name: "@dsh-custom/dsh-browser-desktop"\n  config:\n    enabled: true\n',
  ''
);
ok(rA.text === expectedA, 'результат байт-в-байт равен «исходник минус эта запись»');

console.log('\n=== B. Без совпадений байты полностью не меняются ===');
const rB = removePatchEntries(REAL_PATCH, () => false);
ok(rB.removed === 0 && rB.text === REAL_PATCH, 'без совпадений ⇒ исходник не меняется (беительно)');
const rB2 = removePatchEntries('', () => true);
ok(rB2.removed === 0 && rB2.text === '', 'пустой контент не вызывает ошибки и не меняется');

console.log('\n=== B2. CRLF и вложенная структура insert ===');
const crlf = '# c\r\n- id: keep\r\n  disabled: true\r\n- insert:\r\n    - id: drop-me\r\n      name: drop-me\r\n- id: tail\r\n';
const rCrlf = removePatchEntries(crlf, (b) => b.includes('drop-me'));
ok(rCrlf.removed === 1 && rCrlf.text.includes('keep') && rCrlf.text.includes('tail'), 'при CRLF корректно удаляется вложенная запись insert');
ok(rCrlf.text.includes('\r\n'), 'окончания строк CRLF сохранены');
ok(!rCrlf.text.includes('drop-me'), 'целевая вложенная запись удалена');

console.log('\n=== C. Реальный сценарий: сохраняются настройки DSH и конфиг моделей ===');
const rC = removePatchEntries(REAL_PATCH, (b) => b.includes('dsh-browser-desktop'));
const idsAfter = topLevelEntryIds(rC.text);
ok(JSON.stringify(idsAfter) === JSON.stringify(['ui-settings-general', 'ui-theme', 'llm-pi-ai', 'agent-default-model']),
  `id верхнеуровневых записей полны (${idsAfter.join(', ')})`);
ok(!assertPatchSafeGuarded(rC.text), 'предохранитель пропускает корректный результат');

function assertPatchSafeGuarded(after) {
  try { assertPatchSafe({ before: REAL_PATCH, after, removedIds: ['dsh-browser-desktop'] }); return null; } catch (e) { return e.message; }
}

console.log('\n=== D. Предохранитель: потерю нецелевой записи обязан блокировать ===');
const brokenD = REAL_PATCH.replace(/- id: ui-theme[\s\S]*?preference: light\n/, '');
const msgD = throws(() => assertPatchSafe({ before: REAL_PATCH, after: brokenD, removedIds: ['dsh-browser-desktop'] }));
ok(Boolean(msgD) && /ui-theme/.test(msgD), `блокировка с указанием потерянной записи (${String(msgD).slice(0, 60)}…)`);

console.log('\n=== E. Предохранитель: удаление защищённой llm-pi-ai должно блокироваться ===');
const brokenE = REAL_PATCH.replace(/- id: llm-pi-ai[\s\S]*?hy4-preview\n/, '');
const msgE = throws(() => assertPatchSafe({ before: REAL_PATCH, after: brokenE, removedIds: ['dsh-browser-desktop'] }));
ok(Boolean(msgE) && /llm-pi-ai/.test(msgE), 'блокировка потери llm-pi-ai');
ok(protectedPatchIds().includes('llm-pi-ai'), 'список защиты по умолчанию содержит llm-pi-ai');

console.log('\n=== F. Предохранитель: недопустимый вид документа должен блокироваться ===');
const msgF = throws(() => assertPatchSafe({ before: REAL_PATCH, after: 'this: is a mapping\n', removedIds: [] }));
ok(Boolean(msgF), 'блокировка «результат не является верхнеуровневой последовательностью»');
ok(looksLikePatchDocument('[]') && looksLikePatchDocument('- id: a\n') && !looksLikePatchDocument('a: b\n'), 'looksLikePatchDocument определяет корректно');

console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
