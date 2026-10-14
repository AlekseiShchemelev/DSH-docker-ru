/**
 * S1 регрессионный тест: проверка номера версии DSH и вложенности пути.
 * Тест чистых функций, без побочных эффектов. Запуск: node scripts/dsh-version-validation-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { isValidVersion, resolveWithinDir } = require(path.join(here, '../gateway/dsh-version.js'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; }
};

console.log('\n=== A. Допустимые номера версий должны проходить ===');
for (const v of ['0.1.6-alpha.2', '1.2.3', '0.1.2-rc.1', '10.20.30', '1.0.0+build.5', '0.1.6-alpha.2+build.1', '  0.1.6  ']) {
  ok(isValidVersion(v), `допустимо: ${JSON.stringify(v)}`);
}

console.log('\n=== B. Атакующие/недопустимые входные значения должны отклоняться ===');
const bad = [
  '../../../root/.dsh/profiles/web',
  '../../..',
  '..',
  'a/b',
  '/etc/passwd',
  'npm:evil-package',
  'npm:@scope/pkg@1.0.0',
  'file:/etc/passwd',
  '1.2',
  '1.2.3.4',
  '',
  '   ',
  'x'.repeat(65),
  '1.2.3-',
  '1.2.3-..',
  '0.1.6-alpha.2; rm -rf /',
  '${jndi:ldap://x}',
  'v1.2.3',
  null,
  undefined,
  123,
  {}
];
for (const v of bad) ok(!isValidVersion(v), `отклонено: ${JSON.stringify(v)?.slice(0, 40)}`);

console.log('\n=== C. Вложенность resolveWithinDir ===');
const base = '/root/.dsh-snapshots/versions';
ok(resolveWithinDir(base, '0.1.6-alpha.2') === '/root/.dsh-snapshots/versions/0.1.6-alpha.2', 'нормальная версия лежит в каталоге');
ok(resolveWithinDir(base, 'a/../b') === '/root/.dsh-snapshots/versions/b', 'внутренние .. после нормализации остаются в каталоге');
for (const v of ['../../../root/.dsh/profiles/web', '/etc/passwd', '../../..']) {
  let threw = false;
  try { resolveWithinDir(base, v); } catch { threw = true; }
  ok(threw, `выход за пределы отклонён: ${JSON.stringify(v)}`);
}

console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
