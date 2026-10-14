/**
 * Юнит-тест «авторитетной конфигурации» dsh-browser-desktop (без X / без gateway, запускается локально).
 *
 * Новая модель (по предложению пользователя):
 *   - авторитетная конфигурация = файл gateway.config.json, сохраняемый шлюзом (никакого поллинга,
 *     никакой HTTP-синхронизации);
 *   - плагин читает файл при **запуске** и перед **каждым вызовом инструмента**;
 *   - итог: вызовы после отключения отклоняются сразу; увеличение/уменьшение пунктов меню
 *     фиксируется при **перезапуске сервиса (повторном apply)**.
 *
 * Запуск: node scripts/plugin-enabled-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-'));
const CFG = path.join(TMP, 'gateway.config.json');
process.env.GATEWAY_CONFIG_FILE = CFG;
// Изолируем побочные эффекты: при «отключении» плагин отправляет шлюзу один stop.
// Указываем внутренний шлюз на заведомо недоступный порт, чтобы этот юнит-тест был полностью
// «без побочных эффектов» (в реальном контейнере так тоже не выключится онлайн-рабочий стол).
process.env.PROXY_PORT = '9';
const writeCfg = (desktop) => fs.writeFileSync(CFG, JSON.stringify({ desktop, vncPath: '/vnc' }, null, 2));

const PLUGIN = new URL('../plugins/dsh-browser-desktop/index.js', import.meta.url).href;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; throw new Error('Ошибка утверждения: ' + msg); }
}

function makeCtx() {
  const state = { tools: new Map(), prompt: new Map(), disposeHandlers: [], settingsRegisterCalls: 0, legacySection: undefined };
  const ctx = {
    tools: { register: (def) => { state.tools.set(def.name, def); return () => state.tools.delete(def.name); } },
    systemPrompt: { section: (s) => { state.prompt.set(s.name, s); return () => state.prompt.delete(s.name); } },
    // Новая модель: плагин **не регистрирует** пространство настроек DSH (register служит только
    // для утверждения «не вызывался»), миграция старых значений читает только исходную user-section.
    settings: {
      register: () => { state.settingsRegisterCalls++; return { get: () => ({}), watch: () => (() => {}) }; },
      section: () => state.legacySection
    },
    on: (event, cb) => { if (event === 'dispose') state.disposeHandlers.push(cb); }
  };
  return { ctx, state };
}

async function main() {
  const mod = await import(PLUGIN);
  writeCfg({ enabled: true, width: 1920, height: 1080, enableCdp: true, cdpPort: 9222, idleTimeoutMinutes: 30, screenshotQuality: 'high', screenshotDir: '', enableSidebarTab: false });

  console.log('\n=== A. Конфигурация включена: при запуске регистрируются 3 инструмента + внедрён промпт (без ожидания) ===');
  const A = makeCtx();
  mod.apply(A.ctx, {});
  ok(A.state.tools.size === 3, 'зарегистрировано 3 инструмента браузера');
  ok(A.state.prompt.has('tool:browser_tools'), 'внедрена секция системного промпта');
  ok(A.state.settingsRegisterCalls === 0, 'пространство настроек DSH не регистрируется (никаких «изменённых, но не действующих» ghost-настроек)');

  console.log('\n=== B. Панель управления перевела в отключён → вызов сразу отклоняется (чтение локального файла, ноль сети) ===');
  writeCfg({ enabled: false });
  const err = await A.state.tools.get('browser_open').execute({ url: 'https://example.com' }, {}).then(() => null, e => e);
  ok(err && /отключ/.test(err.message), 'вызов отклонён, ошибка понятная: ' + (err && err.message));
  ok(A.state.tools.size === 0, 'при этом все инструменты сняты с регистрации (этот экземпляр больше их не держит)');

  console.log('\n=== C. Повторное включение + перезапуск сервиса (повторный apply) → инструменты восстановлены ===');
  writeCfg({ enabled: true });
  const C = makeCtx();
  mod.apply(C.ctx, {});
  ok(C.state.tools.size === 3, 'после перезапуска снова зарегистрировано 3 инструмента');
  ok(C.state.prompt.has('tool:browser_tools'), 'секция промпта восстановлена');

  console.log('\n=== D. Уже отключённое состояние при запуске → ноль регистраций (после перезапуска меню точное) ===');
  writeCfg({ enabled: false });
  const D = makeCtx();
  mod.apply(D.ctx, {});
  ok(D.state.tools.size === 0, 'не регистрируется ни одного инструмента');
  ok(!D.state.prompt.has('tool:browser_tools'), 'секция промпта не внедряется');

  console.log('\n=== E. При отсутствии/повреждении файла конфигурации сохраняется значение по умолчанию (включено), без ложных срабатываний ===');
  fs.rmSync(CFG);
  const E = makeCtx();
  mod.apply(E.ctx, {});
  ok(E.state.tools.size === 3, 'при недоступности конфигурации работаем по умолчанию как включённые');

  console.log('\n=== F. Очистка по dispose ===');
  E.state.disposeHandlers.forEach(h => h());
  ok(E.state.tools.size === 0, 'после dispose инструменты сняты с регистрации');
  ok(!E.state.prompt.has('tool:browser_tools'), 'после dispose секция промпта удалена');

  console.log('\n=== G. Очистка ghost-конфигурации: миграция читает только исходную section, пространство не регистрируется ===');
  const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mark-'));
  process.env.BROWSER_DESKTOP_LEGACY_MARKER = path.join(markDir, 'm1');
  process.env.BROWSER_DESKTOP_LEGACY_MARKER_FALLBACK = path.join(markDir, 'm2');
  writeCfg({ enabled: true });
  let sectionCalls = 0;
  const G = makeCtx();
  G.ctx.settings.section = (ns) => { sectionCalls++; return undefined; };
  mod.apply(G.ctx, {});
  await new Promise(r => setTimeout(r, 50));
  ok(G.state.settingsRegisterCalls === 0, 'пространство по-прежнему не регистрируется');
  ok(sectionCalls === 1, 'миграция прочитала исходную section(browser-desktop)');
  ok(fs.existsSync(process.env.BROWSER_DESKTOP_LEGACY_MARKER), 'маркер миграции ставится и при отсутствии старых значений (идемпотентно, один раз)');

  fs.rmSync(markDir, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Исключение в тесте:', err.message); process.exit(1); });
