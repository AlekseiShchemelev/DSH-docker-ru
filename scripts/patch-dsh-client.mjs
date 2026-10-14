#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Для тестов/отладки: при наличии DSH_PATCH_ONLY_DIR сканируется только этот каталог,
// чтобы случайно не задеть другие экземпляры DSH в окружении
const ONLY_DIR = process.env.DSH_PATCH_ONLY_DIR;
const SEARCH_DIRS = ONLY_DIR ? [ONLY_DIR] : [
  process.env.DSH_INSTALL_DIR ? path.join(process.env.DSH_INSTALL_DIR, 'lib/node_modules/@deepseek-ai') : null,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/usr/local/lib/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai',
  '/app/node_modules/@deepseek-ai'
].filter(Boolean);

const MARKER = '/* dsh-patch: loopback-host-mode-applied */';

// ── Трекинг обязательных патчей ──────────────────────────────────────────────
// Предыстория: скрипт патчит исходники DSH по строковым якорям; при апгрейде DSH
// якоря могут перестать работать. Раньше промах был «молчаливый пропуск + итоговый
// успех в конце», проект уже дважды наступал из-за этого; теперь промах = явный FATAL.
const REQUIRED_PATCHES = ['client-loopback', 'auth-bypass', 'combo-fallback'];
const appliedPatches = new Set();
const missedPatches = new Set();
const markApplied = (name) => appliedPatches.add(name);
const markMissed = (name) => missedPatches.add(name);
let loopbackSeen = false;

/**
 * Читает версию DSH «именно той дерева, которое сейчас сканируется» (для сверки с
 * совместимым диапазоном version.json).
 * Обязательно сначала следует DSH_PATCH_ONLY_DIR / DSH_INSTALL_DIR: иначе при
 * офлайн-аудите (DSH_PATCH_ONLY_DIR указывает на какую-то установочную дерево) будет
 * прочитан другой экземпляр DSH из окружения (например старая версия в /usr/local),
 * и версия в баннере разойдётся с реальным объектом сканирования — легко ошибиться
 * (история-грабли R4).
 */
function readInstalledDshVersion() {
  const candidates = [
    ONLY_DIR ? path.join(ONLY_DIR, 'dsh/package.json') : null,
    process.env.DSH_INSTALL_DIR ? path.join(process.env.DSH_INSTALL_DIR, 'lib/node_modules/@deepseek-ai/dsh/package.json') : null,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      return { version: JSON.parse(fs.readFileSync(p, 'utf8')).version || null, source: p };
    } catch {}
  }
  return { version: null, source: null };
}

/**
 * Читает метаданные совместимого диапазона. При офлайн-аудите (DSH_PATCH_ONLY_DIR)
 * в приоритете version.json самого репозитория, в контейнере — /app/version.json;
 * можно явно переопределить через DSH_VERSION_JSON.
 */
function readCompatRange() {
  const candidates = [
    process.env.DSH_VERSION_JSON,
    ONLY_DIR ? path.join(SCRIPT_DIR, '../version.json') : null,
    '/app/version.json',
    path.join(SCRIPT_DIR, '../version.json')
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const range = (JSON.parse(fs.readFileSync(p, 'utf8')).compatibility || {}).supportedDshRange;
      if (range) return { range, source: p };
    } catch {}
  }
  return { range: null, source: null };
}

/** Сверка с supportedDshRange из version.json (только предупреждение, запуск не блокирует) */
function warnIfVersionOutOfRange() {
  try {
    const { version: ver, source: verSrc } = readInstalledDshVersion();
    const { range, source: rangeSrc } = readCompatRange();
    if (!ver || !range) return;
    console.log(`[patch-dsh-client] DSH версия: ${ver} (Источник: ${verSrc}), заявленный совместимый диапазон: ${range} (Источник: ${rangeSrc})`);
  } catch (e) {
    console.warn('[patch-dsh-client] Проверка диапазона версии пропущена:', e.message);
  }
}

// Якорь auth-bypass: сигнатура метода дрейфует по версиям DSH, пробуем по порядку «новая→старая».
//   - с 0.2.1-alpha.2: `isAuthenticated(request, secure = false) {` (добавлен параметр secure, усиление аутентификации браузера)
//   - 0.2.1-alpha.1 и раньше: `isAuthenticated(request) {`
// Это **единственное** определение isAuthenticated в dsh-client-connection (класс BrowserAuth,
// в alpha.2 см. lib/index.js:484). HostConnectionService.requestRejection / authorizeIndex
// обращаются к нему через this.browserAuth.isAuthenticated(...), поэтому инжекта return true
// в этой единственной точке достаточно, чтобы закрыть все 401-проверки (403-ограда Host/Origin
// по-прежнему независимо сторожится isTrustedApiRequest и к этому патчу отношения не имеет).
const AUTH_BYPASS_SIGNATURES = [
  'isAuthenticated(request, secure = false) {',
  'isAuthenticated(request) {'
];

const REPLACEMENTS = [
  {
    needle: 'isLoopbackHostname(pageLocation.hostname)',
    replacement: 'true'
  },
  {
    // Реальная форма в 0.1.6/0.1.7: ctx.remote.$host.isLoopback ? "host" : "memory"
    // (старый вариант connection.isLoopback в обеих версиях отсутствует — это мёртвый
    //   якорь из прошлого; здесь — реальный needle, чтобы host-персистентность
    //   больше не зависела от косвенной цепочки isLoopback)
    needle: 'ctx.remote.$host.isLoopback ? "host" : "memory"',
    replacement: '"host"'
  }
];

function findClientFiles(baseDir) {
  const matched = [];
  if (!fs.existsSync(baseDir)) return matched;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile() && ent.name === 'client.js') {
        matched.push(fullPath);
      }
    }
  }

  walk(baseDir);
  return matched;
}

function patchServerConnection(baseDir) {
  // 1. Серверная аутентификация: аутентификацией целиком заведует шлюз —
  //    полностью убираем 401-перехваты обмена токена в /api и WebSocket
  const connTarget = path.join(baseDir, 'dsh-client-connection/lib/index.js');
  if (fs.existsSync(connTarget)) {
    try {
      let cContent = fs.readFileSync(connTarget, 'utf8');
      if (cContent.includes('/* dsh-patch: auth-bypass-all */')) {
        markApplied('auth-bypass');
      } else {
        const signature = AUTH_BYPASS_SIGNATURES.find((sig) => cContent.includes(sig));
        if (signature) {
          cContent = cContent.replace(
            signature,
            signature + '\n\t\t/* dsh-patch: auth-bypass-all */ return true;'
          );
          fs.writeFileSync(connTarget, cContent, 'utf8');
          markApplied('auth-bypass');
          console.log(`[patch-dsh-client] Успешно пропатчено серверное подключение без аутентификации (единая аутентификация шлюза): ${connTarget}`);
        } else {
          markMissed('auth-bypass');
          console.warn(`[patch-dsh-client] ⚠️ Обязательный патч auth-bypass не применён (якорь устарел): ${connTarget}`);
        }
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] Ошибка пропатча серверного пропуска: ${err.message}`);
    }
  }

  // 2. Тонкая настройка корневого пути выбора каталога (если присутствует)
  const pickerTarget = path.join(baseDir, 'dsh-host-directory-picker-browse/lib/index.js');
  if (fs.existsSync(pickerTarget)) {
    try {
      let pContent = fs.readFileSync(pickerTarget, 'utf8');
      if (pContent.includes('const home = homedir();') && !pContent.includes('process.env.DSH_WORKSPACE')) {
        pContent = pContent.replace('const home = homedir();', 'const home = process.env.DSH_WORKSPACE || homedir();');
        fs.writeFileSync(pickerTarget, pContent, 'utf8');
        console.log(`[patch-dsh-client] Успешно выровнен корневой путь выбора каталога на DSH_WORKSPACE: ${pickerTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] Ошибка выравнивания выбора каталога: ${err.message}`);
    }
  }
}

let patchedCount = 0;
let checkedDirs = 0;

for (const searchDir of SEARCH_DIRS) {
  if (!fs.existsSync(searchDir)) continue;
  checkedDirs++;
  console.log(`[patch-dsh-client] Сканируем каталог модулей: ${searchDir}`);
  
  // 1. Client patch (host mode & loopback)
  const clientFiles = findClientFiles(searchDir);
  for (const file of clientFiles) {
    try {
      let content = fs.readFileSync(file, 'utf8');
      if (content.includes(MARKER)) {
        loopbackSeen = true;
        continue;
      }

      let modified = false;
      for (const { needle, replacement } of REPLACEMENTS) {
        if (content.includes(needle)) {
          content = content.replaceAll(needle, replacement);
          modified = true;
        }
      }

      if (modified) {
        content = `${MARKER}\n${content}`;
        fs.writeFileSync(file, content, 'utf8');
        console.log(`[patch-dsh-client] Успешно пропатчен клиент: ${file}`);
        patchedCount++;
        loopbackSeen = true;
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] Ошибка патча: ${file} - ${err.message}`);
    }
  }

  // 2. Патч серверного подключения (аутентификацией заведует шлюз)
  patchServerConnection(searchDir);

  // 3. Патч составного маршрута статических ресурсов client-modules
  //    Предыстория: URL пакетов клиентских плагинов выглядят как /plugins/??a/client.js,b/client.js&rev=<hash>;
  //    после перезапуска DSH хэш меняется, и **уже открытая страница**, запрашивая пакет со старым rev,
  //    получает 404 → белый экран.
  //    3a. изменение rev в том же процессе: в приоритете переиспользование исторического batch-ответа
  //        с тем же префиксом;
  //    3b. после межпроцессного перезапуска старого rev уже нет вовсе: отдаём скрипт «самовосстановление
  //        перезагрузкой», чтобы страница потолкала сама себя и восстановилась.
  const modulesTarget = path.join(searchDir, 'dsh-client-modules/lib/index.js');
  if (fs.existsSync(modulesTarget)) {
    try {
      let mContent = fs.readFileSync(modulesTarget, 'utf8');
      let changed = false;
      if (mContent.includes('/* dsh-patch: combo-fallback */')) markApplied('combo-fallback');

      // 3a. изменение rev в том же процессе → переиспользуем исторический batch с тем же префиксом
      //    (совместимо со старым и новым исходником DSH)
      if (!mContent.includes('/* dsh-patch: combo-fallback */')) {
        const needles = [
          'const response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);',
          'const response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl);'
        ];
        for (const needle of needles) {
          if (!mContent.includes(needle)) continue;
          const head = needle.replace('const response =', '/* dsh-patch: combo-fallback */ let response =');
          const replacement = head +
            '\n\t\tif (response === void 0 && resourceUrl.startsWith("/plugins/??")) {' +
            '\n\t\t\tconst prefix = resourceUrl.split("&rev=")[0];' +
            '\n\t\t\tfor (const [key, val] of this.responses.entries()) {' +
            '\n\t\t\t\tif (key.startsWith(prefix)) { response = val; break; }' +
            '\n\t\t\t}' +
            '\n\t\t}';
          mContent = mContent.replace(needle, replacement);
          changed = true;
          break;
        }
      }

      // 3b. старого rev уже нет (после перезапуска DSH / смены образа) → вместо 404 отдаём
      //    модуль «самовосстановление перезагрузкой»
      if (!mContent.includes('/* dsh-patch: bundle-404-selfheal */')) {
        const anchor = 'return { status: 404 };\n\t}\n\tserveBundle = async (req, res) => {';
        if (mContent.includes(anchor)) {
          const healBody = 'try{if(!sessionStorage.getItem("dsh-bundle-heal")){sessionStorage.setItem("dsh-bundle-heal","1");setTimeout(function(){try{sessionStorage.removeItem("dsh-bundle-heal")}catch(e){}},20000);location.reload()}}catch(e){}';
          const replacement =
            '/* dsh-patch: bundle-404-selfheal */' +
            '\n\t\tif (resourceUrl.startsWith("/plugins/")) {' +
            '\n\t\t\treturn {' +
            '\n\t\t\t\tstatus: 200,' +
            '\n\t\t\t\theaders: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },' +
            '\n\t\t\t\t...(method === "HEAD" ? {} : { body: ' + JSON.stringify(healBody) + ' })' +
            '\n\t\t\t};' +
            '\n\t\t}' +
            '\n\t\treturn { status: 404 };' +
            '\n\t}' +
            '\n\tserveBundle = async (req, res) => {';
          mContent = mContent.replace(anchor, replacement);
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(modulesTarget, mContent, 'utf8');
        markApplied('combo-fallback');
        console.log(`[patch-dsh-client] Успешно пропатчен механизм самовосстановления версий combo-пакетов плагинов: ${modulesTarget}`);
      }
      if (!appliedPatches.has('combo-fallback')) {
        markMissed('combo-fallback');
        console.warn(`[patch-dsh-client] ⚠️ Обязательный патч combo-fallback не применён (якорь устарел): ${modulesTarget}`);
      }
    } catch (err) {
      markMissed('combo-fallback');
      console.warn(`[patch-dsh-client] Ошибка патча client-modules: ${err.message}`);
    }
  }

  // 4. Страница настроек: полностью убираем кнопку «Открыть файл конфигурации», ничего не показываем (return null)
  const generalClientTarget = path.join(searchDir, 'dsh-client-ui-settings-general/lib/client.js');
  if (fs.existsSync(generalClientTarget)) {
    try {
      let gContent = fs.readFileSync(generalClientTarget, 'utf8');
      if (gContent.includes('function SettingsDocumentAction(') && !gContent.includes('function SettingsDocumentAction(props) { return null; }')) {
        gContent = gContent.replace(
          'function SettingsDocumentAction(',
          'function SettingsDocumentAction(props) { return null; }\n\t\tfunction __ignored_SettingsDocumentAction('
        );
        fs.writeFileSync(generalClientTarget, gContent, 'utf8');
        console.log(`[patch-dsh-client] Успешно убрана кнопка «Файл конфигурации»: ${generalClientTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] Ошибка удаления кнопки на странице настроек: ${err.message}`);
    }
  }

  // 5. Модели и онбординг: убираем всплывающее окно «объявление о закрытом тесте»
  //    (напрямую return null и уведомляем complete о продолжении, полностью убираем «зависающее» окно)
  const modelsClientTarget = path.join(searchDir, 'dsh-client-ui-settings-models/lib/client.js');
  if (fs.existsSync(modelsClientTarget)) {
    try {
      let mContent = fs.readFileSync(modelsClientTarget, 'utf8');
      if (mContent.includes('function WelcomeNotice(') && !mContent.includes('/* dsh-patch: welcome-notice-bypass */')) {
        mContent = mContent.replace(
          'function WelcomeNotice(props) {',
          '/* dsh-patch: welcome-notice-bypass */ function WelcomeNotice(props) { props?.complete?.(); return null;'
        );
        fs.writeFileSync(modelsClientTarget, mContent, 'utf8');
        console.log(`[patch-dsh-client] Успешно пропущено окно «объявление о закрытом тесте»: ${modelsClientTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] Ошибка пропуска окна «объявление о закрытом тесте»: ${err.message}`);
    }
  }

  // 6. Патч совместимости dsh-settings: добавляем экспорт settingsNamespace
  //    (решает краш плагинов marketplace вроде dsh-better-sidebar из-за отсутствия settingsNamespace)
  const settingsTarget = path.join(searchDir, 'dsh-settings/lib/index.js');
  if (fs.existsSync(settingsTarget)) {
    try {
      let sContent = fs.readFileSync(settingsTarget, 'utf8');
      if (!sContent.includes('settingsNamespace')) {
        const polyfill = `function settingsNamespace(val) { return val; }\n`;
        sContent = sContent.replace(
          'export { SettingsConflictError,',
          polyfill + 'export { settingsNamespace, SettingsConflictError,'
        );
        fs.writeFileSync(settingsTarget, sContent, 'utf8');
        console.log(`[patch-dsh-client] Успешно пропатчен экспорт settingsNamespace у dsh-settings: ${settingsTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] Ошибка патча dsh-settings: ${err.message}`);
    }
  }
}

console.log(`[patch-dsh-client] Сканирование патчей завершено, пропатчено ${patchedCount} клиентских файлов (проверено ${checkedDirs} корневых каталогов)`);
warnIfVersionOutOfRange();

// Обязательные патчи обязаны попасть: иначе якоря исходников DSH уплыли, и «молчаливый
// провал» патча опаснее ошибки запуска
if (loopbackSeen) markApplied('client-loopback'); else markMissed('client-loopback');
// Один патч, попавший в любом каталоге, считается выполненным (при нескольких копиях
// DSH сбой в копии «только для чтения» не фатален)
for (const name of appliedPatches) missedPatches.delete(name);
console.log(`[patch-dsh-client] Статус обязательных патчей: применено=[${[...appliedPatches].join(', ') || 'нет'}] не применено=[${[...missedPatches].join(', ') || 'нет'}]`);

if (checkedDirs === 0) {
  console.error('[patch-dsh-client] [FATAL] Не найден ни один каталог модулей DSH, патчи вообще не выполнялись (аномальная структура образа)');
  process.exit(1);
}
if (missedPatches.size > 0) {
  console.error(`[patch-dsh-client] [FATAL] Обязательные патчи не применены: ${[...missedPatches].join(', ')}`);
  console.error(`[patch-dsh-client] [FATAL] Список обязательных патчей: ${REQUIRED_PATCHES.join(', ')}`);
  console.error('[patch-dsh-client] [FATAL] Обычно это значит, что версия DSH устарела и якоря исходников патчей поехали; обновите patch-dsh-client.mjs перед запуском.');
  process.exit(1);
}
console.log('[patch-dsh-client] Все обязательные патчи применены ✅');
