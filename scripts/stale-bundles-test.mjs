#!/usr/bin/env node
/**
 * Регрессионный тест: автоматическая вычистка «неразрешимых» ghost-записей bundle в профиле.
 *
 * Предыстория: официально с 0.1.7 `@deepseek-ai/dsh-experimental-agent-team-web-profile` влит в
 * `@deepseek-ai/dsh-experimental-agent-team-profile`. После апгрейда образа в
 * `dsh.profile.bundles` профиля остаётся старое имя пакета, и DSH при каждой загрузке
 * печатает `skipping profile bundle ...`.
 *
 * Покрытие:
 *   единичное (напрямую вызывает scripts/stale-bundles.cjs)
 *     A. консервативный режим: вычищает ghost из известного списка снятых; разрешимые/внесписочные
 *        записи сохраняются; порядок не меняется
 *     B. идемпотентность: повторный запуск больше ничего не убирает
 *     C. защищённые core-bundle не вычищаются даже при неразрешимости
 *     D. отсутствующие/пустые bundles — без операций; семантика pruneMode / extraRemovedNames
 *     E. критерий разбора выровнен с официальным: реальный установочный якорь разрешает
 *        @deepseek-ai/dsh-base, ghost не разрешается
 *     F. безопасность P6: режим по умолчанию не трогает внесписочные неразрешимые записи
 *        (защита конкурентных писателей); вычищает только агрессивный режим
 *   интеграция (гоняет настоящий scripts/install-plugin.mjs, временный DSH_HOME)
 *     G. при старте сборки режим по умолчанию автоматически убирает ghost и пишет лог
 *     H. при DSH_PRUNE_STALE_BUNDLES=0 автовычистка выключена
 *     I. режим по умолчанию не удаляет внесписочные записи от конкурентных/третьих сторон
 *        (без потери обновлений)
 *
 * Запуск: node scripts/stale-bundles-test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'scripts/install-plugin.mjs');
const {
  pruneStaleBundles,
  isBundleResolvable,
  pruneMode,
  extraRemovedNames,
  parseExtraList,
  resolvePruneConfig,
  DEFAULT_PROTECTED_BUNDLES,
  KNOWN_REMOVED_BUNDLES
} = require('./stale-bundles.cjs');

const GHOST = '@deepseek-ai/dsh-experimental-agent-team-web-profile';
const SIDE = 'dsh-side-plugin'; // внесписочная, неразрешимая запись, имитирующая «конкурентного писателя»

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (получено ${JSON.stringify(a)})`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-bundles-'));

/** Создаёт каталог профиля и кладёт в его node_modules несколько «разрешимых через якорь профиля» фейк-пакетов. */
function makeProfileDir(name, resolvable = []) {
  const profileDir = path.join(tmpRoot, name, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  for (const pkgName of resolvable) {
    const dir = path.join(profileDir, 'node_modules', pkgName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0' }) + '\n');
  }
  return profileDir;
}

// ── A. Консервативный режим, смешанный сценарий ──
console.log('\n=== A. Консервативный режим: вычищает известный ghost, сохраняет остальное, порядок не меняется ===');
{
  const profileDir = makeProfileDir('unitA', ['@fake/ok']);
  const bundles = ['@deepseek-ai/dsh-base', '@fake/ok', GHOST, SIDE, '@deepseek-ai/dsh-web-app'];
  const pkg = { dependencies: {}, dsh: { profile: { bundles: [...bundles] } } };
  const r = pruneStaleBundles(pkg, { profileDir });
  eq(r.pruned, [GHOST], 'вычищается только известный ghost');
  eq(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@fake/ok', SIDE, '@deepseek-ai/dsh-web-app'], 'внесписочные записи и порядок полностью сохраняются');
  ok(KNOWN_REMOVED_BUNDLES.includes(GHOST), 'GHOST входит в известный список снятых');
}

// ── B. Идемпотентность ──
console.log('\n=== B. Идемпотентность: повторный запуск ничего не убирает ===');
{
  const profileDir = makeProfileDir('unitB', []);
  const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', GHOST] } } };
  const r1 = pruneStaleBundles(pkg, { profileDir });
  const r2 = pruneStaleBundles(pkg, { profileDir });
  eq(r1.pruned, [GHOST], 'первый прогон убирает ghost');
  eq(r2.pruned, [], 'второй прогон — без операций (идемпотентно)');
  eq(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base'], 'итоговые bundles стабильны');
}

// ── C. Защищённые core-bundle ──
console.log('\n=== C. Защищённые core-bundle не вычищаются даже при неразрешимости ===');
{
  const profileDir = makeProfileDir('unitC', []);
  const pkg = { dsh: { profile: { bundles: [...DEFAULT_PROTECTED_BUNDLES] } } };
  const r = pruneStaleBundles(pkg, { profileDir, installAnchors: [] }); // без якоря ⇒ наверняка «неразрешимо»
  eq(r.pruned, [], 'core-bundle не вычищены');
  eq(pkg.dsh.profile.bundles, [...DEFAULT_PROTECTED_BUNDLES], 'core-bundle сохранены');
}

// ── D. Без операций и семантика конфигурации ──
console.log('\n=== D. Отсутствующие/пустые bundles — без операций; семантика pruneMode / extraRemovedNames ===');
{
  const profileDir = makeProfileDir('unitD', []);
  eq(pruneStaleBundles({ dsh: {} }, { profileDir }).pruned, [], 'без dsh.profile.bundles — без операций');
  eq(pruneStaleBundles({ dsh: { profile: { bundles: [] } } }, { profileDir }).pruned, [], 'пустые bundles — без операций');
  ok(pruneMode({}) === 'known', 'по умолчанию консервативный режим (known)');
  ok(pruneMode({ DSH_PRUNE_STALE_BUNDLES: 'all' }) === 'all', '=all агрессивный режим');
  ok(pruneMode({ DSH_PRUNE_STALE_BUNDLES: '0' }) === 'off', '=0 выключено');
  ok(pruneMode({ DSH_PRUNE_STALE_BUNDLES: 'false' }) === 'off', '=false выключено');
  eq(extraRemovedNames({ DSH_PRUNE_BUNDLES_EXTRA: 'a, b ,c' }), ['a', 'b', 'c'], 'разбор extra-списка');
  const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@fake/extra'] } } };
  eq(pruneStaleBundles(pkg, { profileDir, extraNames: ['@fake/extra'] }).pruned, ['@fake/extra'], 'записи из extra-списка вычищаются');
}

// ── E. Критерий разбора выровнен с официальным установочным якорем ──
console.log('\n=== E. Критерий разбора выровнен с официальным (реальный якорь установки DSH) ===');
{
  const profileDir = makeProfileDir('unitE', []);
  ok(isBundleResolvable('@deepseek-ai/dsh-base', profileDir, undefined) === true, 'установочный bundle @deepseek-ai/dsh-base разрешим');
  ok(isBundleResolvable('@deepseek-ai/dsh-experimental-agent-team-profile', profileDir, undefined) === true, 'объединённый agent-team-profile разрешим');
  ok(isBundleResolvable(GHOST, profileDir, undefined) === false, 'ghost web-profile неразрешим');
}

// ── F. Безопасность P6: режим по умолчанию не трогает внесписочные записи ──
console.log('\n=== F. Безопасность P6: консервативный режим по умолчанию не удаляет внесписочные записи; агрессивный — да ===');
{
  const profileDir = makeProfileDir('unitF', []);
  const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SIDE] } } };
  const r = pruneStaleBundles(pkg, { profileDir });
  eq(r.pruned, [], 'режим по умолчанию не вычищает внесписочные неразрешимые записи');
  ok(pkg.dsh.profile.bundles.includes(SIDE), 'внесписочная запись сохранена (защита конкурентных писателей)');

  const pkg2 = { dependencies: { 'declared-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SIDE, 'declared-plugin'] } } };
  const r2 = pruneStaleBundles(pkg2, { profileDir, mode: 'all' });
  eq(r2.pruned, [SIDE], 'агрессивный режим вычищает необъявленные неразрешимые записи');
  eq(r2.declared, ['declared-plugin'], 'агрессивный режим сохраняет объявленные «ожидающие установки» записи');
}

// ── F2. Разбор политики: env > сохранённая конфигурация > по умолчанию ──
console.log('\n=== F2. resolvePruneConfig: env > сохранённая > по умолчанию, extra — объединение ===');
{
  eq(resolvePruneConfig({}, {}), { mode: 'known', extraNames: [] }, 'по умолчанию known / без extra');
  eq(resolvePruneConfig({ DSH_PRUNE_STALE_BUNDLES: 'all' }, {}).mode, 'all', 'env действует');
  eq(resolvePruneConfig({}, { pruneStaleBundles: 'all' }).mode, 'all', 'сохранённая конфигурация действует');
  eq(resolvePruneConfig({ DSH_PRUNE_STALE_BUNDLES: 'off' }, { pruneStaleBundles: 'all' }).mode, 'off', 'env приоритетнее сохранённой');
  eq(resolvePruneConfig({}, { pruneStaleBundles: '0' }).mode, 'off', 'сохранённая 0 → off');
  eq(resolvePruneConfig({ DSH_PRUNE_BUNDLES_EXTRA: 'a' }, { pruneBundlesExtra: 'b,c' }).extraNames, ['a', 'b', 'c'], 'extra-список — объединение');
  eq(parseExtraList(' x , y ,'), ['x', 'y'], 'parseExtraList из строки');
  eq(parseExtraList(['x', ' y ']), ['x', 'y'], 'parseExtraList из массива');
}

// ── Интеграция: гоняем настоящий install-plugin.mjs ──
function makeHome(name, { deps = [], bundles = [] } = {}) {
  const home = path.join(tmpRoot, name);
  const profileDir = path.join(home, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: Object.fromEntries(deps.map((d) => [d, 'link:' + path.join(tmpRoot, 'market', d)])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles] } }
  }, null, 2) + '\n');
  return { home, profileDir };
}
function runInstaller({ home, profileDir }, extraEnv = {}) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE_DIR: profileDir,
      DSH_MARKET_PLUGIN_ROOT: path.join(tmpRoot, 'market'),
      ...extraEnv
    },
    encoding: 'utf8'
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
const readBundles = (profileDir) => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles;

console.log('\n=== G. Сборка при старте: режим по умолчанию автоматически вычищает ghost-bundle и пишет лог ===');
{
  const env = makeHome('intG', { bundles: [GHOST, '@deepseek-ai/dsh-experimental-agent-team-profile'] });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(!b.includes(GHOST), 'ghost-запись убрана из bundles');
  ok(b.includes('@deepseek-ai/dsh-experimental-agent-team-profile'), 'объединённый agent-team-profile сохранён');
  ok(r.out.includes('ghost-записи bundle профиля') && r.out.includes(GHOST), 'лог явно сообщает о вычистке и имени пакета');
}

console.log('\n=== H. DSH_PRUNE_STALE_BUNDLES=0 отключает автовычистку ===');
{
  const env = makeHome('intH', { bundles: [GHOST] });
  const r = runInstaller(env, { DSH_PRUNE_STALE_BUNDLES: '0' });
  const b = readBundles(env.profileDir);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(b.includes(GHOST), 'при отключении флага ghost-запись сохранена (не вычищена)');
  ok(!r.out.includes('ghost-записи bundle профиля'), 'в логе нет отчёта о вычистке');
}

console.log('\n=== I. Режим по умолчанию не удаляет внесписочный bundle от конкурентных/третьих сторон (без потери обновлений) ===');
{
  const env = makeHome('intI', { bundles: [SIDE] });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(b.includes(SIDE), 'внесписочная запись dsh-side-plugin не удалена');
}

// Пишем во временный файл сохранённую конфигурацию шлюза (имитация сохранения на странице
// Admin «Шлюз и конфигурация системы»)
function writeGatewayConfig(home, cfg) {
  const p = path.join(home, '.dsh/gateway.config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

console.log('\n=== J. сохранённая конфигурация pruneStaleBundles=all → при сборке вычищаются внесписочные записи ===');
{
  const env = makeHome('intJ', { bundles: [SIDE, GHOST] });
  writeGatewayConfig(env.home, { pruneStaleBundles: 'all' });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(!b.includes(SIDE) && !b.includes(GHOST), 'агрессивный режим (из сохранённой конфигурации) вычистил обе неразрешимые записи');
  ok(r.out.includes('режим: all'), 'в логе указан действующий режим all');
}

console.log('\n=== K. сохранённая pruneStaleBundles=off → вычистки нет; env перекрывает сохранённое ===');
{
  const env = makeHome('intK', { bundles: [GHOST] });
  writeGatewayConfig(env.home, { pruneStaleBundles: 'off' });
  const r = runInstaller(env);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(readBundles(env.profileDir).includes(GHOST), 'сохранённый off → ghost сохранён');

  const env2 = makeHome('intK2', { bundles: [GHOST] });
  writeGatewayConfig(env2.home, { pruneStaleBundles: 'off' });
  const r2 = runInstaller(env2, { DSH_PRUNE_STALE_BUNDLES: 'known' });
  ok(r2.status === 0, 'код выхода сборочного скрипта 0');
  ok(!readBundles(env2.profileDir).includes(GHOST), 'env=known перекрывает сохранённый off → ghost вычищен');
}

console.log('\n=== L. Статическая обвязка: пункт Admin / поле шлюза / чтение сборочным скриптом ===');
{
  const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  ok(readSrc('scripts/install-plugin.mjs').includes('resolvePruneConfig'), 'install-plugin использует resolvePruneConfig');
  ok(readSrc('scripts/install-plugin.mjs').includes('gateway.config.json'), 'install-plugin читает сохранённую конфигурацию шлюза');
  ok(readSrc('gateway/index.js').includes('pruneStaleBundles'), 'gateway читает/пишет pruneStaleBundles');
  ok(readSrc('gateway/index.js').includes('pruneBundlesExtra'), 'gateway читает/пишет pruneBundlesExtra');
  ok(readSrc('gateway/public/admin.html').includes('editPruneStaleBundles'), 'Admin даёт выпадающий список режимов');
  ok(readSrc('gateway/public/admin.html').includes('editPruneBundlesExtra'), 'Admin даёт ввод extra-списка');
}

console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
