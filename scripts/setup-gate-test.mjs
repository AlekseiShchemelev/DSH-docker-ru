/**
 * S3 регрессионный тест: пустой код доступа → машина состояний мастера инициализации
 * + проверка стойкости пароля (слой чистых функций).
 * Запуск: node scripts/setup-gate-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ключевой момент: до require нужно очистить AUTH_TOKEN, имитируя первый запуск
// с ещё не заданным кодом доступа
process.env.AUTH_TOKEN = '';
process.env.ACCESS_CODE = '';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const auth = require(path.join(here, '../gateway/auth.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

console.log('\n=== A. Пустой пароль ⇒ нужна инициализация ===');
ok(auth.isAuthEnabled() === false, 'при пустом пароле auth не включён');
ok(auth.isSetupRequired() === true, 'при пустом пароле обязателен мастер инициализации');

console.log('\n=== B. После задания пароля ⇒ инициализация больше не нужна ===');
auth.updateAuthToken('Str0ng-Pass!');
ok(auth.isAuthEnabled() === true, 'после задания auth включён');
ok(auth.isSetupRequired() === false, 'после задания инициализация не нужна');
ok(auth.verifyToken('Str0ng-Pass!') === true, 'новый пароль проходит проверку');
ok(auth.verifyToken('wrong') === false, 'неверный пароль отклоняется');

console.log('\n=== C. Очистка пароля ⇒ возврат к инициализации ===');
auth.updateAuthToken('');
ok(auth.isSetupRequired() === true, 'после очистки снова нужна инициализация');

console.log('\n=== D. Проверка стойкости пароля ===');
for (const p of ['admin', 'Admin', 'password', '123456', '12345678', 'qwertyuiop', 'short', '', '   ', 'deepseek', 'letmein', '111111']) {
  ok(auth.isWeakPassword(p) === true, `слабый пароль отклонён: ${JSON.stringify(p)}`);
}
for (const p of ['Str0ng-Pass!', 'my-secret-2026', 'aB3$xyz9', 'notweak123', 'прочный-пароль2026', 'aB3$x9', 'pass6!']) {
  ok(auth.isWeakPassword(p) === false, `стойкий пароль проходит: ${JSON.stringify(p)}`);
}
ok(auth.isWeakPassword(null) === true, 'null считается слабым паролем');
ok(auth.isWeakPassword('x'.repeat(300)) === true, 'слишком длинный пароль считается недопустимым');

console.log('\n=== E. Маршрут: после задания пароля /setup должен уводить на страницу входа (не оставлять зомби-форму) ===');
{
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(here, '../gateway/index.js'), 'utf8');
  const block = src.slice(src.indexOf("if (pathname === '/setup' && req.method === 'GET')"));
  const body = block.slice(0, block.indexOf('\n  }') + 4);
  ok(/if \(!isSetupRequired\(\)\) \{ res\.writeHead\(302, \{ Location: '\/login' \}\); return res\.end\(\); \}/.test(body),
    '/setup при заданном пароле делает 302 на /login');
  ok(/serveStaticHtml\(res, 'setup\.html'\)/.test(body), 'рендер мастера при незаданном пароле сохранён');
}

console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
