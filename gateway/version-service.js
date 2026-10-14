const fs = require('fs');
const path = require('path');

function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
}

/**
 * Строгая проверка semver (принимается только 1.2.3 / v1.2.3 / 1.2.3-rc.1).
 * parseSemver молча сводит недопустимые значения к 0.0.0; если сравнить напрямую,
 * один «кривой» номер версии с удалённого сервера даст «ложное обнаружение новой версии»,
 * поэтому перед сравнением обе стороны обязаны пройти проверку isSemver.
 */
function isSemver(v) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(v ?? '').trim());
}

function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  if (p1.patch !== p2.patch) return p1.patch - p2.patch;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;
  return p1.pre.localeCompare(p2.pre);
}

/**
 * Сопоставление с единственным semver-выражением (`>=` / `>` / `<=` / `<` / `=` / голый номер версии).
 * Поддерживаются также **составные AND-диапазоны через пробел** (семантика npm semver), например
 * `">=0.1.2-rc.1 <=0.1.7-rc.2"` разбивается на два term и вычисляется по AND.
 *
 * До исправления: `p.slice(2).trim()` передавал остаток `">=0.1.2-rc.1 <=0.1.7-rc.2"`
 * в parseSemver как номер версии, тот молча сводил её к `0.1.2`, и `0.2.0` (должен жёстко блокироваться)
 * ошибочно засчитывался как попадание в диапазон (возврат true вместо false).
 */
function matchSemverPattern(ver, pattern) {
  if (!ver || !pattern) return false;
  const p = String(pattern).trim();
  if (!p) return false;

  // Составной диапазон: пробел = AND (поддержка нескольких пробелов / Tab / переноса строки). По term — И.
  // Один term в эту ветку не попадает, поэтому рекурсивного рассинхрона нет.
  const terms = p.split(/\s+/).filter(Boolean);
  if (terms.length > 1) {
    return terms.every((term) => matchSemverPattern(ver, term));
  }

  if (p.startsWith('>=')) return compareSemver(ver, p.slice(2).trim()) >= 0;
  if (p.startsWith('>')) return compareSemver(ver, p.slice(1).trim()) > 0;
  if (p.startsWith('<=')) return compareSemver(ver, p.slice(2).trim()) <= 0;
  if (p.startsWith('<')) return compareSemver(ver, p.slice(1).trim()) < 0;
  if (p.startsWith('=')) return compareSemver(ver, p.slice(1).trim()) === 0;
  return compareSemver(ver, p) === 0;
}

/**
 * Вычисление составного диапазона (пробел = AND). Поля вроде `supportedDshRange`
 * из `version.json` должны проверяться именно здесь, а не голым matchSemverPattern:
 * перед вычислением диапазона стоит защита isSemver, чтобы недопустимый номер версии
 * не был молча сведён parseSemver к 0.0.0 и не дал ложного результата.
 *
 * @param {string} version проверяемая версия, например '0.1.7-rc.2'
 * @param {string} range   диапазон, например '>=0.1.2-rc.1 <=0.1.7-rc.2'
 * @returns {boolean} попадает ли версия во **все** ограничения диапазона
 */
function satisfiesRange(version, range) {
  if (!isSemver(version) || !range) return false;
  const terms = String(range).trim().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => matchSemverPattern(version, term));
}

class VersionService {
  constructor() {
    this.cacheTTL = 10 * 60 * 1000; // кэш на 10 минут
    this.cachedMeta = null;
    this.lastFetched = 0;
    this.inFlightFetch = null;
    this._isRemoteMeta = false;
  }

  getLiveMeta() {
    return this.cachedMeta || this.getLocalMeta();
  }

  isUsingRemoteMeta() {
    return Boolean(this._isRemoteMeta && this.cachedMeta);
  }

  getLocalProjectVersion() {
    try {
      const pkgPath = path.join(__dirname, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version) return pkg.version;
      }
    } catch (e) {
      console.warn('[version-service] Ошибка чтения версии локального package.json:', e.message);
    }
    return '0.2.3';
  }

  getLocalMeta() {
    const candidatePaths = [
      path.join(__dirname, '../version.json'),
      path.join(__dirname, 'version.json'),
      '/app/version.json',
      '/workspace/deepseek-harness-docker/version.json'
    ];
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      } catch (e) {
        console.warn(`[version-service] Ошибка чтения локальных метаданных версии (${p}):`, e.message);
      }
    }
    return {
      project: 'deepseek-harness-docker',
      repo: {
        projectUrl: 'https://github.com/misaka-link/deepseek-harness-docker',
        projectReleases: 'https://github.com/misaka-link/deepseek-harness-docker/releases',
        upstreamRepo: 'https://github.com/deepseek-ai/deepseek-harness',
        upstreamReleases: 'https://github.com/deepseek-ai/deepseek-harness/releases',
        upstreamNpm: 'https://www.npmjs.com/package/@deepseek-ai/dsh'
      },
      latest: {
        version: this.getLocalProjectVersion(),
        releaseDate: '2026-09-21',
        releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases/tag/v0.1.4',
        changelog: 'Единый авторитет конфигурации Admin, рефакторинг жизненного цикла рабочего стола, усиление безопасности и контейнерной инженерии, адаптация мобильных устройств',
        changelogList: [
          'Утверждена модель конфигурации «Admin — единственный авторитет»: переключатель рабочего стола/разрешение/сон/CDP/качество скриншотов и т.д. единообразно сохраняются панелью управления и применяются мгновенно',
          'Переработано управление жизненным циклом виртуального рабочего стола: устранены гонки/взаимные блокировки, добавлены корректная остановка и сбор процессов, усилена способность к самовосстановлению при сбоях',
          'Добавлен мастер инициализации кода доступа администратора (/setup), отменён слабый пароль по умолчанию и усилено безопасное хранение',
          'Усиление безопасности контейнера: поддержка запуска от non-root пользователя (dsh:1001), по умолчанию сняты лишние привилегии (cap_drop ALL)',
          'Простая адаптация под мобильные устройства',
          'Оптимизация журнала консоли: добавлен переключатель автопрокрутки, улучшена производительность отрисовки, плавнее просмотр истории логов',
          'Исправлена проблема, когда предустановленные и плагины сообщества не загружались при определённой конфигурации запуска',
          'Предустановленные плагины следят за последней версией, цепочка поставок фиксирует основное ядро, усилены проверка целостности и урезание контекста сборки'
        ]
      },
      history: {
        '0.1.2': {
          version: '0.1.2',
          releaseDate: '2026-09-18',
          releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases/tag/v0.1.2'
        },
        '0.1.1': {
          version: '0.1.1',
          releaseDate: '2026-09-15',
          releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases/tag/v0.1.1'
        }
      },
      compatibility: {
        recommendedDsh: '0.2.1-alpha.2',
        supportedDshRange: '>=0.1.2-rc.1 <=0.2.1-alpha.2',
        adaptedVersions: ['0.2.1-alpha.2', '0.2.1-alpha.1', '0.2.0-rc.2', '0.2.0-rc.1', '0.1.7-rc.2', '0.1.7-rc.1', '0.1.7-alpha.2', '0.1.7-alpha.1', '0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.2-rc.1'],
        rules: [
          {
            pattern: '<0.1.5-rc.1',
            level: 'warning',
            title: 'Риск формата при даунгрейде',
            message: 'Официально с 0.1.5-rc.1 введена новая структура хранения сессий; даунгрейд до версий ниже 0.1.5 может привести к ошибкам разбора новых сессий.'
          },
          {
            pattern: '<0.1.7-alpha.1',
            level: 'warning',
            title: 'Риск даунгрейда формата сессий V4',
            message: 'Официально с 0.1.7 журнал сессий обновлён до V4, миграция односторонняя. После даунгрейда до 0.1.6 и ниже невозможно прочитать сессии, созданные или перенесённые в 0.1.7; для отката восстанавливайте вместе со снимком тома данных.'
          },
          {
            pattern: '>=0.3.0',
            level: 'danger',
            title: 'Крупная переработка нижележащего протокола · больше не совместимо с онлайн-переключением',
            message: 'Целевая версия перешла в следующий раунд разрушительного рефакторинга официальной версии (0.3.0 и выше). В этой линейке могут измениться нижележащий RPC и система авторизации соединений; текущий базовый образ контейнера не гарантирует успешного «горячего» онлайн-переключения. Ни в коем случае не переключайтесь онлайн принудительно — заново вытяните свежий Docker-образ и разверните!',
            action: 'force-docker-pull'
          }
        ]
      }
    };
  }

  async fetchRemoteMeta(force = false) {
    const now = Date.now();
    if (!force && this.cachedMeta && (now - this.lastFetched < this.cacheTTL)) {
      return this.cachedMeta;
    }

    if (this.inFlightFetch) {
      return this.inFlightFetch;
    }

    if (force) {
      // При принудительном обновлении асинхронно сбрасываем кэш jsDelivr
      try {
        fetch('https://purge.jsdelivr.net/gh/misaka-link/deepseek-harness-docker@main/version.json').catch(() => {});
      } catch {}
    }

    this.inFlightFetch = (async () => {
      const ts = Date.now();
      // Стратегия деградации по нескольким каналам: живой GitHub Raw -> зеркало ghproxy -> CDN jsDelivr
      const endpoints = [
        `https://raw.githubusercontent.com/misaka-link/deepseek-harness-docker/main/version.json?_=${ts}`,
        `https://ghproxy.net/https://raw.githubusercontent.com/misaka-link/deepseek-harness-docker/main/version.json?_=${ts}`,
        'https://fastly.jsdelivr.net/gh/misaka-link/deepseek-harness-docker@main/version.json',
        'https://cdn.jsdelivr.net/gh/misaka-link/deepseek-harness-docker@main/version.json'
      ];

      const local = this.getLocalMeta();

      for (const url of endpoints) {
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
          if (resp.ok) {
            const data = await resp.json();
            if (data && data.project && data.latest && data.latest.version) {
              // Защита от грязного кэша CDN: если версия с удалённого сервера старше известной локальной,
              // считаем это историческим кэшем CDN, пропускаем канал и пробуем следующий
              if (compareSemver(data.latest.version, local.latest?.version || '0.0.0') < 0) {
                console.warn(`[version-service] Канал ${url} вернул устаревшую версию (v${data.latest.version} < известной локальной v${local.latest?.version}), пропускаем этот канал`);
                continue;
              }

              if (!data.latest.changelogList && local.latest?.changelogList) {
                data.latest.changelogList = local.latest.changelogList;
              }
              if (!data.latest.dshChangelogList && local.latest?.dshChangelogList) {
                data.latest.dshChangelogList = local.latest.dshChangelogList;
              }
              if (!data.history && local.history) {
                data.history = local.history;
              }
              this.cachedMeta = data;
              this.lastFetched = Date.now();
              this._isRemoteMeta = true;
              return data;
            }
          }
        } catch (e) {
          // При сбое деградируем на следующий канал
        }
      }

      // Если ни один удалённый канал не доступен, элегантно возвращаемся к локальным метаданным
      this.cachedMeta = local;
      this.lastFetched = Date.now();
      this._isRemoteMeta = false;
      return local;
    })().finally(() => {
      this.inFlightFetch = null;
    });

    return this.inFlightFetch;
  }

  evaluateTargetVersion(targetVersion, meta = null) {
    const m = meta || this.getLiveMeta();
    const rules = m.compatibility?.rules || [];
    const adapted = m.compatibility?.adaptedVersions || [
      '0.2.1-alpha.2',
      '0.2.1-alpha.1',
      '0.2.0-rc.2',
      '0.2.0-rc.1',
      '0.1.7-rc.2',
      '0.1.7-rc.1',
      '0.1.7-alpha.2',
      '0.1.7-alpha.1',
      '0.1.6-alpha.2',
      '0.1.6-alpha.1',
      '0.1.5-rc.2',
      '0.1.5-rc.1',
      '0.1.2-rc.1'
    ];

    const isAdapted = adapted.includes(targetVersion);

    // Сортировка правил-совпадений по приоритету (от высокого риска к низкому, чтобы danger-правила всегда срабатывали первыми)
    const severityWeights = { danger: 3, warning: 2, info: 1 };
    const sortedRules = [...rules].sort((a, b) => (severityWeights[b.level] || 0) - (severityWeights[a.level] || 0));
    for (const rule of sortedRules) {
      if (matchSemverPattern(targetVersion, rule.pattern)) {
        return {
          level: rule.level || 'warning',
          title: rule.title || 'Уведомление о совместимости версии',
          message: rule.message || '',
          action: rule.action || '',
          isAdapted
        };
      }
    }

    if (!isAdapted) {
      return {
        level: 'warning',
        title: 'Версия без специальной адаптации',
        message: `Целевая версия v${targetVersion} ещё не включена в официальный список глубокой адаптации; при переключении обратите внимание на официальные заметки об изменениях.`,
        action: '',
        isAdapted: false
      };
    }

    return {
      level: 'success',
      title: 'Официальная глубокая адаптация',
      message: `Целевая версия v${targetVersion} официально глубоко адаптирована, базовый образ текущего Docker-контейнера полностью совместим, обновление контейнера не требуется — можно переключаться онлайн.`,
      action: 'online-switch',
      isAdapted: true
    };
  }

  async check(force = false, dshManager = null) {
    const meta = await this.fetchRemoteMeta(force);
    const currentProjectVer = this.getLocalProjectVersion();
    const latestProjectVer = meta.latest?.version || currentProjectVer;
    const hasProjectUpdate = isSemver(latestProjectVer) && isSemver(currentProjectVer)
      && compareSemver(latestProjectVer, currentProjectVer) > 0;

    let projectLevel = 'success';
    if (hasProjectUpdate) {
      projectLevel = 'info';
    }

    // Оценка состояния DSH
    let currentDshVer = 'unknown';
    let latestDshVer = '';
    let isDshAdapted = false;
    let dshLevel = 'success';
    let dshNotice = null;

    if (dshManager) {
      try {
        currentDshVer = dshManager.getCurrentVersion();
        const dshData = await dshManager.fetchAvailableVersions(false, meta);
        latestDshVer = dshData.latest || '';
        const hasDshUpdate = Boolean(latestDshVer && isSemver(latestDshVer) && isSemver(currentDshVer)
          && compareSemver(latestDshVer, currentDshVer) > 0);
        
        const evalRes = this.evaluateTargetVersion(currentDshVer, meta);
        isDshAdapted = evalRes.isAdapted;

        if (evalRes.level === 'danger') {
          dshLevel = 'danger';
          dshNotice = evalRes;
        } else if (evalRes.level === 'warning') {
          dshLevel = 'warning';
          dshNotice = evalRes;
        } else if (hasDshUpdate) {
          dshLevel = 'info';
          dshNotice = {
            level: 'info',
            title: 'Найдена новая официальная версия DSH',
            message: `Официально выпущена новая версия v${latestDshVer}, текущая установленная — v${currentDshVer}.`
          };
        }
      } catch (err) {
        // Больше не глотаем исключения молча: сбой оценки версии DSH должен оставлять след
        // (безопасная деградация до «без уведомления об обновлении»)
        console.warn('[version-service] Ошибка оценки версии DSH (снижено до уведомления об отсутствии обновления):', err.message);
      }
    }

    // Итоговое определение общего уровня безопасности
    let overallLevel = 'success';
    if (projectLevel === 'danger' || dshLevel === 'danger') {
      overallLevel = 'danger';
    } else if (projectLevel === 'warning' || dshLevel === 'warning') {
      overallLevel = 'warning';
    } else if (projectLevel === 'info' || dshLevel === 'info') {
      overallLevel = 'info';
    }

    // В зависимости от наличия новой версии динамически готовим нужное описание и список изменений
    const currentHist = meta.history?.[currentProjectVer];
    const updateTitle = hasProjectUpdate
      ? `Содержимое обновления (v${latestProjectVer})`
      : `Содержимое версии (v${currentProjectVer})`;
    const activeReleaseDate = (hasProjectUpdate ? meta.latest?.releaseDate : (currentHist?.releaseDate || meta.latest?.releaseDate)) || '';
    const activeReleaseUrl = (hasProjectUpdate ? meta.latest?.releaseUrl : (currentHist?.releaseUrl || meta.latest?.releaseUrl)) || meta.repo?.projectReleases || 'https://github.com/misaka-link/deepseek-harness-docker/releases';
    const activeChangelog = (hasProjectUpdate ? meta.latest?.changelog : (currentHist?.changelog || meta.latest?.changelog)) || '';
    const activeChangelogList = (hasProjectUpdate ? meta.latest?.changelogList : (currentHist?.changelogList || meta.latest?.changelogList)) || [activeChangelog || 'Оптимизация функций и усиление безопасности'];

    return {
      ok: true,
      project: {
        current: currentProjectVer,
        latest: latestProjectVer,
        hasUpdate: hasProjectUpdate,
        level: projectLevel,
        updateTitle,
        releaseDate: activeReleaseDate,
        releaseUrl: activeReleaseUrl,
        changelog: activeChangelog,
        changelogList: activeChangelogList,
        projectUrl: meta.repo?.projectUrl || 'https://github.com/misaka-link/deepseek-harness-docker',
        projectReleases: meta.repo?.projectReleases || 'https://github.com/misaka-link/deepseek-harness-docker/releases'
      },
      dsh: {
        current: currentDshVer,
        latest: latestDshVer,
        hasUpdate: Boolean(latestDshVer && compareSemver(latestDshVer, currentDshVer) > 0),
        isAdapted: isDshAdapted,
        level: dshLevel,
        notice: dshNotice,
        changelogList: meta.latest?.dshChangelogList || [
          'Новая страница «Управление плагинами» в веб-боковой панели: динамическое включение/отключение профильных плагинов и их горячие установка/удаление',
          'Новая нативная WASM-превью высокого качества для офисных документов (.docx / .xlsx / .pptx) в правой боковой панели',
          'Новая карточка ревью изменений файлов раунда сессии и построчное сравнение кода во вкладке Review',
          'Поддержка браузера песочницы в правой боковой панели (ui-sidebar-browser) и предпросмотр потока сессии',
          'Выравнивание с последней поддержкой моделей DeepSeek-V41-Flash и DeepSeek-V4-Pro'
        ],
        upstreamRepo: meta.repo?.upstreamRepo || 'https://github.com/deepseek-ai/deepseek-harness',
        upstreamReleases: meta.repo?.upstreamReleases || 'https://github.com/deepseek-ai/deepseek-harness/releases',
        upstreamNpm: meta.repo?.upstreamNpm || 'https://www.npmjs.com/package/@deepseek-ai/dsh'
      },
      compatibility: meta.compatibility || {},
      overallLevel,
      timestamp: Date.now()
    };
  }
}

const versionService = new VersionService();

// ── Экспорт ────────────────────────────────────────────────────────────────
// Обратная совместимость: по умолчанию экспортируется синглтон VersionService,
//   const versionService = require('./version-service');
//   versionService.getLiveMeta() / .check() / .evaluateTargetVersion() / ...
// всё остаётся на 100% рабочим.
// Параллельно чистые функции навешиваются на синглтон для деструктуризации во внешних модулях:
//   const { satisfiesRange, compareSemver } = require('./version-service');
versionService.parseSemver = parseSemver;
versionService.isSemver = isSemver;
versionService.compareSemver = compareSemver;
versionService.matchSemverPattern = matchSemverPattern;
versionService.satisfiesRange = satisfiesRange;

module.exports = versionService;
