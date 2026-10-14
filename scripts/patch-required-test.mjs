/**
 * S4 регрессионный тест: поведение «обязательный патч не применён → FATAL» в patch-dsh-client.mjs.
 * Запуск: node scripts/patch-required-test.mjs
 *
 * В каталоге-песочнице создаётся минимальная структура DSH, проверяется:
 *   A. все якоря на месте → код выхода 0 и все маркеры применены
 *   B. сломан якорь auth → код выхода не 0, и печатается [FATAL]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'scripts/patch-dsh-client.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

const LOOPBACK_SNIPPET = 'const x = isLoopbackHostname(pageLocation.hostname);';
// Сигнатура 0.2.1-alpha.1 и раньше
const AUTH_SNIPPET = 'class C {\n\tisAuthenticated(request) {\n\t\treturn false;\n\t}\n}\n';
// Сигнатура с 0.2.1-alpha.2: добавлен параметр secure (якорь обязан быть совместим и со старым, и с новым видом)
const AUTH_SNIPPET_NEW = 'class C {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n';
const COMBO_SNIPPET = 'class R {\n\tbundleResource(method, url) {\n\t\tconst resourceUrl = url;\n\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);\n\t\treturn response;\n\t}\n}\n';

function makeSandbox(name, { breakAuth = false, authSnippet = AUTH_SNIPPET, dshVersion = '0.2.1-alpha.2' } = {}) {
  const base = path.join(os.tmpdir(), `dsh-patch-${name}-${Date.now()}`);
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => {
    const p = path.join(mods, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion }));
  write('dsh-client-ui-layout/lib/client.js', LOOPBACK_SNIPPET + '\n');
  write('dsh-client-connection/lib/index.js', breakAuth ? 'class C {\n\tother() {}\n}\n' : authSnippet);
  write('dsh-client-modules/lib/index.js', COMBO_SNIPPET);
  return base;
}

function runPatch(base) {
  return spawnSync('node', [SCRIPT], {
    env: {
      ...process.env,
      // Сканируем только каталог-песочницу, чтобы другие копии DSH из окружения
      // (возможно уже пропатченные) не мешали оценке
      DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai')
    },
    encoding: 'utf8'
  });
}

console.log('\n=== A. Все якоря на месте → должен быть успех ===');
const good = makeSandbox('good');
const rA = runPatch(good);
ok(rA.status === 0, `код выхода 0 (факт ${rA.status})`);
ok(/Все обязательные патчи применены/.test(rA.stdout || ''), 'вывод содержит «Все обязательные патчи применены»');
ok(/применено=\[[^\]]*auth-bypass/.test(rA.stdout || ''), 'auth-bypass помечен применённым');
ok(/применено=\[[^\]]*combo-fallback/.test(rA.stdout || ''), 'combo-fallback помечен применённым');
ok(/применено=\[[^\]]*client-loopback/.test(rA.stdout || ''), 'client-loopback помечен применённым');

console.log('\n=== B. Сломан якорь auth → FATAL и ненулевой выход ===');
const bad = makeSandbox('bad', { breakAuth: true });
const rB = runPatch(bad);
const rBOut = (rB.stdout || '') + (rB.stderr || '');
ok(rB.status !== 0, `код выхода не 0 (факт ${rB.status})`);
ok(/\[FATAL\]/.test(rBOut), 'вывод содержит [FATAL]');
ok(/auth-bypass/.test(rBOut), 'указано имя неприменённого патча auth-bypass');

console.log('\n=== C. Новая сигнатура 0.2.1-alpha.2 isAuthenticated(request, secure = false) → должен быть успех ===');
const newer = makeSandbox('newer', { authSnippet: AUTH_SNIPPET_NEW });
const rC = runPatch(newer);
ok(rC.status === 0, `код выхода 0 (факт ${rC.status})`);
ok(/Все обязательные патчи применены/.test(rC.stdout || ''), 'вывод содержит «Все обязательные патчи применены»');
ok(/применено=\[[^\]]*auth-bypass/.test(rC.stdout || ''), 'auth-bypass помечен применённым (новая сигнатура)');

console.log('\n=== D. Версия в баннере следует за сканируемым деревом (R4: не читать другой DSH из окружения) ===');
const vtree = makeSandbox('vtree', { dshVersion: '9.9.9-probe' });
const rD = runPatch(vtree);
const rDOut = (rD.stdout || '') + (rD.stderr || '');
ok(rD.status === 0, `код выхода 0 (факт ${rD.status})`);
ok(/DSH версия: 9\.9\.9-probe/.test(rDOut), 'баннер показывает версию сканируемого дерева 9.9.9-probe (а не старую версию из /usr/local)');
ok(/Источник: .*vtree/.test(rDOut), 'баннер указывает источник версии — каталог-песочницу');
ok(/Все обязательные патчи применены/.test(rDOut), 'обязательные патчи по-прежнему все применены');

fs.rmSync(good, { recursive: true, force: true });
fs.rmSync(bad, { recursive: true, force: true });
fs.rmSync(newer, { recursive: true, force: true });
fs.rmSync(vtree, { recursive: true, force: true });
console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
