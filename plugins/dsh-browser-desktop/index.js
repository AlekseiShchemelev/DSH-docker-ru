import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-browser-desktop';
export const inject = ['tools', 'systemPrompt', 'settings'];

// Плагин **сам больше не объявляет ни одного настраиваемого поля** в центре настроек DSH:
// весь авторитет конфигурации браузера/рабочего стола = файл gateway.config.json, сохраняемый шлюзом
// (страница Admin «Браузер и рабочий стол» — единственная точка конфигурации).
// Пустая Schema оставлена, чтобы у рендера конфигурации плагина в DSH не было ни одного поля —
// с самого начала исключается «призрачная» форма: выглядит изменяемой, а изменение ни на что не влияет.
export const Config = z.object({});

export function apply(ctx, config = {}) {
  // Живое состояние конфигурации, изначально передаётся системой, динамически обновляется
  // при горячем обновлении центра настроек
  let activeConfig = {
    enabled: true,
    resolution: '1920x1080',
    screenshotQuality: 'high',
    screenshotDir: '',
    idleTimeoutMinutes: 30,
    enableCdp: true,
    cdpPort: 9222,
    vncPath: '/vnc',
    enableSidebarTab: false,
    ...config
  };

  // Отзывные handle при отключении по главному переключателю enabled:
  // массив disposer'ов инструментов / disposer секции промпта
  const registeredTools = [];
  let registeredPrompt = null;
  let enabledState = null;

  const cdpPort = () => activeConfig.cdpPort || 9222;
  const cdpBase = () => `http://127.0.0.1:${cdpPort()}`;
  const vncPath = () => activeConfig.vncPath || '/vnc';

  // Базовый адрес внутренних интерфейсов управления шлюзом (динамически читается PROXY_PORT)
  const gatewayControlUrl = () => `http://127.0.0.1:${process.env.PROXY_PORT || 3080}/__internal/desktop`;

  // Общий ключ внутренних интерфейсов (M14): шлюз при старте создаёт файл 0600, плагин
  // читает и передаёт его перед каждым вызовом. Файл доступен только плагинам внутри
  // контейнера, поэтому даже при внешнем доступе к шлюзу внутренние интерфейсы не вызвать.
  const INTERNAL_TOKEN_FILE = process.env.DSH_INTERNAL_TOKEN_FILE || '/root/.dsh/.internal-api-token';
  let cachedInternalToken = null;
  function readInternalToken() {
    try {
      const raw = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim();
      if (raw) { cachedInternalToken = raw; return raw; }
    } catch {}
    return cachedInternalToken;
  }

  async function callDesktopManager(endpoint, body = {}) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = readInternalToken();
      if (token) headers['x-dsh-internal-token'] = token;
      const res = await fetch(`${gatewayControlUrl()}/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // Страховка по тайм-ауту: не дать вызову инструмента повиснуть вечно, если менеджер
        // рабочего стола аномально завис
        // (start в крайних случаях ждёт освобождения старого дисплея/портов, поэтому запас в 30 с)
        signal: AbortSignal.timeout(30000)
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!data) {
        return { ok: false, error: `Интерфейс управления рабочим столом вернул пустой ответ (HTTP ${res.status})` };
      }
      if (!res.ok && data.ok !== false) {
        return { ok: false, error: `Интерфейс управления рабочим столом вернул HTTP ${res.status}` };
      }
      return data;
    } catch (err) {
      // R1-c: гонка между отключением и идущим вызовом — если браузер был полностью отключён
      // за время вызова, приводим ошибку нижележащей сети/CDP к однозначному «отключён»
      // и не даём её спутать с ошибкой браузера.
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        return { ok: false, error: 'Контейнерный графический браузер полностью отключён в панели управления, операция прервана' };
      }
      return { ok: false, error: err.message };
    }
  }

  // ── Авторитетная конфигурация: единственный источник — шлюз (страница Admin «Браузер и рабочий стол») ─────────
  // Плагин **не регистрирует** пространство настроек DSH (раньше это рендерило «призрачную форму»,
  // которую изменишь — а она ни на что не влияет).
  // Явные настройки пользователя из секции browser-desktop старого settings.yaml мигрируются
  // однократно при первом запуске: миграция читает **исходную user-section**
  // (ctx.settings.section), без регистрации пространства имён.
  const LEGACY_MARKER = process.env.BROWSER_DESKTOP_LEGACY_MARKER || '/root/.dsh/.browser-desktop-authority-migrated';
  const LEGACY_MARKER_FALLBACK = process.env.BROWSER_DESKTOP_LEGACY_MARKER_FALLBACK || '/tmp/.browser-desktop-authority-migrated';
  const legacyMigrated = () => fs.existsSync(LEGACY_MARKER) || fs.existsSync(LEGACY_MARKER_FALLBACK);
  const markLegacyMigrated = () => {
    const content = new Date().toISOString() + '\n';
    try { fs.writeFileSync(LEGACY_MARKER, content, 'utf8'); return; } catch {}
    try { fs.writeFileSync(LEGACY_MARKER_FALLBACK, content, 'utf8'); } catch {}
  };

  // Чтение исходной user-section секции browser-desktop из старого документа настроек DSH
  // (только чтение, пространство имён не регистрируется).
  // null означает, что этой секции нет (или текущий DSH не даёт section API).
  function readLegacySection() {
    try {
      if (!ctx.settings || typeof ctx.settings.section !== 'function') return null;
      const section = ctx.settings.section('browser-desktop');
      return section && typeof section === 'object' && !Array.isArray(section) ? section : null;
    } catch {
      return null;
    }
  }

  // ── Авторитетная конфигурация: напрямую читаем файл конфигурации шлюза (синхронно, за микросекунды, ноль сети, ноль поллинга) ──
  // Включение/отключение браузера — управляющее действие и сопровождается перезапуском сервиса;
  // плагин читает файл при **запуске** и **перед каждым вызовом инструмента**,
  // поэтому поллинг или file-watch вообще не нужны.
  const CONFIG_FILE = process.env.GATEWAY_CONFIG_FILE || '/root/.dsh/gateway.config.json';

  // P17: различаем «файла нет» и «файл есть, но не разобрался».
  //   - нет (ENOENT): первый старт свежего контейнера, шлюз ещё не записал → сохраняем текущее состояние, это не ошибка;
  //   - ошибка разбора/чтения: готовую конфигурацию администратора кто-то сломал (или сбой диска),
  //     **ни в коем случае** нельзя откатиться к «включено» и снова повесить инструменты ИИ
  //     (администратор мог явно отключить); фиксируем error и держим последний успешно прочитанный снапшот.
  let lastGoodAuthoritative = null;
  let configParseErrorLogged = false;

  // Межпроцессный «последний успешный снапшот»: после перезапуска процессы в памяти снапшот
  // теряется, и если в этот момент файл конфигурации вдруг сломан, только память откатит к дефолту
  // «включено». Здесь последний успешно прочитанный enabled пишется на диск (0600),
  // и при ошибке разбора в приоритете откатываемся к нему — так при «админ отключил + конфиг сломан
  // + перезапуск» тоже не произойдёт ошибочного включения.
  const STATE_FILE = process.env.BROWSER_DESKTOP_STATE_FILE || '/root/.dsh/.browser-desktop-last-state.json';
  function persistLastGood(snapshot) {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: snapshot.enabled, savedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    } catch (e) { /* Сбой записи файла состояния не влияет на основной ход */ }
  }
  function loadPersistedLastGood() {
    try {
      const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof o.enabled === 'boolean') return { enabled: o.enabled };
    } catch (e) { /* Файла состояния нет или он сломан */ }
    return null;
  }
  function fallbackSnapshot() {
    return lastGoodAuthoritative || loadPersistedLastGood();
  }

  function readAuthoritativeConfig() {
    let raw;
    try {
      raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        if (!configParseErrorLogged) {
          console.error('[dsh-browser-desktop] Ошибка чтения авторитетной конфигурации, держим последний успешный снапшот:', e.message);
          configParseErrorLogged = true;
        }
      }
      return fallbackSnapshot(); // файла нет → null (используем текущее состояние); ошибка чтения → последний успешный снапшот
    }

    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      if (!configParseErrorLogged) {
        console.error('[dsh-browser-desktop] Ошибка разбора авторитетной конфигурации (JSON повреждён), держим последний успешный снапшот, а не откатываемся к «включено»:', e.message);
        configParseErrorLogged = true;
      }
      return fallbackSnapshot();
    }

    configParseErrorLogged = false;
    const d = cfg.desktop || {};
    const snapshot = {
      enabled: d.enabled !== false,
      resolution: (Number(d.width) > 0 && Number(d.height) > 0)
        ? `${Number(d.width)}x${Number(d.height)}` : activeConfig.resolution,
      enableCdp: d.enableCdp !== false,
      cdpPort: Number(d.cdpPort) > 0 ? Number(d.cdpPort) : activeConfig.cdpPort,
      idleTimeoutMinutes: typeof d.idleTimeoutMinutes === 'number' ? d.idleTimeoutMinutes : activeConfig.idleTimeoutMinutes,
      screenshotQuality: d.screenshotQuality || activeConfig.screenshotQuality,
      screenshotDir: typeof d.screenshotDir === 'string' ? d.screenshotDir : activeConfig.screenshotDir,
      enableSidebarTab: !!d.enableSidebarTab,
      vncPath: cfg.vncPath || activeConfig.vncPath
    };
    lastGoodAuthoritative = snapshot;
    persistLastGood(snapshot);
    return snapshot;
  }

  // Обновляет авторитетную конфигурацию и синхронизирует с ней регистрацию инструментов/промпта
  // (синхронно, вызывающей стороне не нужно await)
  function refreshAuthoritativeConfig() {
    const next = readAuthoritativeConfig();
    if (next) activeConfig = { ...activeConfig, ...next };
    // Ключевой момент: даже если файл не прочитался (первый старт свежего контейнера, файл ещё
    // не создан) всё равно применяем текущее состояние — иначе плагин не зарегистрирует ничего
    // и у ИИ никогда не будет инструментов браузера (тяжёлый сбой).
    applyEnabledState(activeConfig.enabled !== false);
    return activeConfig;
  }

  // Одноразовая миграция: явные пользовательские значения из секции browser-desktop старого
  // документа настроек DSH переносятся в авторитетную конфигурацию шлюза
  async function migrateLegacySettingsOnce() {
    try {
      if (legacyMigrated()) return;
      // Текущий DSH не даёт section API (очень старая версия) → ждём до следующего раза,
      // миграцию не делаем и маркер не ставим
      if (!ctx.settings || typeof ctx.settings.section !== 'function') return;
      const legacy = readLegacySection();
      if (!legacy) { markLegacyMigrated(); return; }
      const patch = {};
      let disableDesktop = false;
      if (legacy.enabled === false) disableDesktop = true; // значение по умолчанию true, явный false — выключено пользователем
      if (legacy.screenshotQuality && legacy.screenshotQuality !== 'high') patch.screenshotQuality = legacy.screenshotQuality;
      if (typeof legacy.screenshotDir === 'string' && legacy.screenshotDir.trim()) patch.screenshotDir = legacy.screenshotDir.trim();
      if (legacy.enableSidebarTab === true) patch.enableSidebarTab = true;

      if (Object.keys(patch).length) {
        const r = await callDesktopManager('config', patch);
        console.log('[dsh-browser-desktop] Старые настройки перенесены в авторитетную конфигурацию панели управления:', JSON.stringify(patch), JSON.stringify(r));
      }
      if (disableDesktop) {
        const r = await callDesktopManager('master', { enabled: false });
        console.log('[dsh-browser-desktop] «Отключено» из старых настроек перенесено в главный переключатель панели управления:', JSON.stringify(r));
      }
      markLegacyMigrated();
    } catch (e) {
      console.warn('[dsh-browser-desktop] Сбой миграции старых настроек (игнорируется):', e.message);
    }
  }

  async function navigatePageViaCdp(webSocketDebuggerUrl, targetUrl) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Тайм-аут CDP Page.navigate'));
      }, 4000);

      const ws = new WebSocket(webSocketDebuggerUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 101,
          method: 'Page.navigate',
          params: { url: targetUrl }
        }));
      };
      ws.onmessage = (event) => {
        // P6: считаем завершённым и снимаем тайм-аут, только получив ответ **с id текущего запроса**;
        // прочие события CDP (например, уведомления Page.*) тайм-аут не снимают — иначе при потере
        // ответа Promise зависнет навсегда.
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          return reject(e);
        }
        if (!msg || msg.id !== 101) return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.error) return reject(new Error(msg.error.message));
        resolve(msg.result);
      };
      ws.onerror = (err) => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      };
    });
  }

  // Нормализация целевого URL + whitelist протоколов: только http/https,
  // блокируются file:// (чтение чувствительных файлов хоста), data:, javascript:, chrome:// и прочие.
  function normalizeTargetUrl(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) throw new Error('URL не может быть пустым');
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
    const withScheme = hasScheme ? s : `https://${s}`;
    let parsed;
    try { parsed = new URL(withScheme); }
    catch { throw new Error('Неверный формат URL: ' + s.slice(0, 120)); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Поддерживаются только протоколы http/https (${parsed.protocol} отклонён): ${s.slice(0, 120)}`);
    }
    if (!parsed.hostname) throw new Error('В URL отсутствует имя хоста: ' + s.slice(0, 120));
    return parsed.toString();
  }

  async function openInChromium(url, durationMinutes, signal, customResolution, options = {}) {
    const targetUrl = normalizeTargetUrl(url);

    // В приоритете разрешение, явно заданное ИИ; иначе — разрешение из конфигурации центра
    // настроек (по умолчанию 1920x1080)
    // Разрешение переопределяется, только когда вызывающий явно его задал; в остальных случаях
    // передаём управление шлюзу с текущим значением (чтобы не перезапускать весь стол и не терять вкладки)
    const explicitRes = typeof customResolution === 'string' && customResolution.trim() ? customResolution.trim().toLowerCase() : null;
    const parts = explicitRes ? explicitRes.split('x') : [];
    const width = parseInt(parts[0]) || undefined;
    const height = parseInt(parts[1]) || undefined;
    const effectiveRes = explicitRes || activeConfig.resolution || '1920x1080';

    // Если рабочий стол не запущен или нужно скорректировать разрешение — автоматически будим
    const startRes = await callDesktopManager('start', {
      durationMinutes,
      width,
      height,
      idleTimeoutMinutes: activeConfig.idleTimeoutMinutes,
      enableCdp: activeConfig.enableCdp,
      cdpPort: activeConfig.cdpPort
    });
    if (!startRes || startRes.ok === false) {
      throw new Error(`Запуск контейнерного рабочего стола не удался: ${startRes?.error || 'шлюз не ответил'}`);
    }

    let tabId = null;
    let reused = false;

    // Ждём готовности порта CDP (если CDP включён)
    if (activeConfig.enableCdp !== false) {
      let cdpReady = false;
      for (let i = 0; i < 20; i++) {
        try {
          const check = await fetch(`${cdpBase()}/json/version`, { signal });
          if (check.ok) { cdpReady = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }

      if (!cdpReady) {
        throw new Error('Отладочный порт CDP не готов, возможно, браузер не запустился (посмотреть состояние можно через browser_control status)');
      }

      const forceNewTab = options.newTab === true;

      if (!forceNewTab) {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal });
          if (listRes.ok) {
            const allTargets = await listRes.json();
            const pages = allTargets.filter(t => t.type === 'page');

            let targetPage = null;
            if (options.tabId) {
              targetPage = pages.find(p => p.id === options.tabId);
            }
            if (!targetPage && pages.length > 0) {
              // В приоритете переиспользуем пустую страницу (about:blank или chrome://newtab/),
              // иначе — уже существующую
              targetPage = pages.find(p => p.url === 'about:blank' || p.url === 'chrome://newtab/') || pages[pages.length - 1];
            }

            if (targetPage && targetPage.webSocketDebuggerUrl) {
              await navigatePageViaCdp(targetPage.webSocketDebuggerUrl, targetUrl);
              tabId = targetPage.id;
              reused = true;
              try {
                await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(tabId)}`, { signal });
              } catch {}
            }
          }
        } catch (navErr) {
          console.warn('[dsh-browser-desktop] Сбой навигации с переиспользованием вкладки, деградируем до создания новой:', navErr.message);
        }
      }

      // Если нужно создать новую вкладку или переиспользованная навигация не удалась — CDP создаёт вкладку
      if (!tabId) {
        const res = await fetch(`${cdpBase()}/json/new?${encodeURIComponent(targetUrl)}`, {
          method: 'PUT',
          signal
        });
        if (res.ok) {
          const page = await res.json();
          tabId = page.id;
          reused = false;
          try { await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(page.id)}`, { signal }); } catch {}
        }
      }

      if (!tabId) {
        throw new Error('Не удалось создать или переиспользовать вкладку браузера (в CDP нет доступных страниц)');
      }
    }

    // Обновляем время «биения»/работы
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      await callDesktopManager('keepalive', { durationMinutes });
    }

    return {
      url: targetUrl,
      tabId,
      reused,
      resolution: effectiveRes,
      vncUrl: `${vncPath()}/?autoconnect=1&resize=scale&view_only=0&reconnect=1`,
      status: reused ? 'navigated' : 'opened'
    };
  }

  // Реализация двойного движка скриншотов: выбор качества (high высокое/оригинал, medium среднее,
  // low низкое), конкретного tabId и своего пути сохранения
  async function captureScreenshotDual(savePath, customQuality, targetTabId, sessionCwd = process.cwd()) {
    const qualityLevel = (customQuality || activeConfig.screenshotQuality || 'high').toLowerCase();
    const isHigh = qualityLevel === 'high';
    const isLow = qualityLevel === 'low';

    // Умная обработка пути:
    // в приоритете интерпретируем путь в рабочей области самой сессии/проекта sessionCwd,
    // твёрдо избегая засорения корня /workspace вне контейнера;
    // 1. если ИИ передал путь: абсолютный используем как есть, относительный интерпретируем
    //    относительно рабочей области проекта sessionCwd;
    // 2. если ИИ не дал savePath: автоматически генерируем уникальное имя с таймстампом
    //    в рабочей области проекта (или настроенной поддиректории), никогда не перезаписывая
    //    прежние скриншоты;
    // 3. строго уважаем расширение и путь, заданные ИИ, без принудительного переименования .png в .jpg.
    const projectDir = sessionCwd || process.cwd();
    const resolvedProjectDir = path.resolve(projectDir);

    // Разбор реального пути: поднимаемся по каталогам до первого существующего предка,
    // затем realpath — так раскрывается обход «symlink внутри рабочей области указывает наружу»
    // (одной лишь сверки строковых префиксов недостаточно).
    function realParentOf(p) {
      let dir = path.dirname(p);
      for (let i = 0; i < 64; i++) {
        if (fs.existsSync(dir)) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
    }
    const realRoot = (() => { try { return fs.realpathSync(resolvedProjectDir); } catch { return resolvedProjectDir; } })();
    const isWithinWorkspace = (p) => {
      const parent = realParentOf(p);
      return parent === realRoot || parent.startsWith(realRoot + path.sep);
    };

    // screenshotDir обязан лежать в рабочей области, иначе эта настройка игнорируется
    // (чтобы каталог за пределами рабочей области не становился целью деградации записи)
    let baseDir = resolvedProjectDir;
    if (activeConfig.screenshotDir && activeConfig.screenshotDir.trim()) {
      const candidate = path.resolve(resolvedProjectDir, activeConfig.screenshotDir.trim());
      if (isWithinWorkspace(candidate)) {
        baseDir = candidate;
      } else {
        console.warn(`[dsh-browser-desktop] screenshotDir за пределами рабочей области, игнорируем и откатываемся к корню рабочей области: ${activeConfig.screenshotDir}`);
      }
    }

    let targetFile;
    if (typeof savePath === 'string' && savePath.trim()) {
      const trimmed = savePath.trim();
      const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(projectDir, trimmed);

      // Проверка-песочница границ рабочей области: сверяем и строковый префикс, и realpath
      // (защита от побега через символьную ссылку)
      const withinByPath = resolved === resolvedProjectDir || resolved.startsWith(resolvedProjectDir + path.sep);
      if (!withinByPath || !isWithinWorkspace(resolved)) {
        const safeBase = path.basename(trimmed) || `screenshot-${Date.now()}`;
        targetFile = path.resolve(baseDir, safeBase);
      } else {
        targetFile = resolved;
      }

      // Если расширения нет — дописываем подходящее по качеству
      if (!path.extname(targetFile)) {
        targetFile += (isHigh ? '.png' : '.jpg');
      }
    } else {
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      targetFile = path.resolve(baseDir, `screenshot-${timestamp}.${isHigh ? 'png' : 'jpg'}`);
    }

    const ext = path.extname(targetFile).toLowerCase();
    const isJpeg = ext === '.jpg' || ext === '.jpeg';
    const captureFormat = isJpeg ? 'jpeg' : 'png';

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    // Будим рабочий стол
    const startRes = await callDesktopManager('start', {});
    if (!startRes || startRes.ok === false) {
      throw new Error(`Запуск контейнерного рабочего стола не удался: ${startRes?.error || 'шлюз не ответил'}`);
    }

    // 1. Если CDP включён — в приоритете скриншот страницы через CDP
    if (activeConfig.enableCdp !== false) {
      try {
        const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(1500) });
        if (listRes.ok) {
          const targets = await listRes.json();
          const pages = targets.filter(t => t.type === 'page');
          let page = null;
          if (targetTabId) {
            page = pages.find(p => p.id === targetTabId);
          }
          if (!page) {
            page = pages[0] || targets[0];
          }

          if (page && page.id) {
            try { await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(page.id)}`, { signal: AbortSignal.timeout(5000) }); } catch {}
          }

          if (page && page.webSocketDebuggerUrl) {
            const wsResult = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                try { ws.close(); } catch {}
                reject(new Error('Тайм-аут скриншота CDP'));
              }, 5000);

              const ws = new WebSocket(page.webSocketDebuggerUrl);
              ws.onopen = () => {
                const captureParams = {
                  format: captureFormat
                };
                if (captureFormat === 'jpeg') {
                  captureParams.quality = isLow ? 40 : (isHigh ? 95 : 80);
                }
                ws.send(JSON.stringify({
                  id: 200,
                  method: 'Page.captureScreenshot',
                  params: captureParams
                }));
              };
              ws.onmessage = (event) => {
                // P6: то же, что выше — считаем только ответ **с id текущего запроса (200)**,
                // иначе преждевременный сброс тайм-аута даст вечное зависание
                let msg;
                try { msg = JSON.parse(event.data); } catch (e) {
                  clearTimeout(timer);
                  try { ws.close(); } catch {}
                  return reject(e);
                }
                if (!msg || msg.id !== 200) return;
                clearTimeout(timer);
                try { ws.close(); } catch {}
                if (msg.error) return reject(new Error(msg.error.message));
                try {
                  const buf = Buffer.from(msg.result.data, 'base64');
                  fs.writeFileSync(targetFile, buf);
                  resolve({
                    path: targetFile,
                    bytes: buf.length,
                    title: page.title || '',
                    url: page.url || '',
                    quality: qualityLevel,
                    engine: `CDP (${captureFormat === 'png' ? 'PNG без потерь' : 'качество JPEG' + (isLow ? '40' : (isHigh ? '95' : '80'))})`,
                    status: 'captured'
                  });
                } catch (e) { reject(e); }
              };
              ws.onerror = (err) => {
                clearTimeout(timer);
                try { ws.close(); } catch {}
                reject(err);
              };
            });
            return wsResult;
          }
        }
      } catch (err) {
        console.warn('[dsh-browser-desktop] CDP временно недоступен, автооткат к нативному движку скриншотов X11:', err.message);
      }
    }

    // 2. Когда CDP выключен или не готов: нативный движок скриншотов X11 (scrot) снимает виртуальный экран :99
    const display = process.env.DISPLAY || ':99';
    const { spawnSync } = await import('node:child_process');
    const scrotArgs = captureFormat === 'png'
      ? ['-z', targetFile]
      : ['-q', isLow ? '40' : (isHigh ? '95' : '80'), targetFile];
    const scrotRes = spawnSync('scrot', scrotArgs, {
      env: { ...process.env, DISPLAY: display }
    });

    if (scrotRes.status !== 0 || !fs.existsSync(targetFile)) {
      throw new Error(`Сбой скриншота: ${scrotRes.stderr?.toString() || 'не удалось сохранить изображение'}`);
    }

    const stat = fs.statSync(targetFile);
    return {
      path: targetFile,
      bytes: stat.size,
      title: 'Container Desktop Screen',
      url: 'x11://display' + display,
      quality: qualityLevel,
      engine: `X11 scrot (${captureFormat === 'png' ? 'PNG без потерь' : 'качество JPEG' + (isLow ? '40' : (isHigh ? '95' : '80'))})`,
      status: 'captured'
    };
  }

  // Определение инструмента: browser_open (открыть веб-страницу, ИИ сам выбирает разрешение, умное переиспользование/новая вкладка)
  const browserOpenDef = {
    name: 'browser_open',
    description: 'Открыть указанную веб-страницу во встроенном графическом браузере Chromium контейнера. По умолчанию в приоритете умно переиспользует активную вкладку или открывает новую для экономии памяти контейнера (можно явно открыть новую через newTab: true). Поддерживает самостоятельно выбранное ИИ разрешение или время работы. Возвращает tabId текущей вкладки.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL веб-страницы для открытия (например https://github.com)'
        },
        newTab: {
          type: 'boolean',
          description: 'Необязательно: открывать ли в новой вкладке (по умолчанию false — в приоритете переиспользование текущей пустой или существующей вкладки, чтобы не копить память; передавайте true, когда нужно сравнение нескольких вкладок одновременно).'
        },
        tabId: {
          type: 'string',
          description: 'Необязательно: ID уже существующей вкладки для переиспользования/навигации. Если не указано и newTab=false, по умолчанию переиспользуется текущая рабочая вкладка.'
        },
        resolution: {
          type: 'string',
          description: 'Необязательно: разрешение просмотра текущей страницы (например "1920x1080", "1280x720", "1440x900", "2560x1440"). Если не передано — используется параметр из конфигурации центра настроек (по умолчанию 1920x1080).'
        },
        durationMinutes: {
          type: 'number',
          description: 'Необязательно: длительность разрешённой работы браузера и удержания активности (минут); по истечении — автоматический сон для экономии ресурсов. Пусто — по политике простоя по умолчанию'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          tabId: { type: 'string' },
          reused: { type: 'boolean' },
          resolution: { type: 'string' },
          vncUrl: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['url', 'status'],
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Открыто в контейнерном браузере ${value.url} (ID вкладки: ${value.tabId || 'неизвестно'}, ${value.reused ? 'переиспользована существующая вкладка' : 'открыта новая вкладка'}, разрешение: ${value.resolution || 'по умолчанию'}) — живой экран смотрите через VNC рабочего стола.`
      }]
    },
    async execute(args, exec) {
      // Перед вызовом читаем локальную авторитетную конфигурацию (синхронно, ноль сети),
      // чтобы при «полностью отключено» немедленно отказать
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        throw new Error('Контейнерный графический браузер полностью отключён в панели управления');
      }
      if (!args || typeof args.url !== 'string') {
        throw new Error('Параметр url должен быть непустой строкой');
      }
      return openInChromium(args.url.trim(), args.durationMinutes, exec.signal, args.resolution, {
        newTab: args.newTab === true,
        tabId: args.tabId
      });
    }
  };

  // Определение инструмента: browser_screenshot (поддержка самостоятельно выбранных ИИ пути, качества и целевой вкладки)
  const browserScreenshotDef = {
    name: 'browser_screenshot',
    description: 'Сделать скриншот окна браузера Chromium в контейнере или текущего рабочего стола в реальном времени. Поддерживается переданный ИИ путь сохранения savePath (относительно рабочей области или абсолютный); если не передан — во текущей рабочей области автоматически генерируется уникальное имя с таймстампом (чтобы не перезаписывать прежние скриншоты). Поддержка выбора качества (high высокое без потерь / medium среднее / low низкое), а также указания конкретной tabId.',
    parameters: {
      type: 'object',
      properties: {
        savePath: {
          type: 'string',
          description: 'Необязательно: путь сохранения скриншота (очень желательно, чтобы ИИ передавал осмысленный путь; поддерживается абсолютный или относительный путь в рабочей области текущей сессии/проекта, например "screenshot.png", "doc/preview-login.png"). Если оставить пусто — в папке текущей сессии/проекта автоматически создаётся уникальное имя с таймстампом (например screenshot-20260906120000.png), прежние скриншоты не перезаписываются.'
        },
        tabId: {
          type: 'string',
          description: 'Необязательно: ID вкладки для скриншота. Если не указано — по умолчанию снимается активная передняя вкладка или рабочий стол.'
        },
        quality: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Необязательно: выбор качества скриншота: "high" (высокое/без потерь, по умолчанию), "medium" (среднее/баланс размера), "low" (низкое/максимальное сжатие). Если не передано — берётся качество по умолчанию из настроек.'
        }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'number' },
          quality: { type: 'string' },
          engine: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['path', 'bytes', 'status'],
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Скриншот страницы готов (сохранён: \`${value.path}\`, размер: ${value.bytes} байт, качество: ${value.quality || 'по умолчанию'}, движок: ${value.engine || 'по умолчанию'})`
      }]
    },
    async execute(args, exec) {
      // Перед вызовом читаем локальную авторитетную конфигурацию (синхронно, ноль сети),
      // чтобы при «полностью отключено» немедленно отказать
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        throw new Error('Контейнерный графический браузер полностью отключён в панели управления');
      }
      const rawPath = typeof args?.savePath === 'string' ? args.savePath.trim() : null;
      const sessionCwd = exec?.agent?.session?.header?.cwd || process.cwd();
      return captureScreenshotDual(rawPath, args?.quality, args?.tabId, sessionCwd);
    }
  };

  // Определение инструмента: browser_control (для ИИ: явные запуск/остановка, смена разрешения, опрос, закрытие вкладок)
  const browserControlDef = {
    name: 'browser_control',
    description: 'Управление состоянием контейнерного графического браузера и жизненным циклом вкладок: закрыть указанную вкладку (close_tab), закрыть все страницы и сбросить в пустую (close_all_tabs), список вкладок (tabs), запуск/пробуждение (start), остановка сна (stop), перезапуск (restart) и запрос состояния (status).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['close_tab', 'close_all_tabs', 'tabs', 'start', 'stop', 'restart', 'status'],
          description: 'Выполняемое действие: close_tab (закрыть указанную или текущую вкладку), close_all_tabs (закрыть все вкладки и сбросить к пустой), tabs (список всех текущих вкладок), start (запустить/разбудить), stop (остановка сна всего рабочего стола), restart (перезапуск рабочего стола), status (состояние рабочего стола)'
        },
        tabId: {
          type: 'string',
          description: 'Когда action=close_tab, необязательно: ID закрываемой вкладки. Если не указан — по умолчанию закрывается последняя новая или активная вкладка.'
        },
        resolution: {
          type: 'string',
          description: 'Необязательно: разрешение для запуска или перезапуска (например "1920x1080", "1280x720"). Если не передано — берётся разрешение из конфигурации.'
        },
        durationMinutes: {
          type: 'number',
          description: 'Длительность работы или удержания активности (минут); по истечении — автоматический сон'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value)
      }]
    },
    async execute(args) {
      // Перед вызовом читаем локальную авторитетную конфигурацию (синхронно, ноль сети),
      // чтобы при «полностью отключено» немедленно отказать
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        throw new Error('Контейнерный графический браузер полностью отключён в панели управления');
      }
      // Действие с запросом/управлением вкладками
      if (args.action === 'tabs') {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(2000) });
          if (listRes.ok) {
            const allTargets = await listRes.json();
            const pages = allTargets.filter(t => t.type === 'page').map(p => ({
              id: p.id,
              title: p.title,
              url: p.url
            }));
            return { ok: true, tabs: pages, count: pages.length };
          }
        } catch (err) {
          return { ok: false, error: 'Не удалось получить список вкладок, или CDP временно недоступен: ' + err.message };
        }
        return { ok: false, error: 'Служба CDP не вернула корректный ответ' };
      }

      if (args.action === 'close_tab') {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(2000) });
          if (!listRes.ok) return { ok: false, error: 'Служба CDP недоступна' };
          const allTargets = await listRes.json();
          const pages = allTargets.filter(t => t.type === 'page');
          if (pages.length === 0) return { ok: true, message: 'Сейчас нет открытых вкладок' };

          let targetToClose = null;
          if (args.tabId) {
            targetToClose = pages.find(p => p.id === args.tabId);
            if (!targetToClose) return { ok: false, error: `Вкладка с ID ${args.tabId} не найдена` };
          } else {
            // В приоритете закрываем не-about:blank вкладки; если все пустые — закрываем последнюю
            targetToClose = pages.find(p => p.url !== 'about:blank' && p.url !== 'chrome://newtab/') || pages[pages.length - 1];
          }

          // Безопасная страховка: если остаётся только эта вкладка, заранее создаём пустую,
          // чтобы процесс Chromium не вышел из-за закрытия всех вкладок
          if (pages.length <= 1) {
            try {
              await fetch(`${cdpBase()}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
            } catch {}
          }

          const closeRes = await fetch(`${cdpBase()}/json/close/${encodeURIComponent(targetToClose.id)}`, { signal: AbortSignal.timeout(5000) });
          return {
            ok: closeRes.ok,
            closedTabId: targetToClose.id,
            closedUrl: targetToClose.url,
            status: closeRes.ok ? 'closed' : 'failed'
          };
        } catch (err) {
          return { ok: false, error: 'Исключение при закрытии вкладки: ' + err.message };
        }
      }

      if (args.action === 'close_all_tabs') {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(2000) });
          if (!listRes.ok) return { ok: false, error: 'Служба CDP недоступна' };
          const allTargets = await listRes.json();
          const pages = allTargets.filter(t => t.type === 'page');

          // Сначала создаём чистый about:blank.
          // P7: этот шаг **обязан пройти успешно** — при сбое сразу прерываемся и закрывать
          //       ничего не продолжаем, иначе Chromium выйдет «из-за нуля вкладок» и весь
          //       рабочий стол придётся поднимать заново (это дороже ошибки).
          let blankId = null;
          try {
            const blankRes = await fetch(`${cdpBase()}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(4000) });
            if (blankRes.ok) {
              const blankPage = await blankRes.json();
              blankId = blankPage && blankPage.id;
              if (blankId) await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(blankId)}`, { signal: AbortSignal.timeout(3000) });
            }
          } catch (e) {
            return { ok: false, error: 'Предсоздание пустой вкладки не удалось, операция закрытия прервана (чтобы браузер не вышел без вкладок): ' + e.message };
          }
          if (!blankId) {
            return { ok: false, error: 'Предсоздание пустой вкладки не удалось (CDP не вернул id новой страницы), операция закрытия прервана, чтобы не убить браузер' };
          }

          let closedCount = 0;
          for (const p of pages) {
            if (p.id !== blankId) {
              try {
                await fetch(`${cdpBase()}/json/close/${encodeURIComponent(p.id)}`, { signal: AbortSignal.timeout(3000) });
                closedCount++;
              } catch {}
            }
          }
          return {
            ok: true,
            closedCount,
            resetTo: 'about:blank'
          };
        } catch (err) {
          return { ok: false, error: 'Исключение при закрытии всех вкладок: ' + err.message };
        }
      }

      // Управление рабочим столом: разрешение переопределяем, только когда ИИ явно его задал
      // (иначе используется текущее значение, чтобы случайно не перезапустить весь стол)
      const bcRes = (typeof args.resolution === 'string' && args.resolution.trim()) ? args.resolution.trim().toLowerCase() : null;
      const parts = bcRes ? bcRes.split('x') : [];
      const width = parseInt(parts[0]) || undefined;
      const height = parseInt(parts[1]) || undefined;

      if (args.action === 'start') {
        return callDesktopManager('start', { durationMinutes: args.durationMinutes, width, height, enableCdp: activeConfig.enableCdp, cdpPort: activeConfig.cdpPort });
      }
      if (args.action === 'stop') {
        return callDesktopManager('stop');
      }
      if (args.action === 'restart') {
        return callDesktopManager('restart', { durationMinutes: args.durationMinutes, width, height });
      }
      return callDesktopManager('status');
    }
  };

  // ── Главный переключатель enabled: отзывная регистрация инструментов / промпта ──────────────────
  const promptSectionDef = {
    name: 'tool:browser_tools',
    order: 110,
    text: 'When you need to view or interact with a webpage, call browser_open (by default it reuses or navigates the active tab to save container memory; pass newTab: true only when you explicitly need multiple tabs open side-by-side; returns tabId). You can call browser_screenshot to capture a screenshot: you can pass your own savePath (supports relative or absolute path, e.g. "screenshot.png" or "doc/preview.png"; if omitted, a unique timestamped file is auto-generated in the current project workspace so previous captures are never overwritten), tabId (optional, targets a specific tab), and quality (high, medium, low). When done with a specific webpage task, call browser_control with action: "close_tab" (optionally specifying tabId) to close that tab, or action: "close_all_tabs" to reset to blank. Call browser_control with action: "stop" only when all browser tasks are completely finished and the entire desktop should be shut down.'
  };

  function registerTools() {
    if (registeredTools.length) return;
    // ctx.tools.register() возвращает disposer отмены регистрации этого инструмента,
    // благодаря чему поддерживается динамическое включение/отключение на ходу
    const added = [];
    try {
      for (const def of [browserOpenDef, browserScreenshotDef, browserControlDef]) {
        added.push(ctx.tools.register(def));
      }
    } catch (e) {
      // При частичном сбое регистрации откатываем, сохраняя инвариант «либо всё, либо ничего»
      for (const d of added) { try { d(); } catch {} }
      throw e;
    }
    registeredTools.push(...added);
    console.log('[dsh-browser-desktop] Зарегистрировано 3 инструмента браузера (browser_open/browser_screenshot/browser_control)');
  }

  function unregisterTools() {
    for (const dispose of registeredTools.splice(0)) {
      try { dispose(); } catch (e) { console.warn('[dsh-browser-desktop] Ошибка отмены регистрации инструмента:', e.message); }
    }
  }

  function registerPrompt() {
    if (registeredPrompt) return;
    // ctx.systemPrompt.section() возвращает Cordis effect-disposer, благодаря чему
    // поддерживается удаление внедрённого текста на ходу
    registeredPrompt = ctx.systemPrompt.section(promptSectionDef);
    console.log('[dsh-browser-desktop] Внедрена секция системного промпта браузера (tool:browser_tools)');
  }

  function unregisterPrompt() {
    if (!registeredPrompt) return;
    try { registeredPrompt(); } catch (e) { console.warn('[dsh-browser-desktop] Ошибка удаления секции промпта:', e.message); }
    registeredPrompt = null;
    console.log('[dsh-browser-desktop] Секция системного промпта браузера удалена (tool:browser_tools)');
  }

  // P2: **ограниченный** backoff-повтор после сбоя регистрации.
  // Раньше после сбоя enabledState просто ставился в null в ожидании «следующей синхронизации»,
  // а точка синхронизации — только execute() трёх инструментов: инструменты не зарегистрированы,
  // значит execute не вызовется никогда = застыть навсегда. Здесь повтор ведёт свой таймер.
  let retryTimer = null;
  let retryCount = 0;
  const MAX_REGISTER_RETRIES = 5;
  const REGISTER_RETRY_BASE_MS = 2000;

  function clearRegisterRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryCount = 0;
  }

  function scheduleRegisterRetry() {
    if (retryTimer) return;
    if (retryCount >= MAX_REGISTER_RETRIES) {
      console.error(`[dsh-browser-desktop] Регистрация инструментов не удалась ${MAX_REGISTER_RETRIES} раз подряд, повторы остановлены (ждём следующего изменения конфигурации/перезапуска)`);
      return;
    }
    const delay = REGISTER_RETRY_BASE_MS * Math.pow(2, retryCount);
    retryCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      try {
        if (enabledState === true) return;
        refreshAuthoritativeConfig(); // внутренне ещё раз попробует applyEnabledState
        if (enabledState !== true && activeConfig.enabled !== false) scheduleRegisterRetry();
      } catch (e) {
        console.error('[dsh-browser-desktop] Исключение при повторе регистрации:', e && e.message ? e.message : e);
        scheduleRegisterRetry();
      }
    }, delay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
    console.warn(`[dsh-browser-desktop] Повтор регистрации инструментов браузера через ${Math.round(delay / 1000)}с (попытка ${retryCount}/${MAX_REGISTER_RETRIES})`);
  }

  // Машина состояний enabled: одно переключение одновременно обрабатывает три вещи —
  // «регистрация инструментов + внедрение промпта + запуск рабочего стола».
  // Ключевой момент: при сбое регистрации состояние **не фиксируем** и планируем backoff-повтор,
  // чтобы не получить «статус включён, а инструменты на деле не зарегистрированы».
  function applyEnabledState(enabled) {
    const next = enabled !== false;
    if (next === enabledState) return;
    if (next) {
      try {
        registerTools();
        registerPrompt();
        enabledState = true;
        clearRegisterRetry();
      } catch (e) {
        console.error('[dsh-browser-desktop] Сбой регистрации инструментов/промпта (будет автоматический повтор):', e && e.message ? e.message : e);
        enabledState = null;
        scheduleRegisterRetry();
      }
    } else {
      clearRegisterRetry();
      unregisterTools();
      unregisterPrompt();
      enabledState = false;
      // Останавливаем браузер: глушим работающий виртуальный рабочий стол, освобождаем CPU/память
      callDesktopManager('stop')
        .then((r) => console.log('[dsh-browser-desktop] Плагин отключён, результат остановки рабочего стола:', JSON.stringify(r)))
        .catch(() => {});
      console.log('[dsh-browser-desktop] Плагин отключён: инструменты сняты, промпт удалён, рабочий стол остановлен');
    }
  }

  // При старте решаем по локальной авторитетной конфигурации: вешать/не вешать инструменты ИИ
  // и промпт (поэтому после перезапуска состояние сразу точное)
  refreshAuthoritativeConfig();
  console.log(`[dsh-browser-desktop] Авторитетная конфигурация загружена: enabled=${activeConfig.enabled !== false}, resolution=${activeConfig.resolution}`);

  // Одноразовая миграция старых значений (только один раз; дальше пространство имён настроек DSH не действует)
  migrateLegacySettingsOnce().catch((e) => console.warn('[dsh-browser-desktop] Сбой миграции старых настроек (игнорируется):', e.message));

  // При выгрузке/перезагрузке плагина чистим регистрации, чтобы не остались инструменты и промпт
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      clearRegisterRetry();
      unregisterTools();
      unregisterPrompt();
      enabledState = null;
    });
  }
}
