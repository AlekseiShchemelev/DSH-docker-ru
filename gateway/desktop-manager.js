const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class DesktopManager {
  constructor() {
    this.running = false;
    this.unhealthy = false;
    this.startedAt = null;
    this.expiresAt = null;
    this.lastActivity = Date.now();
    this.processes = {
      xvfb: null,
      openbox: null,
      x11vnc: null,
      websockify: null,
      chromium: null
    };

    this.config = {
      display: process.env.DISPLAY || ':99',
      // «Главный переключатель» панели управления: по умолчанию определяется переменной окружения,
      // панель управления может перезаписать его и сохранить
      enabled: process.env.DSH_DESKTOP_ENABLED !== '0',
      width: Number(process.env.DSH_DESKTOP_WIDTH) || 1920,
      height: Number(process.env.DSH_DESKTOP_HEIGHT) || 1080,
      depth: Number(process.env.DSH_DESKTOP_DEPTH) || 24,
      idleTimeoutMinutes: Number(process.env.DSH_IDLE_TIMEOUT_MINUTES) || 30, // 0 = disabled
      enableCdp: process.env.DSH_ENABLE_CDP !== '0',
      cdpPort: Number(process.env.DSH_CDP_PORT) || 9222,
      enableSidebarTab: process.env.DSH_ENABLE_SIDEBAR_TAB === '1' || false,
      // Разрешение по умолчанию для скриншотов (настраивается на странице Admin «Браузер и рабочий стол», плагин читает через status)
      screenshotQuality: process.env.DSH_SCREENSHOT_QUALITY || 'high',
      screenshotDir: process.env.DSH_SCREENSHOT_DIR || '',
      userDataDir: process.env.CHROME_USER_DATA_DIR || '/root/.config/chromium',
      logsDir: '/tmp/dsh-desktop'
    };

    fs.mkdirSync(this.config.logsDir, { recursive: true });
    fs.mkdirSync(this.config.userDataDir, { recursive: true });

    // Start background idle watchdog
    this.watchdogTimer = setInterval(() => this.checkIdleWatchdog(), 15000);
    this.watchdogTimer.unref();
    // Последовательная очередь операций жизненного цикла: start/stop/restart выполняются по очереди,
    // чтобы взаимные await не приводили к дедлоку ожидания самого себя
    this._opChain = Promise.resolve();
  }

  touchActivity(durationMinutes) {
    this.lastActivity = Date.now();
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      this.expiresAt = Date.now() + durationMinutes * 60 * 1000;
      console.log(`[desktop-manager] Время работы браузера задано: ${durationMinutes} мин, ожидаемое завершение: ${new Date(this.expiresAt).toLocaleTimeString()}`);
    } else if (durationMinutes === 0) {
      // Явный 0 = отмена лимита времени работы (старая реализация сохраняла старый expiresAt,
      // из-за чего после «отмены» браузер всё равно останавливался автоматически)
      this.expiresAt = null;
      console.log('[desktop-manager] Лимит времени работы браузера снят (автоостановка по таймеру больше не произойдёт)');
    }
  }

  checkIdleWatchdog() {
    if (!this.running) return;
    const now = Date.now();

    // 1. Проверка срока, заданного AI
    if (this.expiresAt && now >= this.expiresAt) {
      console.log('[desktop-manager] Время работы браузера истекло, автоматическая остановка для экономии ресурсов');
      this.stop().catch((e) => console.warn('[desktop-manager] Ошибка автоостановки по сроку:', e.message));
      return;
    }

    // 2. Проверка тайм-аута простоя
    if (this.config.idleTimeoutMinutes > 0) {
      const idleMs = now - this.lastActivity;
      if (idleMs >= this.config.idleTimeoutMinutes * 60 * 1000) {
        console.log(`[desktop-manager] Браузер простаивает более ${this.config.idleTimeoutMinutes} мин, автоматический сон`);
        this.stop().catch((e) => console.warn('[desktop-manager] Ошибка автосна по простою:', e.message));
      }
    }
  }

  // ── Сериализация жизненного цикла ──────────────────────────────────────────
  // Операции жизненного цикла сериализуются: предыдущая, успешно или нет, не блокирует следующие
  _enqueue(task) {
    const run = this._opChain.then(task, task);
    this._opChain = run.then(() => {}, () => {});
    return run;
  }

  start(options = {}) {
    return this._enqueue(() => this._startInternal(options));
  }

  stop() {
    return this._enqueue(() => this._stopInternal());
  }

  restart(options = {}) {
    return this._enqueue(async () => {
      await this._stopInternal();
      await sleep(300);
      return this._startInternal(options);
    });
  }

  async _startInternal(options = {}) {
    // При полностью отключённом «главном переключателе» в Admin отказываем во всех запусках
    // (перекрывает инструменты ИИ, автопробуждение VNC, загрузку через bootstrap и т.д.)
    if (this.config.enabled === false) {
      console.log('[desktop-manager] Контейнерный браузер полностью отключён панелью управления, запрос запуска отклонён');
      return { ok: false, disabled: true, error: 'Контейнерный браузер полностью отключён в панели управления', status: this.getStatus() };
    }

    // Запрос запуска может нести runtime-конфигурацию (разрешение / флаг и порт CDP),
    // сводим её к единой авторитетной конфигурации
    const reqWidth = options.width ? Number(options.width) : null;
    const reqHeight = options.height ? Number(options.height) : null;
    const reqCdp = typeof options.enableCdp === 'boolean' ? options.enableCdp : null;
    const reqCdpPort = Number(options.cdpPort) ? Number(options.cdpPort) : null;

    if (this.running) {
      // Уже запущен: сначала проверяем реальную «живость», чтобы флаг «запущен» при мёртвом процессе
      // не замыкал запуск накоротко
      const healthy = await this.isHealthy();
      if (healthy) {
        const resChanged = (reqWidth && reqWidth !== this.config.width) ||
                           (reqHeight && reqHeight !== this.config.height);
        const cdpChanged = (reqCdp !== null && reqCdp !== this.config.enableCdp) ||
                           (reqCdpPort !== null && reqCdpPort !== this.config.cdpPort);
        if (resChanged || cdpChanged) {
          console.log(`[desktop-manager] Получено изменение runtime-конфигурации (разрешение/CDP), применяем заново...`);
          // Напрямую вызываем внутренние методы, ни в коем случае не публичные start/stop/restart,
          // чтобы не создать дедлок ожидания себя в очереди
          await this._stopInternal();
          return this._startInternal(options);
        }
        if (typeof options.idleTimeoutMinutes === 'number') {
          this.config.idleTimeoutMinutes = options.idleTimeoutMinutes;
        }
        this.touchActivity(options.durationMinutes);
        return { ok: true, alreadyRunning: true, status: this.getStatus() };
      }
      console.warn('[desktop-manager] Обнаружен нездоровый процесс рабочего стола (критичный процесс завершился), выполняем перезапуск с самовосстановлением...');
      await this._stopInternal();
    }

    // Применяем runtime-конфигурацию из текущего запуска
    this.updateConfig({
      ...(reqWidth ? { width: reqWidth } : {}),
      ...(reqHeight ? { height: reqHeight } : {}),
      ...(reqCdp !== null ? { enableCdp: reqCdp } : {}),
      ...(reqCdpPort !== null ? { cdpPort: reqCdpPort } : {})
    });

    const width = reqWidth || this.config.width;
    const height = reqHeight || this.config.height;
    this.config.width = width;
    this.config.height = height;
    if (typeof options.idleTimeoutMinutes === 'number') {
      this.config.idleTimeoutMinutes = options.idleTimeoutMinutes;
    }
    const durationMinutes = options.durationMinutes;

    console.log(`[desktop-manager] Запуск виртуального рабочего стола (разрешение: ${width}x${height}, CDP: ${this.config.enableCdp ? this.config.cdpPort : 'выключен'})...`);

    // Очистка перед запуском: освобождаем устаревший X-display, чистим X-lock, ждём освобождения портов
    // (чтобы быстрый перезапуск не конкурировал сам с собой)
    await this._prepareEnvironment();

    // Clean chromium lock files
    try {
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonCookie'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonLock'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonSocket'), { force: true });
    } catch {}

    // 1. Запуск Xvfb
    this._spawnTracked('xvfb', 'Xvfb', [
      this.config.display,
      '-screen', '0', `${width}x${height}x${this.config.depth}`,
      '-ac', '-nolisten', 'tcp'
    ], { logFile: 'xvfb.log' });

    // Wait for X display to become ready
    let displayReady = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const xvfb = this.processes.xvfb;
      if (!xvfb || xvfb.exitCode !== null) {
        console.error('[desktop-manager] Процесс Xvfb завершился раньше времени');
        break;
      }
      if (await this._displayAlive()) {
        displayReady = true;
        break;
      }
    }

    if (!displayReady) {
      console.error('[desktop-manager] Запуск дисплейного сервиса Xvfb не удался или превышен тайм-аут');
      await this._stopInternal();
      return { ok: false, error: 'Запуск виртуального дисплейного сервиса Xvfb не удался' };
    }

    const env = { ...process.env, DISPLAY: this.config.display };

    // 2. Запуск Openbox
    this._spawnTracked('openbox', 'openbox', [], { env, logFile: 'openbox.log' });

    // 3. Запуск x11vnc
    this._spawnTracked('x11vnc', 'x11vnc', [
      '-display', this.config.display,
      '-forever', '-shared', '-repeat', '-noxdamage',
      '-rfbport', '5900', '-localhost', '-nopw'
    ], { env, logFile: 'x11vnc.log' });

    // 4. Запуск websockify (noVNC-веб на /usr/share/novnc)
    const vncPort = Number(process.env.VNC_PORT) || 6080;
    this._spawnTracked('websockify', 'websockify', [
      '--web=/usr/share/novnc',
      `127.0.0.1:${vncPort}`,
      '127.0.0.1:5900'
    ], { logFile: 'novnc.log' });

    // 5. Запуск Chromium
    const chromeArgs = [
      `--user-data-dir=${this.config.userDataDir}`,
      '--window-position=0,0',
      `--window-size=${width},${height}`,
      'about:blank'
    ];
    if (this.config.enableCdp) {
      chromeArgs.push(
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${this.config.cdpPort}`
      );
    }
    this._spawnTracked('chromium', 'chromium-docker', chromeArgs, { env, logFile: 'chromium.log' });

    this.running = true;
    this.unhealthy = false;
    this.startedAt = Date.now();
    this.touchActivity(durationMinutes);

    console.log('[desktop-manager] Виртуальный рабочий стол и Chromium запущены успешно');
    return { ok: true, status: this.getStatus() };
  }

  async _stopInternal() {
    const hasTracked = Object.values(this.processes).some(Boolean);
    if (!this.running && !hasTracked) {
      return { ok: true, alreadyStopped: true };
    }

    console.log('[desktop-manager] Останавливаем браузер и все процессы рабочего стола...');
    // Сначала сбрасываем состояние, чтобы колбэк выхода дочернего процесса не принял
    // корректную остановку за аварийный краш
    this.running = false;
    this.unhealthy = false;

    await this.killTrackedProcesses();
    await this.forceCleanupSystemProcesses();

    this.startedAt = null;
    this.expiresAt = null;

    // Ждём реального освобождения дисплея, чтобы тут же следующий запуск не наткнулся на не ушедший старый X server
    await this._waitDisplayGone(3000);
    return { ok: true, status: this.getStatus() };
  }

  // ── Управление процессами ────────────────────────────────────────────────
  _spawnTracked(name, cmd, args, { env, logFile } = {}) {
    let fd = null;
    let stdio = 'ignore';
    if (logFile) {
      fd = fs.openSync(path.join(this.config.logsDir, logFile), 'a');
      stdio = ['ignore', fd, fd];
    }
    // detached: отдельная группа процессов, чтобы за раз собрать все дочерние процессы Chromium
    const proc = spawn(cmd, args, { env, stdio, detached: true });
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    proc.on('exit', (code, signal) => this._onChildExit(name, code, signal));
    proc.on('error', (err) => this._onChildError(name, err));
    this.processes[name] = proc;
    return proc;
  }

  _onChildExit(name, code, signal) {
    const wasRunning = this.running;
    console.warn(`[desktop-manager] Дочерний процесс ${name} завершился (code=${code}, signal=${signal})`);
    if (this.processes[name]) this.processes[name] = null;
    if (!wasRunning) return;
    if (name === 'xvfb' || name === 'chromium') {
      this.unhealthy = true;
      console.error(`[desktop-manager] Критичный процесс ${name} завершился аварийно, рабочий стол помечен нездоровым — самовосстановление при следующем запуске`);
    }
  }

  _onChildError(name, err) {
    console.error(`[desktop-manager] Ошибка запуска дочернего процесса ${name}: ${err.message}`);
    if (this.processes[name]) this.processes[name] = null;
    if (this.running && (name === 'xvfb' || name === 'chromium')) this.unhealthy = true;
  }

  // Сбор дескрипторов процессов, порождённых и отслеживаемых этим менеджером (сначала SIGTERM, при тайм-ауте SIGKILL)
  async killTrackedProcesses() {
    const entries = Object.entries(this.processes).filter(([, p]) => p);
    await Promise.all(entries.map(([name, proc]) => this._terminate(name, proc)));
    for (const [name] of entries) this.processes[name] = null;
  }

  _terminate(name, proc) {
    return new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      proc.once('exit', done);

      const signal = (sig) => {
        try {
          if (proc.pid) process.kill(-proc.pid, sig); // собираем всю группу
          else proc.kill(sig);
        } catch {
          try { proc.kill(sig); } catch {}
        }
      };

      signal('SIGTERM');
      const t1 = setTimeout(() => { signal('SIGKILL'); setTimeout(done, 300); }, 2500);
      const t2 = setTimeout(done, 4500);
      if (t1.unref) t1.unref();
      if (t2.unref) t2.unref();
    });
  }

  // Запасная очистка возможно оставшихся системных процессов (чтобы порт/дисплей не занимали осиротевшие процессы)
  async forceCleanupSystemProcesses() {
    // Незначительный момент: отказываемся от слишком широкого `pkill -f chromium`
    // (им можно зацепить чужой Chromium в контейнере, например headless-инстанс от
    // скрипта скриншотов панели управления), матчим только признаки именно этого рабочего стола.
    const patterns = [
      `Xvfb ${this.config.display}`,
      `--user-data-dir=${this.config.userDataDir}`, // Chromium (только каталог данных этого рабочего стола)
      'x11vnc',
      'websockify'
    ];
    await Promise.all(patterns.map(p => this._pkill(p)));
  }

  _pkill(pattern) {
    return new Promise((resolve) => {
      let p;
      try { p = spawn('pkill', ['-f', pattern]); } catch { return resolve(); }
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  // ── Проверка живости и ожидание ресурсов ──────────────────────────────────────
  async isHealthy() {
    if (!this.running || this.unhealthy) return false;
    const xvfb = this.processes.xvfb;
    if (!xvfb || xvfb.exitCode !== null) return false;
    if (!(await this._displayAlive())) return false;
    const chrome = this.processes.chromium;
    if (!chrome || chrome.exitCode !== null) return false;
    // Примечание: порт CDP здесь не проверяем. CDP в первые мгновения после подъёма Chromium
    // может ещё не слушать; включение его в критерий живости заставит только что запущенный
    // рабочий стол считаться «нездоровым» и перезапустит его целиком, потеряв открытые вкладки.
    // Доступность CDP при необходимости проверяет вызывающая сторона (плагин browser_open/screenshot).
    return true;
  }

  _displayAlive() {
    return new Promise((resolve) => {
      let p;
      try { p = spawn('xdpyinfo', ['-display', this.config.display], { stdio: 'ignore' }); }
      catch { return resolve(false); }
      p.on('close', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
  }

  async _waitDisplayGone(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!(await this._displayAlive())) return true;
      await sleep(250);
    }
    return !(await this._displayAlive());
  }

  _displayNumber() {
    return String(this.config.display).replace(/^:/, '').split('.')[0];
  }

  _xLockPath() {
    return `/tmp/.X${this._displayNumber()}-lock`;
  }

  async _ensureCleanDisplay() {
    if (await this._displayAlive()) {
      console.warn(`[desktop-manager] Обнаружено, что дисплей ${this.config.display} занят устаревшим процессом, очищаем...`);
      await this._pkill(`Xvfb ${this.config.display}`);
      await this._waitDisplayGone(5000);
    }
    // Чистим возможные остатки X-lock файлов (иначе Xvfb откажет запуск с ошибкой "Server is already active")
    try { fs.rmSync(this._xLockPath(), { force: true }); } catch {}
  }

  _managedPorts() {
    const ports = [5900, Number(process.env.VNC_PORT) || 6080];
    if (this.config.enableCdp) ports.push(this.config.cdpPort);
    return ports;
  }

  _portFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      try { srv.listen(port, '127.0.0.1'); } catch { resolve(false); }
    });
  }

  async _waitPortsFree(ports, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      const busy = [];
      for (const p of ports) {
        if (!(await this._portFree(p))) busy.push(p);
      }
      if (!busy.length) return true;
      if (Date.now() >= deadline) {
        console.warn(`[desktop-manager] Порт всё ещё занят: ${busy.join(', ')}`);
        return false;
      }
      await sleep(300);
    }
  }

  async _prepareEnvironment() {
    await this._ensureCleanDisplay();
    await this._waitPortsFree(this._managedPorts(), 6000);
  }

  getStatus() {
    const now = Date.now();
    let remainingMinutes = null;
    if (this.expiresAt && this.expiresAt > now) {
      remainingMinutes = Math.max(0, Math.ceil((this.expiresAt - now) / 60000));
    }

    const alive = this.running && !this.unhealthy;
    return {
      enabled: this.isEnabled(),
      running: alive,
      healthy: alive,
      unhealthy: this.unhealthy,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.floor((now - this.startedAt) / 1000) : 0,
      expiresAt: this.expiresAt,
      remainingMinutes,
      width: this.config.width,
      height: this.config.height,
      enableCdp: this.config.enableCdp,
      cdpPort: this.config.cdpPort,
      idleTimeoutMinutes: this.config.idleTimeoutMinutes,
      enableSidebarTab: !!this.config.enableSidebarTab,
      screenshotQuality: this.config.screenshotQuality,
      screenshotDir: this.config.screenshotDir,
      idleSeconds: this.running ? Math.floor((now - this.lastActivity) / 1000) : 0
    };
  }

  updateConfig(patch = {}) {
    if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled;
    if (typeof patch.width === 'number') this.config.width = patch.width;
    if (typeof patch.height === 'number') this.config.height = patch.height;
    if (typeof patch.idleTimeoutMinutes === 'number') this.config.idleTimeoutMinutes = patch.idleTimeoutMinutes;
    if (typeof patch.enableCdp === 'boolean') this.config.enableCdp = patch.enableCdp;
    if (typeof patch.cdpPort === 'number') this.config.cdpPort = patch.cdpPort;
    if (typeof patch.enableSidebarTab === 'boolean') this.config.enableSidebarTab = patch.enableSidebarTab;
    if (typeof patch.screenshotQuality === 'string') this.config.screenshotQuality = patch.screenshotQuality;
    if (typeof patch.screenshotDir === 'string') this.config.screenshotDir = patch.screenshotDir;
    return this.config;
  }

  // Только для «главного переключателя» панели управления: здесь единственное место,
  // где можно перевернуть глобальный выключатель (горячее обновление от плагина его не меняет)
  isEnabled() {
    return this.config.enabled !== false;
  }

  setEnabled(enabled) {
    const next = enabled !== false;
    if (this.config.enabled === next) return this.config.enabled;
    this.config.enabled = next;
    console.log(`[desktop-manager] Глобальный выключатель контейнерного браузера: ${next ? 'включён' : 'полностью отключён'}`);
    return this.config.enabled;
  }

  // Применение runtime-патча конфигурации (вход горячего обновления вроде keepalive), возвращает фактически изменившиеся поля
  applyConfig(patch = {}) {
    // Глобальный выключатель монопольно принадлежит панели управления: keepalive плагина его не трогает
    const safe = { ...patch };
    delete safe.enabled;
    const keys = ['width', 'height', 'idleTimeoutMinutes', 'enableCdp', 'cdpPort', 'enableSidebarTab', 'screenshotQuality', 'screenshotDir'];
    const before = {};
    for (const k of keys) before[k] = this.config[k];
    this.updateConfig(safe);
    const changed = {};
    for (const k of keys) {
      if (before[k] !== this.config[k]) changed[k] = this.config[k];
    }
    if (Object.keys(changed).length) {
      console.log('[desktop-manager] Runtime-конфигурация обновлена:', JSON.stringify(changed));
    }
    // Изменения разрешения / CDP требуют перезапуска рабочего стола, чтобы вступить в силу
    const restartKeys = ['width', 'height', 'enableCdp', 'cdpPort'];
    if (this.running && Object.keys(changed).some(k => restartKeys.includes(k))) {
      console.log('[desktop-manager] Изменение runtime-конфигурации требует перезапуска рабочего стола, перезапускаем асинхронно...');
      this.restart({ width: this.config.width, height: this.config.height })
        .catch(err => console.error('[desktop-manager] Ошибка перезапуска из-за изменения конфигурации:', err.message));
    }
    return changed;
  }
}

const instance = new DesktopManager();
module.exports = instance;
