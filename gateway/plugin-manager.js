const fs = require('fs');
const path = require('path');

// M11: DSH_HOME переносим (развёртывание не от root), по умолчанию /root
const DSH_HOME = process.env.DSH_HOME || '/root';
const PROFILE_DIR = path.join(DSH_HOME, '.dsh/profiles/web');
const PKG_PATH = path.join(PROFILE_DIR, 'package.json');
// Внимание (начиная с официальной 0.1.7): этот файл патчей Profile
// одновременно является авторитетным хранилищем «настроек DSH» (dsh-config-editor пишет сюда).
// Поэтому любое чтение/запись должны быть только блочными правками по имени плагина,
// ни в коем случае не полной перезаписью или переформатированием;
// предустановки контейнера всегда вносятся патчем Home-уровня $DSH_HOME/.dsh/cordis.patch.yml (см. install-plugin.mjs, раздел 7).
const PATCH_PATH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const MOD_DIR = path.join(PROFILE_DIR, 'node_modules');
const PLUGINS_DATA_DIR = path.join(DSH_HOME, '.dsh/plugins');
const PLUGIN_STATE_FILE = path.join(DSH_HOME, '.dsh/plugins-state.json');

// ── P6: разделяем с DSH lock записи профиля ─────────────────────────────────────────
// Официальный нативный менеджер плагинов / редактор настроек 0.1.7 перед
// изменением profile берёт `profiles/web/package.json.lock` (wx — эксклюзивный).
// Раньше мы не участвовали в этой блокировке: обе стороны делали собственное
// «читать-менять-писать» целого файла ⇒ кто пишет последним, тот и затирает
// другого (дрейф состояния плагинов, потерянные настройки).
// Теперь все операции записи profile обязаны быть внутри withProfileLock;
// writePackageJson и запись патча имеют runtime-защиту assertProfileLockHeld,
// и забытая блокировка сразу вызывает ошибку, а не молча теряет обновления.
const {
  withProfileLock,
  assertProfileLockHeld,
  profileLockPath
} = require(path.join(__dirname, '..', 'scripts', 'profile-lock.cjs'));

// ── P6: cordis.patch.yml — «хирургическое» удаление + предохранитель ──────────────────
// Этот файл одновременно является авторитетным хранилищем настроек DSH
// (включая `- id: llm-pi-ai` — конфигурацию модели/providers).
const {
  removePatchEntries,
  assertPatchSafe,
  topLevelEntryIds
} = require(path.join(__dirname, '..', 'scripts', 'patch-yaml.cjs'));

const CORE_PACKAGES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
]);

// Словарь русских описаний встроенных и основных компонентов
const PLUGIN_DESCRIPTIONS_ZH = {
  '@deepseek-ai/dsh-base': 'Базовое окружение DeepSeek Harness и исполнительный фреймворк агента',
  '@deepseek-ai/dsh-web-app': 'Официальный веб-графический клиент DeepSeek Harness',
  '@deepseek-ai/dsh-experimental-agent-team-profile': 'Экспериментальный набор Agent Teams для совместной работы нескольких интеллект-агентов (с 0.1.7 объединён с прежним веб-набором)',
  '@dsh-custom/dsh-browser-desktop': 'Плагин контейнерного Chromium-браузера с интегрированным рабочим столом noVNC: поддержка автономного просмотра веб-страниц ИИ, управления вкладками и мгновенных скриншотов без потерь',
  'dshmarket': 'Визуальный маркетплейс DSH-плагинов: просмотр, поиск и установка/управление плагинами сообщества прямо в интерфейсе в один клик',
  '@hytime/dsh-thinking-effort': 'Добавляет сторонним моделям DSH настраиваемые уровни усилия размышления, а также поддержку задания уровня размышления по умолчанию для субагентов',
  'dsh-client-auto-continue': 'Плагин автопродолжения DSH Web-клиента: автоматически отправляет локализованную подсказку продолжения при колебаниях сети или аномальном разрыве'
};

function readPluginState() {
  try {
    if (fs.existsSync(PLUGIN_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PLUGIN_STATE_FILE, 'utf8'));
      return {
        disabled: Array.isArray(data.disabled) ? data.disabled : [],
        uninstalled: Array.isArray(data.uninstalled) ? data.uninstalled : []
      };
    }
  } catch (err) {
    console.warn('[plugin-manager] Предупреждение при чтении plugins-state.json:', err.message);
  }
  return { disabled: [], uninstalled: [] };
}

// Атомарная запись: сначала во временный файл, затем rename — чтобы при убийстве
// процесса или заполненном диске не оставался обрезанный JSON/YAML (иначе DSH не поднимется)
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writePluginState(state) {
  try {
    fs.mkdirSync(path.dirname(PLUGIN_STATE_FILE), { recursive: true });
    const payload = {
      disabled: Array.from(new Set(state.disabled || [])),
      uninstalled: Array.from(new Set(state.uninstalled || [])),
      updatedAt: new Date().toISOString()
    };
    atomicWrite(PLUGIN_STATE_FILE, JSON.stringify(payload, null, 2) + '\n');
    return true;
  } catch (err) {
    console.error('[plugin-manager] Ошибка записи plugins-state.json:', err.message);
    return false;
  }
}

function readPackageJson() {
  try {
    if (fs.existsSync(PKG_PATH)) {
      return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[plugin-manager] Ошибка чтения package.json:', err.message);
  }
  return { dependencies: {}, dsh: { profile: { bundles: [] } } };
}

function writePackageJson(pkg) {
  // Защита P6: запись profile выполняется только внутри write-лока.
  // Если блокировку забыли — сразу бросок PROFILE_LOCK_NOT_HELD,
  // а не молчаливая потеря обновлений (этот бросок не поглощается try ниже).
  assertProfileLockHeld(PROFILE_DIR);
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    atomicWrite(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    return true;
  } catch (err) {
    console.error('[plugin-manager] Ошибка записи package.json:', err.message);
    throw new Error('Ошибка записи package.json: ' + err.message);
  }
}

// Удаление на уровне записей вынесено в scripts/patch-yaml.cjs («хирургическое»:
// удаляется только диапазон символов затронутой записи, остальные байты сохраняются
// дословно, чтобы «разбивка-фильтрация-пересборка» не проглотила concurrent-записи DSH
// или не изменила форму документа).
// Здесь же ре-экспортируем `removePatchEntries`, сохраняя совместимость с тестами и вызывающими.

/**
 * Убирает записи о плагине из cordis.patch.yml (**вызывать только внутри lock записи profile**).
 * Хирургическое удаление + предохранитель: удаляется лишь диапазон символов затронутой записи,
 * остальные байты сохраняются дословно; любые правки, затрагивающие записи не-этого-плагина
 * (например `llm-pi-ai`), будут остановлены assertPatchSafe, и запись отменяется.
 * @returns {boolean} произошла ли фактическая запись
 */
function cleanPatchForPluginLocked(pluginName) {
  if (!fs.existsSync(PATCH_PATH)) return false;
  assertProfileLockHeld(PROFILE_DIR);
  try {
    const before = fs.readFileSync(PATCH_PATH, 'utf8');
    let content = before;
    let changed = false;
    const removedIds = [];

    // Если отключаемый плагин — dsh-git-worktree, вычищаем его отключённый патч ui-workspace
    if (pluginName.includes('worktree')) {
      const r = removePatchEntries(content, (block) => /\bid:\s*ui-workspace\b/.test(block));
      if (r.removed > 0) { content = r.text; changed = true; removedIds.push(...r.removedIds); }
    }

    // Чистим записи, упоминающие имя плагина (удаление записи целиком, без межстрочных regex)
    if (content.includes(pluginName)) {
      const esc = pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc);
      const r = removePatchEntries(content, (block) => re.test(block));
      if (r.removed > 0) { content = r.text; changed = true; removedIds.push(...r.removedIds); }
    }

    if (!changed) return false;

    content = content.trim();
    if (!content) content = '[]';
    // Предохранитель: не допустим потерю ни одной верхнеуровневой записи не-этого-плагина (особенно llm-pi-ai config)
    assertPatchSafe({ before, after: content, removedIds });
    atomicWrite(PATCH_PATH, content + '\n');
    console.log(`[plugin-manager] Автоматически вычищены записи патча cordis.patch.yml о плагине ${pluginName}`);
    return true;
  } catch (err) {
    // Предохранитель сработал — это «отказ от записи»: обязательно явное предупреждение, никогда не молча
    console.error(`[plugin-manager] Очистка cordis.patch.yml отменена (не записано): ${err.message}`);
    return false;
  }
}

/** Внешний вход: сам берёт lock записи profile и затем чистит */
async function cleanPatchForPlugin(pluginName) {
  return withProfileLock(
    PROFILE_DIR,
    async () => cleanPatchForPluginLocked(pluginName),
    { label: `cleanPatch:${pluginName}` }
  );
}

function getPlugins() {
  const pkg = readPackageJson();
  const dependencies = pkg.dependencies || {};
  const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles))
    ? pkg.dsh.profile.bundles
    : [];

  const pluginState = readPluginState();
  const disabledSet = new Set(pluginState.disabled);
  const uninstalledSet = new Set(pluginState.uninstalled);

  const foundMap = new Map();

  // 1. Сканируем плагины в списках dependencies и bundles
  const registeredNames = new Set([...Object.keys(dependencies), ...bundles]);

  for (const name of registeredNames) {
    const isCore = CORE_PACKAGES.has(name);
    const isCustom = name.startsWith('@dsh-custom/') || name.startsWith('@dsh-external/');
    
    // Если имя явно в disabledSet — считаем отключённым; иначе ориентируемся на bundles
    const isEnabled = !disabledSet.has(name) && bundles.includes(name);

    let version = dependencies[name] || 'Системное ядро';
    let description = PLUGIN_DESCRIPTIONS_ZH[name] || '';

    // Ищем package.json, чтобы взять реальную версию и описание (если не нашли во встроенном словаре)
    let targetPkgPath = path.join(MOD_DIR, name, 'package.json');
    if (!fs.existsSync(targetPkgPath) && dependencies[name] && dependencies[name].startsWith('link:')) {
      const linkTarget = dependencies[name].replace(/^link:/, '');
      targetPkgPath = path.join(linkTarget, 'package.json');
    }

    if (fs.existsSync(targetPkgPath)) {
      try {
        const modPkg = JSON.parse(fs.readFileSync(targetPkgPath, 'utf8'));
        if (modPkg.version) version = modPkg.version;
        if (!description && modPkg.description) description = modPkg.description;
      } catch {}
    }

    foundMap.set(name, {
      name,
      version,
      description: description || 'Описания нет',
      enabled: isEnabled,
      isUninstalled: false,
      isCore,
      isCustom,
      type: isCore ? 'core' : (isCustom ? 'builtin' : 'community'),
      source: dependencies[name] || 'bundled'
    });
  }

  // 2. Сканируем node_modules на предмет потенциальных расширений DSH, не объявленных в package.json
  function inspectDir(dir, pkgName) {
    if (foundMap.has(pkgName)) return;
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) return;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const isDshPlugin = json.dsh ||
        (Array.isArray(json.keywords) && (json.keywords.includes('dsh') || json.keywords.includes('deepseek-harness') || json.keywords.includes('cordis'))) ||
        json.name.startsWith('dsh-') ||
        json.name.startsWith('@dsh-');

      if (isDshPlugin) {
        const desc = PLUGIN_DESCRIPTIONS_ZH[pkgName] || json.description || 'Описания нет';
        foundMap.set(pkgName, {
          name: pkgName,
          version: json.version || 'unknown',
          description: desc,
          enabled: false,
          isUninstalled: false,
          isCore: false,
          isCustom: false,
          type: 'unregistered',
          source: 'unlinked'
        });
      }
    } catch {}
  }

  if (fs.existsSync(MOD_DIR)) {
    try {
      for (const item of fs.readdirSync(MOD_DIR)) {
        if (item.startsWith('@')) {
          const scopeDir = path.join(MOD_DIR, item);
          if (fs.statSync(scopeDir).isDirectory()) {
            for (const sub of fs.readdirSync(scopeDir)) {
              inspectDir(path.join(scopeDir, sub), item + '/' + sub);
            }
          }
        } else if (!item.startsWith('.')) {
          inspectDir(path.join(MOD_DIR, item), item);
        }
      }
    } catch {}
  }

  // 3. Дополняем список уже удалёнными, но всё ещё предустановленными в образ плагинами Market,
  //     чтобы панель управления наглядно показывала их и позволяла переустановить
  for (const uninstalledName of uninstalledSet) {
    if (!foundMap.has(uninstalledName)) {
      const globalPkgPath = path.join('/usr/local/lib/node_modules', uninstalledName, 'package.json');
      let version = 'Встроен в образ';
      let desc = PLUGIN_DESCRIPTIONS_ZH[uninstalledName] || 'Плагин удалён';
      if (fs.existsSync(globalPkgPath)) {
        try {
          const gPkg = JSON.parse(fs.readFileSync(globalPkgPath, 'utf8'));
          if (gPkg.version) version = gPkg.version;
          if (gPkg.description && !PLUGIN_DESCRIPTIONS_ZH[uninstalledName]) desc = gPkg.description;
        } catch {}
      }
      foundMap.set(uninstalledName, {
        name: uninstalledName,
        version,
        description: desc,
        enabled: false,
        isUninstalled: true,
        isCore: false,
        isCustom: false,
        type: 'community',
        source: 'uninstalled'
      });
    }
  }

  const list = Array.from(foundMap.values());
  // Сортировка: сперва основные компоненты, затем установленные (по убыванию включения, по возрастанию имени); удалённые — в самом конце
  list.sort((a, b) => {
    if (a.isCore && !b.isCore) return -1;
    if (!a.isCore && b.isCore) return 1;
    if (a.isUninstalled !== b.isUninstalled) return a.isUninstalled ? 1 : -1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { ok: true, plugins: list };
}

function isValidPluginName(name) {
  if (!name || typeof name !== 'string') return false;
  // Разрешено только стандартное допустимое имя npm-пакета (напр. "dshmarket", "@scope/package"),
  // полностью исключая символы относительных путей и обход каталогов
  const npmRegex = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;
  return npmRegex.test(name) && !name.includes('..');
}

async function togglePlugin(name, enable) {
  if (!isValidPluginName(name)) {
    throw new Error('Недопустимое или небезопасное имя плагина: ' + name);
  }
  if (CORE_PACKAGES.has(name)) {
    throw new Error('Системные основные компоненты (' + name + ') отключать нельзя, иначе система не сможет работать');
  }

  // P6: весь цикл «прочитать package.json → изменить bundles → записать обратно»
  // обязан выполняться в одном lock записи profile,
  // иначе возникнет перезапись (потеря обновлений) между нами и нативным менеджером плагинов DSH.
  return withProfileLock(PROFILE_DIR, async () => {
    const pkg = readPackageJson();
    const pkgSnapshot = JSON.stringify(pkg, null, 2) + '\n'; // для отката при неуспешной записи состояния
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

    const bundles = pkg.dsh.profile.bundles;
    const index = bundles.indexOf(name);

    const state = readPluginState();
    const disabledSet = new Set(state.disabled);
    const uninstalledSet = new Set(state.uninstalled);

    if (enable) {
      if (index === -1) {
        bundles.push(name);
      }
      disabledSet.delete(name);
      uninstalledSet.delete(name);
    } else {
      if (index !== -1) {
        bundles.splice(index, 1);
      }
      disabledSet.add(name);
      uninstalledSet.delete(name);
      // При отключении попутно вычищаем деструктивные патчи этого плагина
      // в cordis.patch.yml (мы уже внутри lock, вызываем locked-версию)
      cleanPatchForPluginLocked(name);
    }

    writePackageJson(pkg);
    const stateOk = writePluginState({
      disabled: Array.from(disabledSet),
      uninstalled: Array.from(uninstalledSet)
    });
    if (!stateOk) {
      // Не удалось записать файл состояния: откатываем package.json, чтобы не разошлись память/диск
      // (иначе отключённый плагин после перезапуска «воскреснет»)
      try { atomicWrite(PKG_PATH, pkgSnapshot); } catch {}
      throw new Error('Не удалось сохранить состояние плагина (package.json откачен), проверьте права на том данных и свободное место на диске');
    }

    console.log(`[plugin-manager] Плагин ${name} сохранён: ${enable ? 'включён' : 'отключён'}`);

    return { ok: true, name, enabled: enable };
  }, { label: `toggle:${name}` });
}

async function uninstallPlugin(name) {
  if (!isValidPluginName(name)) {
    throw new Error('Недопустимое или небезопасное имя плагина: ' + name);
  }
  if (CORE_PACKAGES.has(name)) {
    throw new Error('Системные основные компоненты (' + name + ') удалять нельзя');
  }

  // P6: «читать-менять-писать + состояние + чистка патча» целиком в одном lock записи;
  // физическое удаление node_modules / каталога данных ниже не связано с profile
  // и выполняется вне lock, чтобы долго его не удерживать.
  await withProfileLock(PROFILE_DIR, async () => {
    const pkg = readPackageJson();
    let changed = false;

    // 1. Убираем из bundles
    if (pkg.dsh?.profile?.bundles && Array.isArray(pkg.dsh.profile.bundles)) {
      const idx = pkg.dsh.profile.bundles.indexOf(name);
      if (idx !== -1) {
        pkg.dsh.profile.bundles.splice(idx, 1);
        changed = true;
      }
    }

    // 2. Убираем из dependencies
    if (pkg.dependencies && pkg.dependencies[name]) {
      delete pkg.dependencies[name];
      changed = true;
    }

    if (changed) {
      writePackageJson(pkg);
    }

    // 3. Сохраняем в plugins-state.json (ло пометке «удалён», чтобы после обновления образа
    //    или перезапуска плагин не «воскрес» автоматически)
    const state = readPluginState();
    const disabledSet = new Set(state.disabled);
    const uninstalledSet = new Set(state.uninstalled);
    disabledSet.delete(name);
    uninstalledSet.add(name);
    writePluginState({
      disabled: Array.from(disabledSet),
      uninstalled: Array.from(uninstalledSet)
    });

    // 4. Убираем остатки cordis-патча (внутри lock — locked-версия напрямую)
    cleanPatchForPluginLocked(name);
  }, { label: `uninstall:${name}` });

  // 5. Удаляем каталог в node_modules и каталог данных плагина (строгая проверка sandbox-префикса)
  const pluginDir = path.resolve(MOD_DIR, name);
  const resolvedModDir = path.resolve(MOD_DIR);
  if (!pluginDir.startsWith(resolvedModDir + path.sep)) {
    throw new Error('Обнаружена недопустимая операция удаления за пределами каталога, блокировка: ' + pluginDir);
  }

  try {
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[plugin-manager] Ошибка удаления каталога плагина в node_modules:', err.message);
  }

  const sanitizedScopeName = name.replace(/^@.*\//, '');
  const dataDir = path.resolve(PLUGINS_DATA_DIR, sanitizedScopeName);
  const resolvedDataDir = path.resolve(PLUGINS_DATA_DIR);
  try {
    if (dataDir.startsWith(resolvedDataDir + path.sep) && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  } catch {}

  console.log(`[plugin-manager] Плагин ${name} полностью удалён, остатки вычищены, в состоянии отмечен как удалённый`);
  return { ok: true, name, uninstalled: true };
}

async function installPlugin(name) {
  if (!isValidPluginName(name)) {
    throw new Error('Недопустимое или небезопасное имя плагина: ' + name);
  }

  // P6: создание symlink + чтение/изменение/запись package.json + сохранение состояния — в одном lock записи
  await withProfileLock(PROFILE_DIR, async () => {
    const state = readPluginState();
    const disabledSet = new Set(state.disabled);
    const uninstalledSet = new Set(state.uninstalled);
    uninstalledSet.delete(name);
    disabledSet.delete(name);

    const pkg = readPackageJson();
    pkg.dependencies = pkg.dependencies || {};
    pkg.dsh = pkg.dsh || { profile: {} };
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

    // Определяем, глобальный ли это предустановленный плагин (например в /usr/local/lib/node_modules)
    const globalPath = path.join('/usr/local/lib/node_modules', name);
    const customPath = path.join('/app/plugins', name.replace(/^@dsh-custom\//, ''));

    let sourcePath = null;
    if (fs.existsSync(globalPath)) {
      sourcePath = globalPath;
    } else if (fs.existsSync(customPath)) {
      sourcePath = customPath;
    }

    if (sourcePath) {
      const scopeDir = path.dirname(path.join(MOD_DIR, name));
      fs.mkdirSync(scopeDir, { recursive: true });
      const targetLink = path.join(MOD_DIR, name);
      try {
        if (fs.existsSync(targetLink) || fs.lstatSync(targetLink).isSymbolicLink()) {
          fs.unlinkSync(targetLink);
        }
      } catch {}
      try {
        fs.symlinkSync(sourcePath, targetLink);
      } catch (e) {
        console.warn(`[plugin-manager] Предупреждение при пересоздании symlink плагина: ${e.message}`);
      }
      pkg.dependencies[name] = 'link:' + sourcePath;
    }

    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
    }

    writePackageJson(pkg);
    writePluginState({
      disabled: Array.from(disabledSet),
      uninstalled: Array.from(uninstalledSet)
    });
  }, { label: `install:${name}` });

  console.log(`[plugin-manager] Плагин ${name} переустановлен и возвращён в работу`);
  return { ok: true, name, installed: true };
}

module.exports = {
  getPlugins,
  togglePlugin,
  uninstallPlugin,
  installPlugin,
  cleanPatchForPlugin,
  readPluginState,
  writePluginState,
  removePatchEntries,
  topLevelEntryIds,
  PLUGIN_DESCRIPTIONS_ZH
};
