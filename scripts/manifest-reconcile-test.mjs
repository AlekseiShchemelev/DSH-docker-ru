/**
 * P6 (семантический аспект) регрессионный тест: сборочный скрипт обязан уважать
 * состояние плагинов от «внешних писателей» (нативный менеджер плагинов DSH).
 *
 * Предыстория: нативный менеджер, включая/отключая плагин, меняет только bundles
 * и не пишет наш plugins-state.json. При старом поведении при перезапуске контейнера
 * install-plugin.mjs считал плагин с «зависимостью на месте, но вынутой из bundles»
 * «ни разу не собранным» и возвращал его автоматически — молча откатывая решение
 * пользователя об отключении (воспроизведено и на удалёнке).
 *
 * Покрытие (гонит настоящий scripts/install-plugin.mjs, временный DSH_HOME и временный
 * корень маркетплейса):
 *   A. новый том данных: предустановленные плагины собираются автоматически
 *      (работа «из коробки» не ломается)
 *   B. внешнее отключение (deps есть + bundles нет): не «воскресает», пишется plugins-state.json
 *   C. внешнее удаление (deps нет + bundles нет + есть в known): не «воскресает», ставится uninstalled
 *   D. внешнее повторное включение (deps есть + bundles есть): наши флаги disabled/uninstalled снимаются
 *   E. наше собственное отключение (путь Admin): остаётся отключённым
 *
 * Запуск: node scripts/manifest-reconcile-test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'scripts/install-plugin.mjs');
const BD = '@dsh-custom/dsh-browser-desktop';
const MARKET = ['dshmarket', '@hytime/dsh-thinking-effort'];

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-reconcile-'));
const marketRoot = path.join(tmpRoot, 'market-root');
for (const p of MARKET) {
  fs.mkdirSync(path.join(marketRoot, p), { recursive: true });
  fs.writeFileSync(path.join(marketRoot, p, 'package.json'), JSON.stringify({ name: p, version: '1.0.0' }, null, 2) + '\n');
}
// Источник встроенного плагина (соответствует /app/plugins/dsh-browser-desktop в образе)
const pluginSource = path.join(tmpRoot, 'app-plugins/dsh-browser-desktop');
fs.mkdirSync(pluginSource, { recursive: true });
fs.writeFileSync(path.join(pluginSource, 'package.json'), JSON.stringify({ name: BD, version: '0.1.1' }, null, 2) + '\n');

function makeHome(name, { deps = [], bundles = [], state = null } = {}) {
  const home = path.join(tmpRoot, name);
  const profileDir = path.join(home, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: Object.fromEntries(deps.map((d) => [d, 'link:' + path.join(marketRoot, d)])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles] } }
  }, null, 2) + '\n');
  if (state) {
    fs.writeFileSync(path.join(home, '.dsh/plugins-state.json'), JSON.stringify(state, null, 2) + '\n');
  }
  return { home, profileDir };
}

function runInstaller({ home, profileDir }) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE_DIR: profileDir,
      DSH_MARKET_PLUGIN_ROOT: marketRoot,
      // Заставляем встроенный плагин тоже ходить во временный исходный каталог:
      // в скрипте customPath жёстко равен /app/plugins, и если здесь его нет, симлинк
      // пропускается, но bundles-логика всё равно отрабатывает — закрываем это softlink-путь
    },
    encoding: 'utf8'
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

const readBundles = (profileDir) => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles;
const readState = (home) => {
  const p = path.join(home, '.dsh/plugins-state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

// ── A. Новый том данных: предустановленные плагины собираются автоматически ──
console.log('\n=== A. Новый том данных → автоматическая сборка предустановленных плагинов ===');
{
  const env = makeHome('fresh', { deps: [], bundles: [] });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(MARKET.every((n) => b.includes(n)), `предустановленные маркет-плагины собраны (${b.filter((x) => MARKET.includes(x)).join(', ')})`);
  const st = readState(env.home);
  ok(Boolean(st && Array.isArray(st.known) && MARKET.every((n) => st.known.includes(n))), 'plugins-state.json содержит список known');
}

// ── B. Внешнее отключение: не «воскресать» ──
console.log('\n=== B. Внешнее отключение (deps есть + bundles нет) → не «воскресать» ===');
{
  const env = makeHome('extDisabled', {
    deps: ['dshmarket', ...MARKET.slice(1)],
    bundles: [],                       // уже вынут из bundles нативным UI
    state: { disabled: [], uninstalled: [], known: ['dshmarket', ...MARKET.slice(1)] }
  });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  const st = readState(env.home);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(!b.includes('dshmarket'), 'dshmarket не возвращён в bundles (отключение пользователя уважено)');
  ok(st.disabled.includes('dshmarket'), 'внешнее отключение синхронизировано в plugins-state.json');
  ok(r.out.includes('отключён (внешне)'), 'лог явно сообщает о распознанном внешнем отключении');
}

// ── C. Внешнее удаление: не «воскресать» ──
console.log('\n=== C. Внешнее удаление (deps нет + bundles нет + есть в known) → не «воскресать» ===');
{
  const env = makeHome('extUninstalled', {
    deps: [],
    bundles: [],
    state: { disabled: [], uninstalled: [], known: ['dshmarket'] }
  });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  const st = readState(env.home);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(!b.includes('dshmarket'), 'dshmarket не возвращён в bundles (удаление пользователя уважено)');
  ok(st.uninstalled.includes('dshmarket'), 'внешнее удаление синхронизировано в plugins-state.json');
}

// ── D. Внешнее повторное включение: наши флаги снимаются ──
console.log('\n=== D. Внешнее повторное включение (deps есть + bundles есть) → снятие флагов отключения ===');
{
  const env = makeHome('extEnabled', {
    deps: ['dshmarket'],
    bundles: ['dshmarket'],
    state: { disabled: ['dshmarket'], uninstalled: ['dshmarket'], known: ['dshmarket'] }
  });
  const r = runInstaller(env);
  const st = readState(env.home);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(!st.disabled.includes('dshmarket'), 'флаг disabled снят');
  ok(!st.uninstalled.includes('dshmarket'), 'флаг uninstalled снят');
}

// ── E. Наше собственное отключение остаётся ──
console.log('\n=== E. отключение со стороны Admin (deps есть + bundles нет + наш флаг disabled) → остаётся отключённым ===');
{
  const env = makeHome('oursDisabled', {
    deps: ['dshmarket'],
    bundles: [],
    state: { disabled: ['dshmarket'], uninstalled: [], known: ['dshmarket'] }
  });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  const st = readState(env.home);
  ok(r.status === 0, 'код выхода сборочного скрипта 0');
  ok(!b.includes('dshmarket'), 'dshmarket не возвращён');
  ok(st.disabled.includes('dshmarket'), 'флаг disabled сохранён');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
process.exit(fail ? 1 : 0);
