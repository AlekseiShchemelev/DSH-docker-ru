window.__ModuleLoader__.load({
  id: '@dsh-custom/dsh-browser-desktop',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');

    const ru = typeof window !== 'undefined' && window.navigator && window.navigator.language.toLowerCase().startsWith('ru');
    const labels = {
      title: ru ? 'Контейнерный браузер' : 'Container Browser',
      description: ru ? 'Управление графическим браузером Chromium в контейнере, виртуальным разрешением, отладкой CDP и политикой сна по простою.' : 'Controls container Chromium browser, virtual resolution, CDP debugging, and idle sleep policy.',
      resolution: ru ? 'Разрешение виртуального рабочего стола' : 'Virtual Resolution',
      screenshotQuality: ru ? 'Качество скриншотов по умолчанию (ИИ)' : 'Default Screenshot Quality',
      idleTimeout: ru ? 'Сон по простою (минут)' : 'Idle Sleep Timeout (Minutes)',
      enableCdp: ru ? 'Удалённая отладка CDP' : 'CDP Remote Debugging',
      enableSidebarTab: ru ? 'Встраивать рабочий стол во вкладку правой боковой панели (экспериментально)' : 'Embed Desktop in Right Sidebar (Experimental)',
      enabled: ru ? 'Включить контейнерный браузер' : 'Enable Container Browser',
    };

    // ── Карточка только-чтения: авторитет конфигурации переехал на страницу Admin «Браузер и рабочий стол» ──────
    // Карточка лишь показывает текущее состояние и даёт переход, никаких полей записи конфигурации,
    // чтобы не появилась вторая точка записи рядом с Admin (устраняем множественность источников конфигурации).
    let desktopStatusData = null;
    let adminPath = '/admin';

    // Путь VNC изменяем: после смены пути в Admin уже отрендеренный iframe боковой панели обязан
    // пересоздаться, иначе он продолжит ходить на старый путь (будет «нужно вручную обновить страницу»).
    // Здесь — лёгкая шина событий для рассылки изменений в сочетании с событием storage из localStorage
    // для синхронизации между вкладками.
    const VNC_PATH_KEY = 'dsh_desktop_vnc_path';
    const VNC_PATH_EVENT = 'dsh-desktop-vnc-path-changed';

    function getStoredVncPath() {
      try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem(VNC_PATH_KEY)) || '/vnc';
      } catch (e) { return '/vnc'; }
    }

    function setStoredVncPath(p) {
      if (!p || typeof localStorage === 'undefined') return;
      try {
        if (localStorage.getItem(VNC_PATH_KEY) === p) return;
        localStorage.setItem(VNC_PATH_KEY, p);
        window.dispatchEvent(new CustomEvent(VNC_PATH_EVENT, { detail: p }));
      } catch (e) { /* Игнорируем исключения localStorage в приватном режиме и т.п. */ }
    }

    function subscribeVncPath(cb) {
      const onCustom = (e) => cb((e && e.detail) || getStoredVncPath());
      const onStorage = (e) => { if (!e || e.key === VNC_PATH_KEY) cb(getStoredVncPath()); };
      window.addEventListener(VNC_PATH_EVENT, onCustom);
      window.addEventListener('storage', onStorage);
      return () => {
        window.removeEventListener(VNC_PATH_EVENT, onCustom);
        window.removeEventListener('storage', onStorage);
      };
    }

    // P13: добавляем тайм-аут, чтобы при перезапуске шлюза запрос не завис
    async function loadDesktopStatus() {
      try {
        const r = await fetch('/__api/desktop/status', { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return null;
        const data = await r.json();
        desktopStatusData = data?.desktop || null;
        if (data?.paths?.admin) adminPath = data.paths.admin;
        if (data?.paths?.vnc) setStoredVncPath(data.paths.vnc);
        return data;
      } catch (e) { return null; }
    }

    // P13: специально для поллинга — если предыдущий запрос ещё не завершился, этот пропускаем
    // (защита от накопления запросов и перепутанного порядка состояний)
    let desktopPollInFlight = false;
    function pollDesktopStatus() {
      if (desktopPollInFlight) return Promise.resolve(null);
      desktopPollInFlight = true;
      return loadDesktopStatus().finally(() => { desktopPollInFlight = false; });
    }

    function desktopStateText(d) {
      if (!d) return ru ? 'неизвестно' : 'Unknown';
      if (d.enabled === false) return ru ? 'полностью отключён' : 'Disabled';
      return d.running ? (ru ? 'работает' : 'Running') : (ru ? 'остановлен / спит' : 'Stopped');
    }

    function BrowserDesktopCard(props = {}) {
      const isSection = !!props.isSection;
      const [open, setOpen] = React.useState(isSection ? true : false);
      const [status, setStatus] = React.useState(desktopStatusData);
      const [vncBase, setVncBase] = React.useState(getStoredVncPath());

      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          // Сбой/пропущенный поллинг держит прежнее состояние, чтобы карточка не мигала "--" во время перезапуска шлюза
          pollDesktopStatus().then(d => { if (alive && d) setStatus(d); });
        };
        tick();
        const t = setInterval(tick, 8000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      // После смены пути VNC (изменён в Admin) ссылка перехода в карточке обновляется за ним
      React.useEffect(() => subscribeVncPath(setVncBase), []);

      const d = status?.desktop || null;
      const rows = [
        [labels.enabled, desktopStateText(d), d && d.enabled === false ? '#ef4444' : (d && d.running ? '#22c55e' : null)],
        [labels.resolution, d ? `${d.width} x ${d.height}` : '--'],
        [labels.idleTimeout, d ? (d.idleTimeoutMinutes === 0 ? (ru ? 'всегда' : 'Always on') : `${d.idleTimeoutMinutes} ${ru ? 'мин' : 'min'}`) : '--'],
        [labels.enableCdp, d ? (d.enableCdp ? `${ru ? 'включён' : 'On'} (:${d.cdpPort})` : (ru ? 'выключен' : 'Off')) : '--'],
        [labels.screenshotQuality, d ? String(d.screenshotQuality || 'high') : '--'],
        [labels.enableSidebarTab, d ? (d.enableSidebarTab ? (ru ? 'включено' : 'On') : (ru ? 'выключено' : 'Off')) : '--']
      ];

      const body = React.createElement(
        'div',
        { style: { display: 'grid', gap: '9px' } },
        React.createElement('p', {
          style: { margin: '0 0 2px', fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary, #64748b)' }
        }, ru
          ? 'Чтобы не плодить несколько точек записи одной и той же конфигурации, этот плагин больше не даёт дублирующих настроек: разрешение / сон по простою / CDP / значения скриншотов по умолчанию / вкладка боковой панели целиком управляются на странице Admin «Браузер и рабочий стол» (единственный авторитет) и сохраняются мгновенно.'
          : 'To keep a single source of truth, this plugin no longer duplicates configuration: resolution, idle timeout, CDP, screenshot defaults and the sidebar tab are managed solely in the Admin "Browser & Desktop" page.'),
        ...rows.map(([k, v, color]) => React.createElement(
          'div',
          { key: k, style: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' } },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #64748b)' } }, k),
          React.createElement('strong', { style: { color: color || 'var(--dsw-alias-label-primary, #0f172a)' } }, v)
        )),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '4px' } },
          React.createElement('a', {
            href: `${adminPath}/`,
            target: '_blank',
            rel: 'noreferrer',
            style: { fontSize: '13px', color: 'var(--dsw-alias-link, #4176e6)', textDecoration: 'none' }
          }, ru ? 'Настроить в Admin ↗' : 'Configure in Admin ↗'),
          React.createElement('a', {
            href: `${vncBase.replace(/\/+$/, '')}/`,
            target: '_blank',
            rel: 'noreferrer',
            style: { fontSize: '13px', color: 'var(--dsw-alias-link, #4176e6)', textDecoration: 'none' }
          }, ru ? 'Открыть рабочий стол в новом окне ↗' : 'Open desktop ↗')
        )
      );

      // P16: всё переведено на собственные пространства имён + инлайн-стили, приватные имена классов
      // апстрима (вроде .YyYd_a_card) больше не используются — переименуй апстрим, и наша карточка
      // потеряет стиль; инлайн-стили же работают под любой версией DSH.
      const cardStyle = isSection ? {
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        border: '1px solid var(--dsw-alias-border-l3, #e2e8f0)',
        borderRadius: '12px',
        padding: '20px 24px',
        listStyle: 'none'
      } : {
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        border: '1px solid var(--dsw-alias-border-l3, #e2e8f0)',
        borderRadius: '10px',
        margin: '6px 0',
        overflow: 'hidden',
        listStyle: 'none'
      };

      return React.createElement(
        isSection ? 'div' : 'li',
        { className: isSection ? 'dsbd-section-card' : 'dsbd-card', style: cardStyle },
        !isSection ? React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsbd-card-header',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: '10px', width: '100%', padding: '12px 14px',
              background: 'transparent', border: 'none', cursor: 'pointer',
              textAlign: 'left', font: 'inherit',
              color: 'var(--dsw-alias-label-primary, #0f172a)'
            }
          },
          React.createElement(
            'span',
            { className: 'dsbd-card-head-text', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            React.createElement('span', { className: 'dsbd-card-name', style: { fontSize: '13.5px', fontWeight: 700 } }, labels.title),
            React.createElement('span', { className: 'dsbd-card-desc', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #64748b)' } }, labels.description)
          ),
          React.createElement(
            'svg',
            {
              className: 'dsbd-card-chevron',
              width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none',
              stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round',
              style: { flexShrink: 0, transition: 'transform .15s ease', transform: open ? 'rotate(180deg)' : 'none' }
            },
            React.createElement('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25' })
          )
        ) : null,
        open ? React.createElement(
          'div',
          { className: 'dsbd-card-body', style: isSection ? { padding: 0, marginTop: 0 } : { padding: '0 14px 14px' } },
          body
        ) : null
      );
    }

    // Инжектим стили правой боковой панели:
    // 1) защита ширины Tab (чтобы текст не обрезался кнопкой закрытия)
    // 2) расцветка верхней панели рабочего стола — только реальные тематические токены DSH
    //    (--dsw-alias-*), достаточная контрастность в светлой/тёмной темах. Внимание:
    //    · токенов --dsw-alias-bg-subtle / --dsw-alias-fg-muted не существует, их использование
    //      упадёт в тёмный fallback и в светлой теме даст скрытую проблему «тёмная полоса + тёмный/почти чёрный текст»;
    //    · --dsw-alias-brand-primary — это «контрастный чёрно-белый» (светлая #0f1115 / тёмная #f9fafb),
    //      а не фирменный синий, в качестве цвета ссылки его брать нельзя; для ссылок нужен --dsw-alias-link.
    if (typeof document !== 'undefined') {
      const STYLE_ID = 'dsh-browser-desktop-tab-css';
      // P16: больше не используем селектор :has и приватные классы апстрима (сменит имя апстрим/старый
      // браузер не поддержит селектор — всё сломается).
      // Ширина Tab и защита от обрезки выполняются инлайн-стилями из useLayoutEffect в VncDesktopTabTitle.
      const CSS = `
        .dshDesktopBar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
          padding: 6px 12px;
          font-size: 12px;
          background: var(--dsw-alias-bg-layer-2, #252526);
          border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.3));
          color: var(--dsw-alias-label-secondary, #a1a1aa);
        }
        .dshDesktopBarTitle {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-weight: 500;
          color: var(--dsw-alias-label-primary, #e5e5e5);
        }
        .dshDesktopBarActions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .dshDesktopBarBtn {
          padding: 0;
          border: none;
          background: none;
          font: inherit;
          cursor: pointer;
          color: var(--dsw-alias-label-secondary, #a1a1aa);
        }
        .dshDesktopBarBtn:hover {
          color: var(--dsw-alias-label-primary, #e5e5e5);
        }
        .dshDesktopBarBtn:focus-visible {
          outline: 1px solid var(--dsw-alias-link, #4176e6);
          outline-offset: 2px;
          border-radius: 3px;
        }
        .dshDesktopBarLink {
          color: var(--dsw-alias-link, #4176e6);
          text-decoration: none;
        }
        .dshDesktopBarLink:hover {
          text-decoration: underline;
        }
        .dshDesktopBarLink:focus-visible {
          outline: 1px solid var(--dsw-alias-link, #4176e6);
          outline-offset: 2px;
          border-radius: 3px;
        }
      `;
      let styleEl = document.getElementById(STYLE_ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        document.head.appendChild(styleEl);
      }
      // При изменении содержимого обновляем синхронно, чтобы при hot-update/повторном выполнении не оставался старый стиль
      if (styleEl.textContent !== CSS) styleEl.textContent = CSS;
    }

    // Компонент заголовка вкладки правой боковой панели (изящная 14-пиксельная векторная иконка монитора + идеальная защита от обрезки)
    function VncDesktopTabTitle() {
      const titleRef = React.useRef(null);

      React.useLayoutEffect(() => {
        const el = titleRef.current;
        if (!el) return;
        // P16: напрямую пишем инлайн-стили в контейнер вкладки апстрима (не полагаясь на селектор :has)
        const chip = el.closest('[data-dockkit-tab], [data-dockkit-float-grip]');
        if (chip) {
          chip.style.minWidth = '125px';
          chip.style.overflow = 'visible';
        }
      }, []);

      return React.createElement(
        'span',
        {
          ref: titleRef,
          'data-dsh-desktop-tab-title': 'true',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            whiteSpace: 'nowrap',
            fontSize: '13px',
            lineHeight: '1',
            flexShrink: 0
          }
        },
        React.createElement('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { flexShrink: 0, opacity: 0.85 }
        },
          React.createElement('rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }),
          React.createElement('line', { x1: '8', y1: '21', x2: '16', y2: '21' }),
          React.createElement('line', { x1: '12', y1: '17', x2: '12', y2: '21' })
        ),
        React.createElement('span', { style: { whiteSpace: 'nowrap' } }, ru ? 'Контейнерный рабочий стол' : 'Desktop')
      );
    }

    // Компонент встроенного VNC-контейнера правой боковой панели (рендерится, когда переключатель
    // включён и окружение апстрима поддерживает SidebarRight)
    function VncDesktopSidebarPane() {
      // Подписка на путь VNC: после смены в Admin без обновления страницы iframe автоматически
      // пересоздаётся на новом адресе
      const [storedVncPath, setVncPath] = React.useState(getStoredVncPath());
      React.useEffect(() => subscribeVncPath(setVncPath), []);
      const vncUrl = `${storedVncPath.replace(/\/+$/, '')}/?autoconnect=1&resize=scale`;
      const [reloadKey, setReloadKey] = React.useState(1);

      return React.createElement(
        'div',
        {
          style: {
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: '#181818',
            position: 'relative',
            overflow: 'hidden'
          }
        },
        React.createElement(
          'div',
          { className: 'dshDesktopBar' },
          React.createElement(
            'span',
            { className: 'dshDesktopBarTitle' },
            '🖥️',
            ru ? 'Рабочий стол Chromium' : 'Chromium Container Desktop'
          ),
          React.createElement(
            'div',
            { className: 'dshDesktopBarActions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshDesktopBarBtn',
                onClick: () => setReloadKey(k => k + 1)
              },
              ru ? 'Обновить изображение' : 'Refresh'
            ),
            React.createElement(
              'a',
              {
                href: `${storedVncPath.replace(/\/+$/, '')}/`,
                target: '_blank',
                rel: 'noreferrer',
                className: 'dshDesktopBarLink'
              },
              (ru ? 'Полный экран в новом окне' : 'Open in Tab') + ' ↗'
            )
          )
        ),
        React.createElement('iframe', {
          key: reloadKey,
          src: vncUrl,
          style: {
            flex: 1,
            width: '100%',
            height: '100%',
            border: 'none',
            background: '#000'
          }
        })
      );
    }

    function BrowserDesktopSection() {
      return React.createElement(
        'div',
        { style: { padding: '24px 28px', maxWidth: '820px' } },
        React.createElement('div', { style: { marginBottom: '20px', borderBottom: '1px solid var(--dsw-alias-border-l3, #e2e8f0)', paddingBottom: '14px' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
            React.createElement('h2', { style: { fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--dsw-alias-label-primary, #0f172a)', display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', null, '🖥️'),
              labels.title
            ),
            React.createElement('span', {
              style: {
                fontSize: '12px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: '12px',
                background: 'var(--dsw-alias-state-business-tertiary, #e0f2fe)',
                color: 'var(--dsw-alias-state-business-primary, #0284c7)'
              }
            }, ru ? 'Встроенный компонент контейнерного набора' : 'Builtin Suite Component')
          ),
          React.createElement('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #64748b)', margin: 0, lineHeight: 1.5 } }, labels.description)
        ),
        React.createElement(BrowserDesktopCard, { isSection: true })
      );
    }

    function apply(ctx) {
      // Авторитет конфигурации переехал на страницу Admin «Браузер и рабочий стол»:
      // клиент больше не читает и не пишет пространство имён настроек DSH.
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        // 1. Современный стандарт DSH (>= 0.1.5 / 0.1.6): регистрируем «контейнерный браузер»
        // как самостоятельную секцию первого класса в центре настроек (settings.section)
        // — та же парадигма регистрации, что у dshmarket и dsh-thinking-effort
        ctx.slots.inject('settings.section', () => {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'browser-desktop',
            order: 45,
            label: () => (ru ? 'Контейнерный браузер' : 'Container Browser')
          }, BrowserDesktopSection);
        });

        // =========================================================================
        // [Совместимость со старыми DSH (<= 0.1.4 / 0.1.5) — историческая поддержка вниз]
        // Старые DSH грузят конфигурационные карточки плагинов в меню «Настройки -> Плагины»
        // через слот settings.plugin.item.
        // Когда поддержку старых DSH полностью уберут, весь блок ниже можно смело удалить:
        // =========================================================================
        ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            key: 'browser-desktop',
            order: 80
          }, BrowserDesktopCard);
        });

        // =========================================================================
        // [Конец совместимости со старыми DSH]
        // =========================================================================

        // 2. Вкладка правой боковой панели: авторитет исходит из шлюза (включатель «Вкладка рабочего
        //    стола в правой боковой панели» на странице Admin «Браузер и рабочий стол»)
        const injectSidebarTab = (scopedCtx) => {
          window.__DSH_SIDEBAR_RIGHT__ = scopedCtx.sidebarRight;
          window.__DSH_OPEN_SIDEBAR_TAB__ = (kind) => {
            try {
              if (typeof scopedCtx.sidebarRight?.openTab === 'function') {
                scopedCtx.sidebarRight.openTab({ kind });
              }
            } catch (err) {
              console.warn('[dsh-browser-desktop] Сбой вызова вкладки правой боковой панели:', err);
            }
          };
          // P13: возвращается функция очистки — Cordis вызывает её при инвалидации зависимостей/выгрузке
          // плагина, чтобы убрать глобальные ключи; иначе после выгрузки на window останутся ссылки
          // на уже уничтоженный ctx.
          const cleanupGlobals = () => {
            try { delete window.__DSH_SIDEBAR_RIGHT__; } catch {}
            try { delete window.__DSH_OPEN_SIDEBAR_TAB__; } catch {}
          };
              const DESKTOP_ID = '@dsh-custom/dsh-browser-desktop';
              const DESKTOP_KIND = 'vnc-desktop';

              try {
                scopedCtx.sidebarRightTabs?.register?.({
                  id: DESKTOP_ID,
                  kind: DESKTOP_KIND,
                  priority: 'extension',
                  title: () => (ru ? 'Контейнерный рабочий стол' : 'Container Desktop'),
                  guide: [{
                    order: 20,
                    title: () => (ru ? 'Контейнерный браузер рабочий стол' : 'Container Desktop'),
                    description: () => (ru ? 'Открыть встроенный браузер Chromium и живой рабочий стол noVNC (с отладкой CDP)' : 'Open Chromium browser & noVNC desktop')
                  }]
                });
              } catch (e) {
                console.warn('[dsh-browser-desktop] Предупреждение регистрации вкладки боковой панели:', e.message);
              }

              for (const key of [DESKTOP_ID, DESKTOP_KIND]) {
                scopedCtx.slots.inject('sidebar.right.pane.tab.title', () => {
                  return scopedCtx.slots.register({
                    name: 'sidebar.right.pane.tab.title',
                    key: key
                  }, VncDesktopTabTitle);
                });

                scopedCtx.slots.inject('sidebar.right.pane.tab', () => {
                  return scopedCtx.slots.register({
                    name: 'sidebar.right.pane.tab',
                    key: key
                  }, VncDesktopSidebarPane);
                });
              }
          return cleanupGlobals;
        };
        if (typeof ctx.inject === 'function') {
          loadDesktopStatus()
            .then((data) => {
              if (!data?.desktop?.enableSidebarTab) return;
              try {
                ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scopedCtx) => injectSidebarTab(scopedCtx));
              } catch (err) {
                console.warn('[dsh-browser-desktop] Сбой условного внедрения зависимостей правой боковой панели (мягкая деградация):', err.message);
              }
            })
            .catch(() => {});
        }
      }
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots'];
    return module.exports;
  }
});
