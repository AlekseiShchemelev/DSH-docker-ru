const http = require('http');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

const {
  isAuthEnabled,
  isSetupRequired,
  isWeakPassword,
  verifyToken,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie,
  checkRateLimit,
  recordAuthAttempt,
  resolveClientIp,
  setTrustProxy,
  updateAuthToken,
  getAuthToken
} = require('./auth');

const { ensureUpstreamCookie, injectPolyfill, getEncodingType, decompressBuffer } = require('./token-crawler');
const desktopManager = require('./desktop-manager');
const dshManager = require('./dsh-manager');
const backupService = require('./backup-service');
const pluginManager = require('./plugin-manager');
const versionService = require('./version-service');
const { getInternalToken, verifyInternalToken } = require('./internal-token');
const wsOrigin = require('./ws-origin');

// ── Сохранение файла конфигурации и чтение на лету ─────────────
const CONFIG_FILE = process.env.GATEWAY_CONFIG_FILE || '/root/.dsh/gateway.config.json';

function loadPersistedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('[gateway] Загружен сохранённый файл конфигурации шлюза:', CONFIG_FILE);
      return data;
    }
  } catch (err) {
    console.warn('[gateway] Не удалось прочитать сохранённую конфигурацию:', err.message);
  }
  return {};
}

function savePersistedConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    // Файл содержит чувствительные поля вроде authToken: при записи права сразу
    // сжимаются до 0600 (читает и пишет только владелец)
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    return true;
  } catch (err) {
    console.error('[gateway] Не удалось сохранить конфигурацию:', err.message);
    return false;
  }
}

// ── Политика автоматической очистки «призрачных» bundle (0.1.7) ────
// Сохраняется в этом файле конфигурации; читает и выполняет её скрипт сборки
// scripts/install-plugin.mjs на этапе entrypoint при старте контейнера.
// Допустимые значения: known (консервативно, по умолчанию) / all (агрессивно) / off (выкл.).
// ⚠️ Скрипт сборки выполняется только при СТАРТЕ контейнера, поэтому после изменения политики
//    контейнер нужно перезапустить (docker restart / compose up -d); «горячий перезапуск шлюза»
//    из админки скрипт сборки заново не запускает.
function normalizePruneMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off';
  if (v === 'all') return 'all';
  return 'known';
}
function normalizePruneExtra(value) {
  const list = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(list)].join(',');
}

/**
 * Текст ошибки для админки (N1): скрывает абсолютные пути хоста и прочие внутренние детали,
 * полная ошибка пишется только в журнал на сервере.
 * Сам API админки уже защищён аутентификацией, здесь предотвращается утечка служебной
 * информации (каталоги хоста / внутренние пути) через текст ошибки.
 */
function safeErrMsg(err) {
  const raw = err && err.message ? String(err.message) : String(err ?? 'неизвестная ошибка');
  console.error('[gateway] Ошибка API:', raw);
  return raw.replace(/(?:\/[\w.@%+-]+){2,}/g, '<path>').slice(0, 300);
}

// Точечное слияние и запись секции desktop в сохранённую конфигурацию
// (для «полного выключателя» и других runtime-переключателей; остальные поля не затрагиваются)
function persistDesktopConfig(patch = {}) {
  try {
    const cfg = loadPersistedConfig();
    cfg.desktop = { ...(cfg.desktop || {}), ...patch };
    cfg.savedAt = new Date().toISOString();
    if (!savePersistedConfig(cfg)) return null;
    console.log('[gateway] Сохранена конфигурация рабочего стола:', JSON.stringify(patch));
    return cfg;
  } catch (err) {
    console.error('[gateway] Ошибка при сохранении конфигурации рабочего стола:', err.message);
    return null;
  }
}

// Нормализация патча параметров рабочего стола (кроме enabled: общий переключатель
// обслуживается отдельным интерфейсом)
function normalizeDesktopConfigPatch(input = {}) {
  const patch = {};
  const w = Number(input.width), h = Number(input.height);
  if (w > 0) patch.width = w;
  if (h > 0) patch.height = h;
  if (typeof input.idleTimeoutMinutes === 'number') patch.idleTimeoutMinutes = input.idleTimeoutMinutes;
  if (typeof input.enableCdp === 'boolean') patch.enableCdp = input.enableCdp;
  const cdp = Number(input.cdpPort);
  if (cdp > 0) patch.cdpPort = cdp;
  if (typeof input.enableSidebarTab === 'boolean') patch.enableSidebarTab = input.enableSidebarTab;
  if (typeof input.screenshotQuality === 'string' && ['high', 'medium', 'low'].includes(input.screenshotQuality)) {
    patch.screenshotQuality = input.screenshotQuality;
  }
  if (typeof input.screenshotDir === 'string') patch.screenshotDir = input.screenshotDir.trim();
  return patch;
}

// Единственная точка записи параметров рабочего стола: сохранение + применение
// (общая для страницы Admin и внутренних плагинов)
function applyDesktopConfigPatch(input = {}) {
  const patch = normalizeDesktopConfigPatch(input);
  if (!Object.keys(patch).length) return { ok: false, error: 'Нет параметров для применения' };
  if (!persistDesktopConfig(patch)) return { ok: false, error: 'Не удалось сохранить конфигурацию рабочего стола, операция отменена' };
  const changed = desktopManager.applyConfig(patch);
  return { ok: true, changed, desktop: desktopManager.getStatus() };
}

// Единственная точка записи общего переключателя браузера: сохранение + немедленный запуск/остановка
async function applyDesktopMaster(enabled, opts = {}) {
  const next = enabled !== false;
  const startNow = opts.startNow !== false; // при включении рабочий стол поднимается сразу;
  // вызов из образа может передать false, чтобы изменить только состояние
  // Соглашение: плагин отключён → браузер тоже недоступен. При отключённом плагине браузер включить нельзя.
  if (next && isBrowserPluginDisabled()) {
    return { ok: false, error: 'Плагин браузера отключён: сначала включите плагин на странице «Расширения и плагины», затем включайте браузер' };
  }
  if (!persistDesktopConfig({ enabled: next })) {
    return { ok: false, error: 'Не удалось сохранить общий переключатель браузера, операция отменена' };
  }
  desktopManager.setEnabled(next);
  let r = { ok: true, skipped: true };
  if (next && startNow) r = await desktopManager.start();
  else if (!next) r = await desktopManager.stop();
  return { ok: true, enabled: next, result: r, desktop: desktopManager.getStatus() };
}

// Наш плагин: единственный источник функций браузера и ИИ-инструментов
const BROWSER_DESKTOP_PLUGIN = '@dsh-custom/dsh-browser-desktop';

// Отключён ли плагин «явно» (установлен, но отсутствует в bundles).
// Примечание: если плагин никогда не устанавливался (его нет), возвращается false —
// это не мешает автозапуску рабочего стола в установке без плагинов.
function isBrowserPluginDisabled() {
  try {
    const list = pluginManager.getPlugins().plugins || [];
    const p = list.find(x => x.name === BROWSER_DESKTOP_PLUGIN);
    return !!p && p.enabled === false;
  } catch {
    return false;
  }
}

// Страница-пояснение при обращении к VNC, когда браузер «полностью отключён»
// (чтобы вместо чёрного экрана / неудачного подключения пользователь увидел объяснение)
function serveDesktopDisabledPage(res) {
  const adminPath = ADMIN_PATH || '/admin';
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Контейнерный браузер отключён</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:560px;padding:32px 36px;border:1px solid #2c2c2e;border-radius:14px;background:#1b1b1c;text-align:center}
  h1{font-size:18px;margin:0 0 12px}
  p{font-size:13px;line-height:1.8;color:#9ca3af;margin:0 0 20px}
  a{display:inline-block;padding:9px 18px;border-radius:8px;background:#4176e6;color:#fff;text-decoration:none;font-size:13px}
</style></head>
<body><div class="box">
  <h1>🖥️ Контейнерный браузер сейчас недоступен</h1>
  <p>Причина: браузер был «полностью отключён» в админке либо отключён его плагин.<br>Этот контейнер не запускает рабочий стол Xvfb / Chromium, поэтому подключиться по VNC невозможно.<br>Чтобы продолжить использование, нажмите «Включить браузер» на странице «Браузер и управление рабочим столом» в админке.</p>
  <a href="${adminPath}/">Перейти в админку и включить</a>
</div></body></html>`;
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache' });
  res.end(html);
}

// Прямая навигация браузера (запрос HTML-страницы). Пока рабочий стол не готов,
// возвращаем страницу с автоперезагрузкой вместо HTML внутри запроса к ресурсу
// или голого JSON / 502.
function isHtmlNavigation(req) {
  return !!req && req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

// Отдельная страница «рабочий стол запускается»: по умолчанию автоперезагрузка через 3 секунды,
// после готовности рабочего стола пользователь незаметно попадает в noVNC.
// Файл страницы: gateway/public/desktop-starting.html (без внешних зависимостей, открывается и отдельно).
function serveDesktopStartingPage(res, { retrySeconds = 3 } = {}) {
  const seconds = Number(retrySeconds) > 0 ? Number(retrySeconds) : 3;
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, 'public', 'desktop-starting.html'), 'utf8')
      .replace(/__DSH_ADMIN_PATH__/g, ADMIN_PATH)
      .replace('__DSH_RETRY_SECONDS__', String(seconds));
  } catch (err) {
    // Запасной вариант: даже если файла страницы нет — никогда не отвечаем голым JSON / 502
    html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="${seconds}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Рабочий стол контейнера запускается</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="text-align:center;font-size:14px">🖥️ Рабочий стол контейнера запускается, страница обновится через ${seconds} с…</div>
</body></html>`;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(html);
}

const persisted = loadPersistedConfig();

// Доверять ли обратному прокси (определяет, брать ли IP для ограничения частоты из XFF,
// или адрес пира сокета): явное значение конфигурации имеет приоритет над переменной окружения
if (persisted.trustProxy !== undefined) {
  setTrustProxy(persisted.trustProxy === true || persisted.trustProxy === '1' || persisted.trustProxy === 'true');
}

// Применяем сохранённый код доступа и настройки рабочего стола
// M13: явная переменная окружения AUTH_TOKEN имеет приоритет над сохранённым паролем —
// иначе ротация пароля в .env не вступает в силу (в контейнере продолжает действовать
// старый пароль из тома данных, и администратор решает, что он уже обновлён).
const AUTH_TOKEN_SOURCE = (process.env.AUTH_TOKEN || process.env.ACCESS_CODE || '').trim()
  ? 'env'
  : (persisted.authToken !== undefined ? 'persisted' : 'default');
if (AUTH_TOKEN_SOURCE !== 'env' && persisted.authToken !== undefined) {
  updateAuthToken(persisted.authToken);
}
if (AUTH_TOKEN_SOURCE === 'env') {
  console.log('[gateway] Источник пароля доступа: переменная окружения AUTH_TOKEN (в приоритете над сохранённой конфигурацией)');
}
// M13: при расхождении переменной окружения и сохранённой конфигурации выводим явное
// предупреждение, чтобы избежать тихой путаницы «изменил в панели, но не применилось»
function warnConfigConflict(label, envValue, persistedValue) {
  if (envValue === undefined || envValue === '' || persistedValue === undefined) return;
  if (String(envValue) !== String(persistedValue)) {
    console.warn(`[gateway] Конфликт конфигурации: переменная окружения ${label}(${envValue}) не совпадает с сохранённой конфигурацией(${persistedValue}); по правилу M13 приоритет у переменной окружения`);
  }
}
warnConfigConflict('PROXY_PORT', process.env.PROXY_PORT, persisted.proxyPort);
warnConfigConflict('ADMIN_PATH', process.env.ADMIN_PATH, persisted.adminPath);
warnConfigConflict('VNC_PATH', process.env.VNC_PATH, persisted.vncPath);
if (persisted.desktop) {
  desktopManager.updateConfig(persisted.desktop);
}
// Автовосстановление после сбоев при запуске и автоматическая изоляция проблемных плагинов
// (по умолчанию включено; предел за один цикл запуска по умолчанию 5, значение настраивается)
const autoHealEnabled = persisted.autoHealPlugins !== false;
const autoHealMaxPerBoot = Math.max(1, Math.min(50, Number(persisted.autoHealMaxPerBoot) || 5));
dshManager.setAutoHeal(autoHealEnabled, autoHealMaxPerBoot);

// Политика очистки «призрачных» bundle (выполняет install-plugin.mjs на этапе старта контейнера;
// здесь только читается для отображения/сохранения)
const pruneStaleBundles = normalizePruneMode(persisted.pruneStaleBundles);
const pruneBundlesExtra = normalizePruneExtra(persisted.pruneBundlesExtra);

// ── Порты и динамические пути ──────────────────────────────────
// M13: явная переменная окружения имеет приоритет над сохранённой конфигурацией
// (иначе PROXY_PORT в .env превращается в «мёртвую настройку»: после смены порта в панели
// маппинг 3080:3080 в compose молча расходится с реальностью).
const PROXY_PORT_SOURCE = process.env.PROXY_PORT ? 'env' : (persisted.proxyPort ? 'persisted' : 'default');
const PROXY_PORT = Number(process.env.PROXY_PORT || persisted.proxyPort) || 3080;
process.env.PROXY_PORT = String(PROXY_PORT);
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const VNC_PORT = Number(process.env.VNC_PORT) || 6080;

function normalizeRoutePath(raw, defaultPath) {
  let p = (raw || defaultPath).trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  return p.length === 0 ? defaultPath : p;
}

const ADMIN_PATH_SOURCE = process.env.ADMIN_PATH ? 'env' : (persisted.adminPath ? 'persisted' : 'default');
const VNC_PATH_SOURCE = process.env.VNC_PATH ? 'env' : (persisted.vncPath ? 'persisted' : 'default');
const ADMIN_PATH = normalizeRoutePath(process.env.ADMIN_PATH || persisted.adminPath, '/admin');
const VNC_PATH = normalizeRoutePath(process.env.VNC_PATH || persisted.vncPath, '/vnc');
// Базовый адрес VNC, отдаваемый наружу, всегда с завершающим слэшем: любой потребитель
// (iframe в боковой панели, ссылки перехода, сторонние интеграции) использует его как href /
// конкатенирует относительные пути и не ошибётся в определении базового пути из-за
// отсутствия завершающего слэша (не приходится полагаться на запасной 302).
const VNC_PATH_HREF = VNC_PATH + '/';

const DSH_TARGET = 'http://127.0.0.1:' + DSH_PORT;
const VNC_TARGET = 'http://127.0.0.1:' + VNC_PORT;

// Белый список внешних имён хостов (для проверки совпадения источника WebSocket):
// явные значения из конфигурации / переменных окружения через запятую.
// Например, при развёртывании за доменом https://dsh.example.com можно задать PUBLIC_HOST=dsh.example.com.
const PUBLIC_HOSTS = String(persisted.publicHost || process.env.PUBLIC_HOST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PUBLIC_PATHS = new Set([
  '/login',
  '/favicon.ico',
  '/favicon.svg',
  '/manifest.webmanifest'
]);

// ── Экземпляры обратного прокси и обработка сбоев ──────────────
const dshProxy = httpProxy.createProxyServer({
  target: DSH_TARGET,
  ws: true,
  changeOrigin: true
});

const vncProxy = httpProxy.createProxyServer({
  target: VNC_TARGET,
  ws: true,
  changeOrigin: true
});

dshProxy.on('error', (err, req, res) => {
  console.warn('[dsh-proxy] Ожидание подключения к апстриму (этап запуска/остановки DSH):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    let errorMsg = 'DeepSeek Harness запускается и готовится к работе, подождите несколько секунд и обновите страницу';
    if (dshManager.manualStopped) {
      errorMsg = 'Служба DeepSeek Harness сейчас остановлена вручную. Для работы нажмите [Запустить DSH] в админ-панели.';
    } else if (dshManager.lastExitInfo && !dshManager.proc) {
      errorMsg = `Запуск DeepSeek Harness неожиданно завершился (код: ${dshManager.lastExitInfo.code || -1}). Подробные журналы — на /admin/.`;
    }

    const isHtml = (req.headers.accept || '').includes('text/html');
    if (isHtml) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>DeepSeek Harness — запускается</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; max-width: 480px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.08); text-align: center; }
    h2 { font-size: 18px; margin-bottom: 12px; color: #1677ff; }
    p { font-size: 13px; color: #64748b; line-height: 1.6; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 8px 16px; border-radius: 8px; background: #0f172a; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚡ DeepSeek Harness запускается</h2>
    <p>${errorMsg}<br/>Страница автоматически обновится через 5 секунд…</p>
    <a href="/admin/" class="btn">Открыть консоль администратора и посмотреть журналы ↗</a>
  </div>
</body>
</html>`);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: errorMsg, exitInfo: dshManager.lastExitInfo }));
    }
  }
});

vncProxy.on('error', (err, req, res) => {
  console.warn('[vnc-proxy] Ожидание подключения к апстриму (этап запуска VNC):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    // При прямой навигации браузера (сама страница noVNC) возвращаем отдельную страницу
    // «запускается» (автообновление через 3 с), чтобы пользователь не увидел сырой
    // JSON 502 и не решил, что «рабочий стол недоступен».
    if (isHtmlNavigation(req)) {
      return serveDesktopStartingPage(res);
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Графический рабочий стол VNC готовится, подождите несколько секунд и обновите страницу' }));
  }
});

vncProxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();
  // HTML-страницам noVNC запрещаем долгое кэширование на клиенте, чтобы после обновления
  // образа или версии сразу загружалась актуальная версионированная точка входа
  if (ct.includes('text/html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
});

// Polyfill и патчи петли обратной связи
const LOOPBACK_NEEDLE_1 = 'isLoopbackHostname(pageLocation.hostname)';
const LOOPBACK_NEEDLE_2 = 'connection.isLoopback ? "host" : "memory"';
const LOOPBACK_NEEDLE_3 = 'connection.isLoopback?"host":"memory"';

dshProxy.on('proxyRes', (proxyRes, req, res) => {
  // Если апстрим временно отвечает 401 — автоматически повторяем обмен сеансовой кукой
  if (proxyRes.statusCode === 401) {
    dshManager.exchangeSessionCookie().catch(() => {});
  }

  const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();
  const origCe = proxyRes.headers['content-encoding'];
  const encType = getEncodingType(origCe);

  if (ct.includes('text/html')) {
    // HTML-точку входа запрещено кэшировать браузеру, чтобы при каждой загрузке
    // получалась актуальная сборка (полностью устраняет 404 по устаревшему rev)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!encType) {
      // Без сжатия сохраняем существующую потоковую логику «инъекции в первый блок» (без регрессий)
      delete proxyRes.headers['content-length'];
      res.removeHeader('content-length');

      let injected = false;
      const origWrite = res.write.bind(res);
      res.write = function (chunk, ...rest) {
        if (!injected && chunk) {
          injected = true;
          let htmlStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          htmlStr = injectPolyfill(htmlStr);
          chunk = Buffer.from(htmlStr);
        }
        return origWrite(chunk, ...rest);
      };
      return;
    }

    if (encType === 'unknown') {
      console.warn(`[gateway] Обнаружен неизвестный код сжатия (${origCe}), вставка в HTML пропущена, чтобы не повредить ответ`);
      return;
    }

    // Апстрим сжимает ответ gzip/deflate/br: буферизуем все чанки, на res.end распаковываем,
    // выполняем вставку и удаляем content-encoding
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');
    delete proxyRes.headers['content-encoding'];
    res.removeHeader('content-encoding');

    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return true;
    };

    res.end = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.write = origWrite;
      res.end = origEnd;

      const rawBuffer = Buffer.concat(chunks);
      let decompressed = null;
      try {
        decompressed = decompressBuffer(rawBuffer, encType);
      } catch (err) {
        // Запасной вариант: content-encoding удалён до writeHead, а здесь res.headersSent уже true,
        // поэтому setHeader для восстановления заголовков невозможен (выбросит ERR_HTTP_HEADERS_SENT
        // и далее uncaughtException). Поэтому просто прозрачно передаём неизменённые байты
        // с предупреждением; весь хук res.end никогда не должен бросать исключение.
        console.warn(`[gateway] Не удалось распаковать HTML апстрима (${encType}):`, err && err.message, '— передаём исходные байты без изменений');
        try {
          return origEnd(rawBuffer, ...rest);
        } catch (e2) {
          console.warn('[gateway] Не удалось записать запасной HTML:', e2 && e2.message);
          try { res.destroy(); } catch {}
          return;
        }
      }

      let htmlStr = decompressed.toString('utf8');
      htmlStr = injectPolyfill(htmlStr);
      origEnd(Buffer.from(htmlStr), ...rest);
    };
    return;
  }

  if (ct.includes('javascript')) {
    if (encType === 'unknown') {
      console.warn(`[gateway] Обнаружен неизвестный код сжатия (${origCe}), замена в JS пропущена, чтобы не повредить ответ`);
      return;
    }

    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');

    if (encType) {
      delete proxyRes.headers['content-encoding'];
      res.removeHeader('content-encoding');
    }

    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return true;
    };

    res.end = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.write = origWrite;
      res.end = origEnd;

      const rawBuffer = Buffer.concat(chunks);
      let body = null;

      if (encType) {
        try {
          body = decompressBuffer(rawBuffer, encType).toString('utf8');
        } catch (err) {
          // Как и выше: headersSent уже true, setHeader для content-encoding невозможен;
          // выполняем только безопасную передачу без исключений.
          console.warn(`[gateway] Не удалось распаковать JS апстрима (${encType}):`, err && err.message, '— передаём исходные байты без изменений');
          try {
            return origEnd(rawBuffer, ...rest);
          } catch (e2) {
            console.warn('[gateway] Не удалось записать запасной JS:', e2 && e2.message);
            try { res.destroy(); } catch {}
            return;
          }
        }
      } else {
        body = rawBuffer.toString('utf8');
      }

      if (body.includes(LOOPBACK_NEEDLE_1)) body = body.split(LOOPBACK_NEEDLE_1).join('true');
      if (body.includes(LOOPBACK_NEEDLE_2)) body = body.split(LOOPBACK_NEEDLE_2).join('"host"');
      if (body.includes(LOOPBACK_NEEDLE_3)) body = body.split(LOOPBACK_NEEDLE_3).join('"host"');

      origEnd(Buffer.from(body), ...rest);
    };
  }
});

async function alignHeadersForDsh(req) {
  req.headers['host'] = '127.0.0.1:' + DSH_PORT;
  if (req.headers['origin']) req.headers['origin'] = DSH_TARGET;
  if (req.headers['sec-fetch-site'] === 'cross-site') req.headers['sec-fetch-site'] = 'same-origin';

  const pathname = (req.url || '').split('?')[0];
  if (pathname.endsWith('.js') || pathname.endsWith('.html') || pathname === '/' || pathname.startsWith('/plugins/')) {
    req.headers['accept-encoding'] = 'identity';
  }

  // Инъекция в заголовки легитимной подписанной официальной куки dsh-auth-...,
  // которую шлюз динамически получает и обменивает
  const upstreamCookie = (await dshManager.ensureValidUpstreamCookie()) || (await ensureUpstreamCookie(DSH_TARGET));
  if (upstreamCookie) {
    const existing = req.headers['cookie'] || '';
    req.headers['cookie'] = existing ? (existing + '; ' + upstreamCookie) : upstreamCookie;
  }
}

function serveStaticHtml(res, filename) {
  const filePath = path.join(__dirname, 'public', filename);
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не удалось загрузить страницу: ' + filename);
  }
}

function getClientIp(req) {
  // Стратегия выбора IP для ограничения частоты описана в auth.resolveClientIp: по умолчанию
  // используется только адрес пира сокета, XFF учитывается лишь при явном доверии прокси
  // (TRUST_PROXY / trustProxy в gateway.config.json).
  return resolveClientIp(req);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 512) {
        req.destroy(new Error('Payload too large'));
        reject(new Error('Тело запроса слишком велико (более 512 КБ)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Некорректный формат JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

// ── Обработчики API администратора ─────────────────────────────
async function handleAdminApi(req, res, pathname, query) {
  const subPath = pathname.slice(ADMIN_PATH.length);

  try {
    // 1. Общее состояние
    if (subPath === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        project: {
          version: versionService.getLocalProjectVersion()
        },
        dsh: dshManager.getStatus(),
        desktop: desktopManager.getStatus(),
        paths: {
          admin: ADMIN_PATH,
          vnc: VNC_PATH_HREF,
          proxyPort: PROXY_PORT
        },
        authEnabled: isAuthEnabled(),
        authToken: isAuthEnabled() && getAuthToken() ? '******' : '',
        hasAuthToken: Boolean(getAuthToken()),
        autoHealPlugins: dshManager.autoHealEnabled,
        autoHealMaxPerBoot: dshManager.maxAutoHealPerBoot,
        pruneStaleBundles,
        pruneBundlesExtra,
        autoIsolatedEvents: dshManager.getAutoIsolatedEvents()
      });
    }

    // 1.1 Проверка версии и многоуровневые предупреждения о безопасности (мультиканальный CDN / GitHub / локальный запасной вариант)
    if (subPath === '/api/version/check' && req.method === 'GET') {
      const force = query.get('refresh') === '1';
      const checkRes = await versionService.check(force, dshManager);
      checkRes.isRemoteMeta = versionService.isUsingRemoteMeta();
      return sendJson(res, 200, checkRes);
    }

    // 2. Список версий DSH
    if (subPath === '/api/dsh/versions' && req.method === 'GET') {
      const force = query.get('refresh') === '1';
      const meta = await versionService.fetchRemoteMeta(force);
      const data = await dshManager.fetchAvailableVersions(force, meta);
      if (Array.isArray(data.versions)) {
        data.versionEvaluations = {};
        for (const v of data.versions) {
          data.versionEvaluations[v] = versionService.evaluateTargetVersion(v, meta);
        }
      }
      data.isRemoteMeta = versionService.isUsingRemoteMeta();
      data.compatibility = meta.compatibility || {};
      return sendJson(res, 200, data);
    }

    // 2.0 Статистика / очистка / удаление в сохранённом хранилище версий (Issue #7)
    if (subPath === '/api/dsh/versions/stats' && req.method === 'GET') {
      return sendJson(res, 200, dshManager.getVersionsStoreStats());
    }

    if (subPath === '/api/dsh/versions/gc' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const keepN = Number(body && body.keepN) || undefined;
      const r = dshManager.gcVersions({ keepN, dryRun: !!(body && body.dryRun === true) });
      return sendJson(res, 200, r);
    }

    if (subPath.startsWith('/api/dsh/versions/') && req.method === 'DELETE') {
      const ver = decodeURIComponent(subPath.slice('/api/dsh/versions/'.length));
      if (!ver || ver.includes('/')) return sendJson(res, 400, { ok: false, error: 'Недопустимый номер версии' });
      const r = dshManager.deleteCachedVersion(ver);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // 2.05 Управление точками отката на месте и восстановление из них (Issue #7)
    if (subPath === '/api/dsh/rollback' && req.method === 'GET') {
      const rb = dshManager.getRollbackPoint();
      return sendJson(res, 200, { ok: true, exists: rb.exists, rollback: rb.exists ? rb : null, ...rb });
    }

    if (subPath === '/api/dsh/rollback' && req.method === 'DELETE') {
      if (dshManager.installing) {
        return sendJson(res, 409, { ok: false, error: 'Идёт смена версии или восстановление: удалять точку отката запрещено' });
      }
      const current = dshManager.getRollbackPoint();
      if (!current.exists) {
        return sendJson(res, 404, { ok: false, error: 'Точка отката не существует или уже очищена' });
      }
      const r = dshManager.deleteRollbackPoint();
      if (!r.ok) {
        if (r.error && r.error.includes('Идёт переключение')) return sendJson(res, 409, r);
        if (r.error && r.error.includes('не существует')) return sendJson(res, 404, r);
        return sendJson(res, 500, r);
      }
      return sendJson(res, 200, r);
    }

    if (subPath === '/api/dsh/rollback/restore' && req.method === 'POST') {
      if (dshManager.installing) {
        return sendJson(res, 409, { ok: false, error: 'Уже выполняется задача смены версии или восстановления' });
      }
      const current = dshManager.getRollbackPoint();
      if (!current.exists) {
        return sendJson(res, 404, { ok: false, error: 'Резервная копия точки отката отсутствует, восстановление невозможно' });
      }
      if (!current.abiMatches) {
        return sendJson(res, 400, { ok: false, error: `Node ABI (${current.nodeAbi}) точки отката не совпадает с текущим окружением, восстановление невозможно` });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // P2 (Issue #9): запрет буферизации обратным прокси, чтобы прогресс/журнал уходили
        // в реальном времени построчно (Nginx и т.п.)
        'X-Accel-Buffering': 'no'
      });

      const sendEvt = (data) => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
      };

      sendEvt({ type: 'log', message: `[Восстановление на месте] Начато восстановление резервной копии точки отката ядра (v${current.version || 'unknown'})...` });

      const r = await dshManager.restoreRollbackPoint(
        (prog) => {
          sendEvt({ type: 'progress', ...prog });
        },
        (line) => {
          sendEvt({ type: 'log', message: line });
        }
      );

      sendEvt({ type: 'done', ...r });
      res.end();
      return;
    }

    // 2.1 Получение журналов DSH в реальном времени и сведений о сбоях
    if (subPath === '/api/dsh/logs' && req.method === 'GET') {
      const count = Math.min(Number(query.get('lines')) || 100, 300);
      return sendJson(res, 200, {
        ok: true,
        running: dshManager.proc !== null && dshManager.proc.exitCode === null,
        ready: dshManager.ready,
        pid: dshManager.proc ? dshManager.proc.pid : null,
        manualStopped: !!dshManager.manualStopped,
        exitInfo: dshManager.lastExitInfo,
        recentLogs: dshManager.getRecentLogs(count)
      });
    }

    // 3. Установка / смена версии DSH (с подробными логами в реальном времени через SSE)
    if (subPath === '/api/dsh/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const version = (body.version || '').trim();
      if (!version) return sendJson(res, 400, { ok: false, error: 'Номер версии не может быть пустым' });
      // Строгая проверка: номер версии должен быть корректным semver
      // (блокирует directory traversal через `../` и инъекцию npm-спецификаторов)
      if (!dshManager.isValidVersion(version)) {
        return sendJson(res, 400, { ok: false, error: 'Некорректный формат версии (допустимы только версии вида 0.1.6-alpha.2)' });
      }

      // Предохранитель: отказываемся от онлайн-горячей смены на разрушительно рефакторинговые
      // версии (уровень danger, например переработка нижнего уровня >=0.2.0)
      const evalRes = versionService.evaluateTargetVersion(version);
      if (evalRes && evalRes.level === 'danger') {
        return sendJson(res, 400, {
          ok: false,
          error: evalRes.message || 'В этой версии крупная разрушительная переработка архитектуры: онлайн-горячая смена запрещена, необходимо заново скачать свежий Docker-образ.'
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // P2 (Issue #9): запрет буферизации обратным прокси, чтобы прогресс/журнал уходили
        // в реальном времени построчно (Nginx и т.п.)
        'X-Accel-Buffering': 'no'
      });

      const sendEvt = (data) => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
      };

      // Результат галочки в диалоге перед переключением: архивировать ли текущую версию
      // движка (по умолчанию отмечено, пользователь может снять отметку)
      const archiveCurrent = body.archiveCurrent === true;
      sendEvt({ type: 'log', message: `[Параметры переключения] Архивировать текущую версию движка: ${archiveCurrent ? 'да' : 'нет'}` });

      const r = await dshManager.installVersion(
        version,
        (prog) => {
          sendEvt({ type: 'progress', ...prog });
        },
        (line) => {
          sendEvt({ type: 'log', message: line });
        },
        { archiveCurrent }
      );

      sendEvt({ type: 'done', ...r });
      res.end();
      return;
    }

    // 4. Управление запуском, остановкой и перезапуском службы DSH
    if (subPath === '/api/dsh/start' && req.method === 'POST') {
      dshManager.manualStopped = false;
      const r = await dshManager.boot();
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/dsh/stop' && req.method === 'POST') {
      dshManager.manualStopped = true;
      const r = await dshManager.stop();
      return sendJson(res, 200, r);
    }

    if (subPath === '/api/dsh/restart' && req.method === 'POST') {
      dshManager.manualStopped = false;
      const r = await dshManager.restart();
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/dsh/auto-heal/clear' && req.method === 'POST') {
      dshManager.clearAutoIsolatedEvents();
      return sendJson(res, 200, { ok: true });
    }

    // 5. Управление запуском и остановкой рабочего стола
    // 5.1 «Полный выключатель»: сохраняется в конфигурации; после отключения рабочий стол
    //     больше не запускается автоматически даже после перезапуска шлюза/контейнера
    if (subPath === '/api/desktop/master' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await applyDesktopMaster(body?.enabled !== false);
      if (!r.ok) return sendJson(res, 500, r);
      // Добавление/удаление ИИ-инструментов и меню подсказок плагин определяет при
      // ПЕРЕЗАПУСКЕ СЛУЖБЫ: при restart=true DSH перезапускается немедленно
      if (body?.restart === true) {
        console.log('[gateway] Общий переключатель браузера переключён, перезапускаем DSH для обновления меню ИИ-инструментов...');
        const rr = await dshManager.restart().catch(err => ({ ok: false, error: safeErrMsg(err) }));
        r.dshRestarted = !!rr.ok;
        if (!r.dshRestarted) r.warning = 'Состояние сохранено и рабочий стол остановлен, но перезапуск DSH не удался: ' + (rr.error || 'неизвестная ошибка');
      }
      return sendJson(res, 200, r);
    }

    // 5.2 Параметры рабочего стола (разрешение/простой/CDP/скриншоты/вкладка боковой панели):
    //     страница Admin «Браузер и управление рабочим столом» — единственная авторитетная
    //     точка записи, данные сразу сохраняются в gateway.config.json
    if (subPath === '/api/desktop/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = applyDesktopConfigPatch(body);
      return sendJson(res, r.ok ? 200 : (r.error?.includes('Нет параметров') ? 400 : 500), r);
    }

    if (subPath === '/api/desktop/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.start(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/stop' && req.method === 'POST') {
      const r = await desktopManager.stop();
      return sendJson(res, 200, r);
    }

    if (subPath === '/api/desktop/restart' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.restart(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/keepalive' && req.method === 'POST') {
      const body = await readJsonBody(req);
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }

    // 6. Резервное копирование, восстановление и импорт конфигурационных снимков
    //    (полностью развязано с веб-службой, выполняется асинхронно и неблокирующе)
    if (subPath === '/api/snapshots' && req.method === 'GET') {
      return sendJson(res, 200, backupService.listBackups());
    }

    if (subPath === '/api/snapshots/create' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const r = await backupService.createBackup(body.name, body.type || body.backupType);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/inspect' && req.method === 'GET') {
      const file = query.get('file') || '';
      if (!file) {
        return sendJson(res, 400, { ok: false, error: 'Отсутствует параметр file' });
      }
      try {
        const r = await backupService.inspectSnapshot(file);
        return sendJson(res, r.ok ? 200 : 404, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const mode = (body && body.mode) || 'full';
      if (mode !== 'full' && mode !== 'config-only') {
        return sendJson(res, 400, { ok: false, error: `Недопустимый режим восстановления: ${mode} (поддерживаются только 'full' и 'config-only')` });
      }
      try {
        // Issue #9: поддерживается выбор объёма восстановления mode: 'full' | 'config-only'
        // (по умолчанию 'full'); при восстановлении автоматически совместимы относительные
        // симлинки из старых снимков, «выползающие за корень архива»
        const r = await backupService.restoreBackup(body.filename, dshManager, { mode });
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/import' && req.method === 'POST') {
      const filename = query.get('filename') || req.headers['x-filename'] || 'imported-snapshot.tar.gz';
      try {
        const r = await backupService.importBackupStream(req, filename);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = backupService.deleteBackup(body.filename);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/snapshots/download' && req.method === 'GET') {
      const file = query.get('file') || '';
      const filePath = backupService.getBackupPath(file);
      if (!filePath) return sendJson(res, 404, { ok: false, error: 'Файл снимка не найден' });

      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="' + path.basename(filePath) + '"'
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    // 6.5 Распознавание расширяющих плагинов DSH, их включение/выключение, очистка и удаление
    if (subPath === '/api/plugins' && req.method === 'GET') {
      try {
        const r = pluginManager.getPlugins();
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('Не указано имя плагина');
        const enabled = body.enabled !== false;
        const r = await pluginManager.togglePlugin(body.name, enabled);
        // В согласовании с общим переключателем браузера («плагин отключён → браузер недоступен»):
        // при отключении нашего плагина браузер тоже полностью выключается; при включении
        // общий переключатель возвращается (рабочий стол принудительно не поднимается — по мере надобности).
        let desktopMirrored = null;
        if (body.name === BROWSER_DESKTOP_PLUGIN) {
          const m = await applyDesktopMaster(enabled, { startNow: false });
          desktopMirrored = m.ok === true;
        }
        // При restart=true DSH перезапускается немедленно, чтобы старт/остановка bundle
        // реально вступила в силу (иначе нужен ручной перезапуск пользователем)
        let restarted = false;
        if (body.restart === true) {
          console.log(`[gateway] Плагин ${body.name} ${enabled ? 'включён' : 'отключён'}, перезапускаем DSH для применения...`);
          const rr = await dshManager.restart().catch(err => ({ ok: false, error: safeErrMsg(err) }));
          restarted = !!rr.ok;
          if (!restarted) {
            // Состояние уже сохранено, не удался только автоматический перезапуск:
            // сообщаем честно, чтобы пользователь не решил, что изменения применены
            return sendJson(res, 500, { ...r, restarted: false, error: 'Состояние плагина сохранено, но автоматический перезапуск DSH не удался: ' + (rr.error || 'неизвестная ошибка') });
          }
        }
        return sendJson(res, 200, { ...r, restarted, desktopMirrored });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/uninstall' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('Не указано имя плагина');
        const r = await pluginManager.uninstallPlugin(body.name);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('Не указано имя плагина');
        const r = await pluginManager.installPlugin(body.name);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    // 7. Сохранение конфигурации шлюза и системы с немедленным перезапуском
    if (subPath === '/api/config/save' && req.method === 'POST') {
      const body = await readJsonBody(req);

      const newPort = Number(body.proxyPort) || PROXY_PORT;
      if (newPort < 1 || newPort > 65535) {
        return sendJson(res, 400, { ok: false, error: 'Номер порта должен быть в диапазоне 1 ~ 65535' });
      }

      const newAdmin = normalizeRoutePath(body.adminPath, '/admin');
      const newVnc = normalizeRoutePath(body.vncPath, '/vnc');
      if (newAdmin === newVnc) {
        return sendJson(res, 400, { ok: false, error: 'Путь админки и путь VNC не должны совпадать' });
      }

      const newCdpPort = Number(body.cdpPort) || 9222;
      const enableCdp = body.enableCdp !== false;
      const newResolution = (body.resolution || '1440x900').trim();
      const parts = newResolution.split('x');
      const width = parseInt(parts[0]) || 1440;
      const height = parseInt(parts[1]) || 900;
      const idleTimeoutMinutes = body.idleTimeoutMinutes !== undefined ? Number(body.idleTimeoutMinutes) : 30;

      let updatedToken = getAuthToken();
      if (body.clearAuthToken === true) {
        updatedToken = '';
      } else if (body.authToken !== undefined && body.authToken !== '' && body.authToken !== '******') {
        updatedToken = String(body.authToken).trim();
      }
      // Проверка стойкости пароля: слабые пароли отклоняются (те же правила, что в мастере настройки)
      if (updatedToken && updatedToken !== getAuthToken() && isWeakPassword(updatedToken)) {
        return sendJson(res, 400, { ok: false, error: 'Пароль доступа слишком простой: минимум 6 символов и не используйте распространённые пароли вроде admin / password' });
      }

      const autoHealPlugins = body.autoHealPlugins !== false;
      const autoHealMaxPerBoot = Math.max(1, Math.min(50, Number(body.autoHealMaxPerBoot) || 5));
      dshManager.setAutoHeal(autoHealPlugins, autoHealMaxPerBoot);

      // Политика очистки «призрачных» bundle: после сохранения её прочитает и выполнит
      // скрипт сборки при СЛЕДУЮЩЕМ СТАРТЕ КОНТЕЙНЕРА
      const newPruneMode = normalizePruneMode(body.pruneStaleBundles);
      const newPruneExtra = normalizePruneExtra(body.pruneBundlesExtra);

      // Параметры рабочего стола берутся из текущих значений DesktopManager
      // (источник истины — страница «Браузер и управление рабочим столом»)
      const ds = desktopManager.getStatus();

      const newCfg = {
        proxyPort: newPort,
        adminPath: newAdmin,
        vncPath: newVnc,
        authToken: updatedToken,
        autoHealPlugins,
        autoHealMaxPerBoot,
        pruneStaleBundles: newPruneMode,
        pruneBundlesExtra: newPruneExtra,
        desktop: {
          // Параметры рабочего стола всегда берутся из текущих значений DesktopManager
          // (источник истины — страница Admin «Браузер и управление рабочим столом»);
          // при сохранении шлюз/системной конфигурации они не перезаписываются,
          // чтобы не появилась вторая точка записи.
          enabled: desktopManager.isEnabled(),
          width: ds.width,
          height: ds.height,
          enableCdp: ds.enableCdp,
          cdpPort: ds.cdpPort,
          idleTimeoutMinutes: ds.idleTimeoutMinutes,
          enableSidebarTab: ds.enableSidebarTab,
          screenshotQuality: ds.screenshotQuality,
          screenshotDir: ds.screenshotDir
        },
        savedAt: new Date().toISOString()
      };

      const saved = savePersistedConfig(newCfg);
      if (!saved) {
        return sendJson(res, 500, { ok: false, error: 'Не удалось записать файл сохранённой конфигурации' });
      }

      const logSafeCfg = {
        ...newCfg,
        authToken: newCfg.authToken ? '******' : ''
      };
      console.log('[gateway] Новая конфигурация из админки:', logSafeCfg);

      // Отправляем сведения о переходе на новый URL
      sendJson(res, 200, {
        ok: true,
        message: 'Конфигурация сохранена, служба шлюза перезапустится через 1 секунду и применит изменения...',
        newPort,
        newAdminPath: newAdmin,
        newVncPath: newVnc
      });

      // Отложенный перезапуск
      setTimeout(async () => {
        console.log('[gateway] Выполняется перезапуск для применения новой конфигурации шлюза...');
        // Сначала корректно останавливаем рабочий стол и ждём реального завершения процессов,
        // чтобы новый шлюз не наткнулся на ещё не завершённые старые процессы
        await desktopManager.stop();
        await dshManager.stop();
        process.exit(0);
      }, 800);

      return;
    }

    return sendJson(res, 404, { ok: false, error: 'Такого интерфейса не существует' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
  }
}

// ── Внутренний API управления рабочим столом (для локальных плагинов) ─────────
async function handleInternalDesktopApi(req, res, pathname) {
  try {
    const action = pathname.replace('/__internal/desktop/', '').trim();
    // Авторитетный путь VNC от шлюза, чтобы плагин построил корректный vncUrl
    // (не использует устаревшую локальную/патченую конфигурацию)
    if (action === 'status') return sendJson(res, 200, { ...desktopManager.getStatus(), vncPath: VNC_PATH_HREF });

    const body = await readJsonBody(req);
    // Внутренняя (loopback) авторитетная точка записи: для разовой миграции плагином
    // и для поддержания того же источника истины, что и в Admin
    if (action === 'config') {
      const r = applyDesktopConfigPatch(body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (action === 'master') {
      const r = await applyDesktopMaster(body?.enabled !== false);
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (action === 'start') {
      const r = await desktopManager.start(body);
      return sendJson(res, 200, r);
    }
    if (action === 'stop') {
      const r = await desktopManager.stop();
      return sendJson(res, 200, r);
    }
    if (action === 'restart') {
      const r = await desktopManager.restart(body);
      return sendJson(res, 200, r);
    }
    if (action === 'keepalive') {
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }
    return sendJson(res, 404, { ok: false, error: 'Неизвестное действие' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
  }
}

function handleAuthVerify(req, res) {
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: rateLimit.error }));
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 64) req.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const token = (data.token || '').trim();
      if (verifyToken(token)) {
        recordAuthAttempt(clientIp, true);
        setAuthCookie(res, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        recordAuthAttempt(clientIp, false);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Неверный код доступа, введите заново' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Некорректный формат данных запроса' }));
    }
  });
}

// Отправка мастера настройки: задание пароля доступа (только пока он «не задан»)
function handleSetupSubmit(req, res) {
  if (!isSetupRequired()) {
    return sendJson(res, 409, { ok: false, error: 'Пароль доступа уже задан; изменить его можно в админке' });
  }
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) return sendJson(res, 429, { ok: false, error: rateLimit.error });

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 64) req.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const pwd = typeof data.password === 'string' ? data.password : '';
      const confirm = typeof data.confirm === 'string' ? data.confirm : '';
      if (!pwd || !confirm) return sendJson(res, 400, { ok: false, error: 'Введите пароль и подтвердите его' });
      if (pwd !== confirm) return sendJson(res, 400, { ok: false, error: 'Введённые пароли не совпадают' });
      if (isWeakPassword(pwd)) return sendJson(res, 400, { ok: false, error: 'Пароль слишком простой: минимум 6 символов и не используйте распространённые простые пароли' });

      // Сливаем изменения, чтобы не затереть другие сохранённые поля (desktop, paths и т.д.)
      const cfg = loadPersistedConfig();
      cfg.authToken = pwd;
      cfg.savedAt = new Date().toISOString();
      if (!savePersistedConfig(cfg)) {
        return sendJson(res, 500, { ok: false, error: 'Не удалось сохранить пароль, проверьте права доступа к полу данных и повторите' });
      }
      updateAuthToken(pwd);
      recordAuthAttempt(clientIp, true);
      setAuthCookie(res);
      console.log('[gateway] Пароль доступа задан через мастер настройки');
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Некорректный формат данных запроса' });
    }
  });
}

/**
 * Проверка совпадения источника WebSocket (защита от CSWSH): реализация в ws-origin.js.
 * Ключевой момент: заголовок `x-forwarded-host` НИКОГДА не используется — клиент может
 * подделать его (или прокси пропустит его без изменений); достаточно выставить в нём
 * домен своей страницы, чтобы обойти проверку Origin.
 * Сейчас принимаются только «настоящий заголовок `host`» и явно настроенные внешние имена хостов.
 */
function isAllowedWsOrigin(req) {
  return wsOrigin.isAllowedWsOrigin(req, PUBLIC_HOSTS);
}

// ── Основной маршрутизатор HTTP-запросов ──────────────────────
async function handleHttpRequest(req, res) {
  const rawUrl = req.url || '/';
  const safePath = '/' + rawUrl.replace(/^\/+/, '');
  const parsedUrl = new URL(safePath, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  req.url = pathname + parsedUrl.search;

  // 1. Белый список общедоступных путей
  //    Пока пароль не задан, страница входа превращается в «мастер настройки»,
  //    а остальные запросы перенаправляются на /setup
  if (pathname === '/login') {
    if (isSetupRequired()) { res.writeHead(302, { Location: '/setup' }); return res.end(); }
    return serveStaticHtml(res, 'login.html');
  }
  if (pathname === '/__auth/verify' && req.method === 'POST') return handleAuthVerify(req, res);
  if (pathname === '/logout') {
    clearAuthCookie(res);
    res.writeHead(302, { Location: isSetupRequired() ? '/setup' : '/login' });
    return res.end();
  }
  if (pathname === '/setup' && req.method === 'GET') {
    // После задания пароля мастер настройки больше не показывается: иначе осталась бы
    // «зомби-форма», которая выглядит рабочей, но при отправке всегда падает
    if (!isSetupRequired()) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return serveStaticHtml(res, 'setup.html');
  }
  if (pathname === '/__auth/setup' && req.method === 'POST') return handleSetupSubmit(req, res);

  // Проверка состояния без аутентификации: для Docker HEALTHCHECK / балансировки нагрузки
  // (не раскрывает никаких чувствительных данных)
  if (pathname === '/healthz') {
    const ds = desktopManager.getStatus();
    const dsh = dshManager.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
      port: PROXY_PORT,
      authEnabled: isAuthEnabled(),
      setupRequired: isSetupRequired(),
      // M13: возвращаем «фактически действующее значение + источник», чтобы удобно искать
      // расхождения между .env / сохранённой конфигурацией / значением по умолчанию
      configSource: {
        port: PROXY_PORT_SOURCE,
        adminPath: ADMIN_PATH_SOURCE,
        vncPath: VNC_PATH_SOURCE,
        authToken: AUTH_TOKEN_SOURCE
      },
      adminPath: ADMIN_PATH,
      vncPath: VNC_PATH,
      dsh: { running: !!dsh.running, ready: !!dsh.ready },
      desktop: { enabled: !!ds.enabled, running: !!ds.running }
    }));
  }

  if (pathname === '/favicon.svg' || pathname === '/favicon.ico') {
    const staticFile = path.join(__dirname, 'public', pathname.slice(1));
    if (fs.existsSync(staticFile)) {
      res.writeHead(200, {
        'Content-Type': pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(staticFile).pipe(res);
    }
  }

  // 2. Внутренние интерфейсы по локальному петлевому адресу с общим секретом
  //    (для обмена между плагинами внутри контейнера)
  //    Одного факта «источник — петля» недостаточно: если шлюз стоит за обратным прокси,
  //    адрес пира внешнего запроса тоже будет 127.0.0.1.
  //    Поэтому дополнительно проверяется общий секрет (плагин читает
  //    /root/.dsh/.internal-api-token, см. internal-token.js).
  if (pathname.startsWith('/__internal/desktop/')) {
    const peer = wsOrigin.normalizeIp(req.socket && req.socket.remoteAddress);
    const isLoopbackReq = peer === '127.0.0.1' || peer === '::1';
    if (isLoopbackReq && verifyInternalToken(req)) {
      return handleInternalDesktopApi(req, res, pathname);
    }
    return sendJson(res, 403, { ok: false, error: 'Во внутренний интерфейс доступ запрещён (нужен петлевой источник + внутренний ключ)' });
  }

  // 3. Предохранитель настройки: пока пароль не задан, пропускаются только пути выше
  if (isSetupRequired()) {
    if (pathname.startsWith(ADMIN_PATH + '/api/') || pathname.startsWith('/__api/')) {
      return sendJson(res, 401, { ok: false, error: 'Пароль доступа ещё не задан: сначала откройте /setup и завершите настройку', setupRequired: true });
    }
    const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      res.writeHead(302, { Location: '/setup' });
      return res.end();
    }
    return sendJson(res, 401, { ok: false, error: 'Пароль доступа ещё не задан: сначала откройте /setup и завершите настройку', setupRequired: true });
  }

  if (PUBLIC_PATHS.has(pathname)) {
    await alignHeadersForDsh(req);
    return dshProxy.web(req, res);
  }

  // 3. Единая проверка аутентификации (при неудаче запрос перехватывается)
  if (!checkRequestAuth(req)) {
    const isHtmlNav = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
    if (isHtmlNav) {
      const redirectTarget = encodeURIComponent(req.url || '/');
      res.writeHead(302, { Location: '/login?redirect=' + redirectTarget });
      return res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'Доступ не авторизован, выполните вход' }));
    }
  }

  // 3.5 Стабильный интерфейс плагина рабочего стола (доступен после аутентификации,
  //     даёт базовый путь, не зависящий от ADMIN_PATH)
  if (pathname === '/__api/desktop/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      desktop: desktopManager.getStatus(),
      paths: { admin: ADMIN_PATH, vnc: VNC_PATH_HREF, proxyPort: PROXY_PORT }
    });
  }
  if (pathname === '/__api/desktop/start' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const r = await desktopManager.start(body);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // 4. Пользовательские маршруты админки (ADMIN_PATH)
  if (pathname === ADMIN_PATH || pathname === ADMIN_PATH + '/') {
    return serveStaticHtml(res, 'admin.html');
  }
  if (pathname.startsWith(ADMIN_PATH + '/api/')) {
    return handleAdminApi(req, res, pathname, parsedUrl.searchParams);
  }

  // 5. Пользовательские маршруты VNC (VNC_PATH)
  if (pathname === VNC_PATH || pathname.startsWith(VNC_PATH + '/')) {
    // Если браузер «полностью отключён» в админке либо отключён его плагин —
    // показываем понятную страницу вместо чёрного экрана noVNC
    if (!desktopManager.isEnabled() || isBrowserPluginDisabled()) {
      return serveDesktopDisabledPage(res);
    }
    // Автоподъём рабочего стола:
    //   используем «здоровье-ориентированный» getStatus().running, а не сыромой флаг this.running.
    //   Тогда даже если ключевые процессы вроде Xvfb/Chromium уже завершились (например,
    //   пользователь закрыл последнюю вкладку/окно браузера), открытие /vnc вместо «пустого
    //     рабочего стола» приведёт к самовосстановлению и перезапуску.
    if (!desktopManager.getStatus().running) {
      desktopManager.start().catch(() => {});
      // Рабочий стол ещё не готов: HTML-навигация сразу получает отдельную страницу
      // «запускается» (автообновление через 3 с), а не проброс на ещё не слушающий
      // websockify — это полностью устраняет 502 / голый JSON / чёрный экран.
      if (isHtmlNavigation(req)) {
        return serveDesktopStartingPage(res);
      }
    } else {
      desktopManager.touchActivity();
    }

    const novncRevision = process.env.NOVNC_ASSET_REVISION || '1.6.0';
    const versionedVncPath = `/novnc-${novncRevision}/vnc.html`;
    // Точка websockify должна отдаваться как АБСОЛЮТНЫЙ путь. noVNC в браузере разбирает
    // параметр path через `new URL(path, location.href)`; поскольку vnc.html лежит в
    // версионированном подкаталоге (/vnc/novnc-<rev>/vnc.html), относительный путь
    // "vnc/websockify" превратится в /vnc/novnc-<rev>/vnc/websockify (шлюз его не знает),
    // и WebSocket-хендшейк будет отклонён (1006) с сообщением "Failed to connect".
    const websockifyPath = `${VNC_PATH}/websockify`;

    // 5.1 Открытие корневого адреса рабочего стола (например /vnc или /vnc/) -> 302
    //     на версионированный vnc.html (с заголовками антикэша)
    if (pathname === VNC_PATH || pathname === VNC_PATH + '/') {
      res.writeHead(302, {
        Location: `${VNC_PATH}${versionedVncPath}?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      });
      return res.end();
    }

    // 5.2 Совместимость при прямом заходе на старый неверсионированный путь /vnc/vnc.html
    //     -> незаметный автоматический переход на актуальный версионированный путь
    if (pathname === `${VNC_PATH}/vnc.html`) {
      const search = parsedUrl.search || `?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`;
      res.writeHead(302, {
        Location: `${VNC_PATH}${versionedVncPath}${search}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      });
      return res.end();
    }

    // Переписываем префикс и отдаём в статический сервер noVNC
    req.url = req.url.slice(VNC_PATH.length) || '/';
    return vncProxy.web(req, res);
  }

  // 6. Проброс в основную службу DSH (/*)
  await alignHeadersForDsh(req);
  dshProxy.web(req, res);
}

// Страховка на уровне запроса: ошибка одного запроса влияет только на него
// и никогда не роняет весь процесс шлюза
function handleRequestCrash(err, req, res) {
  console.error('[gateway] Ошибка обработки HTTP-запроса:', (err && err.stack) || err);
  try {
    if (res && !res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Внутренняя ошибка шлюза' }));
    } else if (res && typeof res.end === 'function') {
      res.end();
    }
  } catch {}
}

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => handleRequestCrash(err, req, res));
});

// M15: таймаут на уровне запроса — не даём медленным запросам долго держать соединение
// (SSE / WebSocket на это не распространяется)
server.headersTimeout = 20000;
server.keepAliveTimeout = 15000;
server.requestTimeout = 600000; // допускает загрузку больших снимков, но остаётся конечным
// headersTimeout срабатывает при периодической проверке; интервал по умолчанию 30 с даёт
// «в худшем случае ждём ~50 с перед обрывом»; сжимаем до 5 с, чтобы медленные запросы
// обрывались вовремя (~20 с).
server.connectionsCheckingInterval = 5000;
// Дополнительно: headersTimeout в Node не действует на соединения, которые «подключились,
// но не отправили ни байта» (на практике 40 с — так и не оборвались), поэтому здесь
// явный сторож на уровне соединения: если за 20 с после установки не пришло данных —
// обрываем; как только данные начали идти, включается обычная система таймаутов.
server.on('connection', (socket) => {
  try {
    socket.setTimeout(20000, () => { try { socket.destroy(); } catch {} });
    socket.once('data', () => { try { socket.setTimeout(0); } catch {} });
  } catch {}
});

// ── Обработка WebSocket-хендшейка ──────────────────────────────
async function handleUpgrade(req, socket, head) {
  const rawUrl = req.url || '/';
  const safePath = '/' + rawUrl.replace(/^\/+/, '');
  const parsedUrl = new URL(safePath, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  req.url = pathname + parsedUrl.search;

  // 1. Проверка на межсайтовый CSWSH
  if (!isAllowedWsOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  // 2. Проверка аутентификации
  if (!checkRequestAuth(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }

  // 3. WebSocket-хендшейк VNC (совместимость с версионированными путями, относительными
  //    путями и пользовательским префиксом)
  const vncWsPath = VNC_PATH + '/websockify';
  // Мелочь: совпадаем строго с известной точкой websockify (раньше проверка endsWith('/websockify')
  // была излишне широкой: любой путь, заканчивающийся на /websockify, считался WS-прокси рабочего стола)
  if (pathname === vncWsPath || pathname === '/websockify') {
    // При полностью отключённом браузере (или отключённом плагине) WebSocket VNC
    // больше не проксируется (в согласовании со страницей-пояснением на /vnc)
    if (!desktopManager.isEnabled() || isBrowserPluginDisabled()) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    desktopManager.touchActivity();
    // Как и на /vnc: если ключевые процессы уже завершились (например, закрыли последнюю
    // вкладку, из-за чего остановился Chromium) — пользуемся этим WS-подключением для
    // самовосстановления, чтобы пользователь не завис на «пустом рабочем столе».
    if (!desktopManager.getStatus().running) desktopManager.start().catch(() => {});
    req.url = '/websockify' + (parsedUrl.search || '');
    return vncProxy.ws(req, socket, head);
  }

  // 4. WebSocket-хендшейк DSH (/events/mux, /events/host и т.д.)
  await alignHeadersForDsh(req);
  dshProxy.ws(req, socket, head);
}

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((err) => {
    console.error('[gateway] Ошибка обработки WebSocket-апгрейда:', (err && err.stack) || err);
    try { socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); } catch {}
  });
});

// ── Самозапуск службы и корректное завершение ──────────────────
async function bootstrap() {
  // Общий секрет внутренних интерфейсов: создаётся при запуске и сразу сохраняется на диск
  // (0600), чтобы плагин успел прочитать его до любого вызова инструмента
  try {
    const tokenPath = require('./internal-token').tokenFilePath();
    getInternalToken();
    console.log('[gateway] Ключ внутренних интерфейсов готов:', tokenPath);
  } catch (err) {
    console.warn('[gateway] Не удалось инициализировать ключ внутренних интерфейсов:', err.message);
  }

  server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  Шлюз запущен');
    console.log('  Порт прослушивания: 0.0.0.0:' + PROXY_PORT + ' (источник: ' + PROXY_PORT_SOURCE + ')');
    console.log('  Путь админки: ' + ADMIN_PATH + ' (источник: ' + ADMIN_PATH_SOURCE + ')  Путь рабочего стола: ' + VNC_PATH + ' (источник: ' + VNC_PATH_SOURCE + ')');
    console.log('  Источник пароля доступа: ' + AUTH_TOKEN_SOURCE);
    console.log('  Состояние аутентификации: ' + (isAuthEnabled() ? 'защита кодом доступа включена (AUTH_TOKEN)' : 'аутентификация выключена (прямой доступ)'));
    console.log('  DSH Web:  http://127.0.0.1:' + PROXY_PORT + '/');
    console.log('  Админ-панель: http://127.0.0.1:' + PROXY_PORT + ADMIN_PATH + '/');
    console.log('  Рабочий стол noVNC: http://127.0.0.1:' + PROXY_PORT + VNC_PATH + '/');
    console.log('==================================================');
  });

  // Файл конфигурации создаётся уже при первом запуске: «gateway.config.json = единственный
  // источник истины» должен существовать всегда (его читают плагины при старте)
  if (!fs.existsSync(CONFIG_FILE)) {
    const ds0 = desktopManager.getStatus();
    savePersistedConfig({
      proxyPort: PROXY_PORT,
      adminPath: ADMIN_PATH,
      vncPath: VNC_PATH,
      autoHealPlugins: autoHealEnabled,
      autoHealMaxPerBoot,
      pruneStaleBundles,
      pruneBundlesExtra,
      desktop: {
        enabled: ds0.enabled, width: ds0.width, height: ds0.height,
        enableCdp: ds0.enableCdp, cdpPort: ds0.cdpPort,
        idleTimeoutMinutes: ds0.idleTimeoutMinutes,
        enableSidebarTab: ds0.enableSidebarTab,
        screenshotQuality: ds0.screenshotQuality, screenshotDir: ds0.screenshotDir
      },
      savedAt: new Date().toISOString()
    });
    console.log('[gateway] Создан начальный файл конфигурации:', CONFIG_FILE);
  }

  // Запуск виртуального рабочего стола (с учётом «полного выключателя» админки и переменных
  // окружения; если где-то явно выключено — не запускаем)
  if (!desktopManager.isEnabled()) {
    console.log('[desktop-manager] Контейнерный браузер полностью отключён в админке, автозапуск при старте пропущен');
  } else if (isBrowserPluginDisabled()) {
    // Плагин явно отключён: по соглашению «плагин отключён → браузер недоступен»
    // рабочий стол автоматически не запускаем
    console.log('[desktop-manager] Плагин браузера отключён, автозапуск рабочего стола при старте пропущен');
  } else {
    await desktopManager.start().catch(err => console.error('[desktop-manager] Ошибка запуска:', err.message));
  }

  // Запуск ядра службы DSH
  await dshManager.boot().catch(err => console.error('[dsh-manager] Ошибка запуска:', err.message));

  // При самом первом запуске автоматически создаётся начальный снимок конфигурации
  // (повторное создание исключено)
  dshManager.ensureDefaultSnapshot();
}

async function shutdown(exitCode = 0) {
  const code = typeof exitCode === 'number' ? exitCode : 0;
  console.log('\n[gateway] Выходим, останавливаем рабочий стол и процессы DSH...');
  // Страховка: в любом случае завершаемся за 8 секунд, чтобы сам процесс остановки не завис
  const hardTimer = setTimeout(() => { console.error('[gateway] Превышено время завершения, завершаем принудительно'); process.exit(code); }, 8000);
  if (hardTimer.unref) hardTimer.unref();
  try { await desktopManager.stop(); } catch (e) { console.warn('[gateway] Ошибка при остановке рабочего стола (игнорируем):', e && e.message); }
  try { await dshManager.stop(); } catch (e) { console.warn('[gateway] Ошибка при остановке DSH (игнорируем):', e && e.message); }
  process.exit(code);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Необработанные отказы Promise: записываем в журнал, но НЕ завершаемся, чтобы сбой одной
// фоновой задачи не ронял единственный входной процесс
process.on('unhandledRejection', (reason) => {
  console.error('[gateway] Необработанный отказ Promise (процесс продолжает работу):', (reason && reason.stack) || reason);
});
// Нехваченные синхронные исключения: логируем и корректно выходим, передавая перезапуск
// демонизирующей петле entrypoint
process.on('uncaughtException', (err) => {
  console.error('[gateway] Нехваченное исключение, корректно завершаемся, чтобы перезапуск выполнил демон:', (err && err.stack) || err);
  shutdown(1).catch(() => process.exit(1));
});

bootstrap();
