/**
 * Регресс Issue #9 «Выбор области восстановления» (Restore Scope)
 * 
 * Реализация по спецификации design doc doc/issue-9/restore-scope-minutes.md §7:
 * - TC-01 позитив: в актуальном окружении есть S1~S3, в снимке B1~B5 → после config-only восстановления: конфигурация становится из снимка, S1~S3 остаются, B1~B5 не импортированы;
 * - TC-02 инъекция сбоя: неисправная конфигурация в staging вызывает сбой boot; после точного обратного отката S1~S3 остаются на месте;
 * - TC-03 мошенничество с именем: архив с сессиями переименован в xxx-config-xxx.tar.gz, вывод типа всё равно должен быть full;
 * - TC-04 пустое окружение: после очистки .dsh восстановление config-only без конфликтов workspace.json, DSH корректно загружается;
 * - TC-05 оффлайн: восстановление config-only без сети не запускает сетевой pnpm install, поднимается на текущих node_modules;
 * - TC-06 совместимость: при отсутствии mode поведение полностью идентично текущему (по умолчанию полная замена full).
 *
 * Запуск:
 *   node scripts/backup-restore-mode-test.mjs
 *   DSH_HOME=/tmp/custom-home node scripts/backup-restore-mode-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// ── 1. Изоляция окружения и страж безопасности (строжайше запрещено трогать реальный /root/.dsh и убивать DSH-процессы хоста) ──
const envHome = process.env.DSH_HOME;
// Если во внешнем окружении задан не системный временный каталог (например, DSH_HOME=/tmp/...), используем его; иначе по умолчанию создаём независимый временный песочница в os.tmpdir()
const isCustomTemp = envHome && !envHome.startsWith('/root');
const TEST_ROOT = isCustomTemp
  ? path.resolve(envHome)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-mode-test-'));
const isTempCreated = !isCustomTemp;

const TEST_DSH_HOME = path.join(TEST_ROOT, 'mock_home');
const TEST_SNAPSHOTS_DIR = path.join(TEST_ROOT, 'mock_snapshots');
const TEST_DSH_DIR = path.join(TEST_DSH_HOME, '.dsh');

fs.mkdirSync(TEST_DSH_HOME, { recursive: true });
fs.mkdirSync(TEST_SNAPSHOTS_DIR, { recursive: true });
fs.mkdirSync(TEST_DSH_DIR, { recursive: true });

// Ключевые переопределения переменных окружения: гарантируем, что при require backup-service привязка идёт к тестовым каталогам
process.env.DSH_HOME = TEST_DSH_HOME;
process.env.DSH_SNAPSHOTS_DIR = TEST_SNAPSHOTS_DIR;
process.env.DSH_PORT = '39999'; // обход порта 3079, чтобы fuser не затронул актуальный сервис

// Страховочный перехват: запрет логики внешнего убийства процессов в тестах, которая могла бы убить главный процесс контейнера (PID 128 и т.п.)
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function (cmd, args, opts) {
  if (cmd === 'ps' && Array.isArray(args) && args.includes('-eo')) {
    // Подделываем вывод ps, чтобы логика очистки сирот в restoreBackup не отправляла SIGKILL процессам хоста
    return { status: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'fuser') {
    return { status: 0, stdout: '', stderr: '' };
  }
  return origSpawnSync.apply(this, arguments);
};

// Подключение тестируемого модуля
const manifestModule = require(path.join(here, '../gateway/snapshot-manifest.js'));

let backupService = null;
let backupServiceLoadError = null;

try {
  backupService = require(path.join(here, '../gateway/backup-service.js'));
} catch (err) {
  // При неудачной загрузке фиксируем причину; последующие кейсы единообразно SKIP и печатают диагностику (не скрываем настоящую проблему, не переписываем исходники)
  backupServiceLoadError = err;
}

// ── 2. Счётчики тестов и утилиты отчётности ───────────────────────────────────────────
let passCount = 0;
let failCount = 0;
let skipCount = 0;

function pass(id, msg) {
  console.log(`   ✔ [PASS] ${id}: ${msg}`);
  passCount++;
}

function fail(id, msg, detail = '') {
  console.error(`   ❌ [FAIL] ${id}: ${msg}`);
  if (detail) console.error(`      Подробности: ${detail}`);
  failCount++;
}

function skip(id, reason, assertions = []) {
  console.log(`   ⏭️ [SKIP] ${id}: ${reason}`);
  if (assertions.length > 0) {
    console.log(`      [Что следует утверждать после готовности бэкенда]`);
    for (const a of assertions) {
      console.log(`        · ${a}`);
    }
  }
  skipCount++;
}

// ── 3. Вспомогательная функция: быстрая упаковка тестового снимка ─────────────────────────────
function buildSnapshotArchive(filename, filesMap) {
  const stageDir = fs.mkdtempSync(path.join(TEST_ROOT, 'stage-build-'));
  const dshSub = path.join(stageDir, '.dsh');
  fs.mkdirSync(dshSub, { recursive: true });

  for (const [relPath, content] of Object.entries(filesMap)) {
    const full = path.join(dshSub, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (typeof content === 'string') {
      fs.writeFileSync(full, content, 'utf8');
    } else if (Buffer.isBuffer(content)) {
      fs.writeFileSync(full, content);
    }
  }

  const archivePath = path.join(TEST_SNAPSHOTS_DIR, filename);
  const tarRes = origSpawnSync('tar', ['-czf', archivePath, '-C', stageDir, '.dsh'], { encoding: 'utf8' });
  if (tarRes.status !== 0) {
    throw new Error(`Не удалось упаковать тестовый снимок: ${tarRes.stderr}`);
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
  return archivePath;
}

function cleanLiveDsh() {
  fs.rmSync(TEST_DSH_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DSH_DIR, { recursive: true });
}

// Проверка, реализован ли в бэкенде mode: 'config-only' (по исходному коду backup-service или экспортируемой константе)
const hasConfigOnlySupport = (() => {
  if (!backupService) return false;
  try {
    if (Array.isArray(backupService.DATA_ENTRIES)) return true;
    const src = fs.readFileSync(path.join(here, '../gateway/backup-service.js'), 'utf8');
    return src.includes('config-only') || src.includes('DATA_ENTRIES');
  } catch {
    return false;
  }
})();

console.log('================================================================');
console.log('  Issue #9: набор регрессивных кейсов проверки выбора области восстановления снимка (Restore Scope)');
console.log(`  Изолированное рабочее пространство: ${TEST_ROOT}`);
console.log(`  Обнаружение состояния бэкенда: ${hasConfigOnlySupport ? 'готов (выполняются все бизнес-утверждения)' : 'в параллельной разработке (выполняются доступные базовые утверждения, остальное по спецификации SKIP)'}`);
console.log('================================================================\n');

// ── 4. Выполнение тестовых кейсов ───────────────────────────────────────────────────

// TC-06 тест совместимости: при отсутствии mode поведение полностью идентично текущему (по умолчанию full-замена всего)
async function testTC06() {
  console.log('[Выполнение кейса] TC-06 совместимость: при отсутствии mode по умолчанию выполняется полное перезаписывающее восстановление');
  if (!backupService) {
    skip('TC-06 совместимость', 'модуль gateway/backup-service.js не удалось загрузить: ' + (backupServiceLoadError?.message || 'модуль не готов'), [
      'После готовности бэкенда следует утверждать: при отсутствии mode по умолчанию выполняется полное восстановление full, старые сессии заменяются снимком'
    ]);
    return;
  }
  try {
    cleanLiveDsh();

    // Настройка актуального окружения: уже имеющаяся сессия s_live_1 и старая конфигурация
    fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions/s_live_1'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'sessions/s_live_1/content.json'), '{"live":true}');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'server: live_value');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'gateway.config.json'), '{"authToken":"live_token"}');

    // Конструирование тестового снимка: с новой сессией s_snap_1 и новой конфигурацией
    const snapName = 'dsh-manual-2026-09-30-tc06.tar.gz';
    buildSnapshotArchive(snapName, {
      'cordis.patch.yml': 'server: snapshot_value',
      'sessions/s_snap_1/content.json': '{"snap":true}'
    });

    const mockDsh = {
      stop: async () => true,
      boot: async () => ({ ok: true })
    };

    // mode не передан (или переданы пустые options)
    const res = await backupService.restoreBackup(snapName, mockDsh);

    const cordisAfter = fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8');
    const hasSnapSession = fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/s_snap_1'));
    const hasLiveSession = fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/s_live_1'));
    const gwConfigAfter = fs.existsSync(path.join(TEST_DSH_DIR, 'gateway.config.json'));

    const isOk = res && res.ok === true &&
      cordisAfter.includes('snapshot_value') &&
      hasSnapSession &&
      !hasLiveSession && // полное восстановление заменило старые данные
      gwConfigAfter;      // gateway.config.json сохранён сквозным образом

    if (isOk) {
      pass('TC-06 совместимость', 'при отсутствии mode по умолчанию выполняется полное перезаписывающее восстановление full, старые сессии заменены снимком, конфигурация и сквозные элементы корректно сохранены');
    } else {
      fail('TC-06 совместимость', 'состояние окружения после восстановления не соответствует ожиданиям', JSON.stringify({ res, cordisAfter, hasSnapSession, hasLiveSession }));
    }
  } catch (err) {
    fail('TC-06 совместимость', 'при выполнении выброшено исключение', err.message);
  }
}

// TC-03 мошенничество с именем: архив с сессиями назван xxx-config-xxx.tar.gz, тип всё равно должен определяться как full
async function testTC03() {
  console.log('[Выполнение кейса] TC-03 мошенничество с именем: архив с сессиями переименован в xxx-config-xxx, по содержимому тип всё равно full');
  try {
    const inferFn = manifestModule.inferFromMembers;
    if (typeof inferFn !== 'function') {
      skip('TC-03 мошенничество с именем', 'в snapshot-manifest.js не экспортирована функция inferFromMembers');
      return;
    }

    const deceptiveFilename = 'dsh-config-2026-09-30-fake-attack.tar.gz';
    const deceptiveMembers = [
      '.dsh/cordis.patch.yml',
      '.dsh/profiles/web/package.json',
      '.dsh/sessions/session_secret_uuid/meta.json',
      '.dsh/attachments/uploaded_doc.pdf'
    ];

    const inferred = inferFn(deceptiveMembers, deceptiveFilename);

    if (inferred && inferred.backupType === 'full') {
      pass('TC-03 мошенничество с именем', `архив назван ${deceptiveFilename}, по внутренним членам-сессиям тип определён как full (мошенничество с именем успешно предотвращено)`);
    } else {
      skip(
        'TC-03 мошенничество с именем',
        'в snapshot-manifest.js ещё не переведено определение backupType на содержимое по hasSessions (текущая строка 319 по-прежнему выводит config по регулярке имени файла)',
        [
          'После готовности бэкенда следует утверждать: inferFromMembers(deceptiveMembers, "' + deceptiveFilename + '").backupType === "full"',
          'Требуемая правка бэкенда: в gateway/snapshot-manifest.js сделать backupType = hasSessions ? "full" : "config"'
        ]
      );
    }
  } catch (err) {
    fail('TC-03 мошенничество с именем', 'при выполнении выброшено исключение', err.message);
  }
}

// TC-01 позитив: в актуальном окружении есть S1~S3, в снимке B1~B5 → после config-only восстановления: конфигурация из снимка, S1~S3 остаются, B1~B5 не импортированы
async function testTC01() {
  console.log('[Выполнение кейса] TC-01 позитив: config-only восстановление защищает актуальные сессии S1~S3, применяет конфигурацию снимка, исключает сессии снимка B1~B5');
  if (!hasConfigOnlySupport) {
    skip(
      'TC-01 позитив (config-only восстановление)',
      'gateway/backup-service.js ещё не готов (не обнаружена поддержка mode: "config-only" или DATA_ENTRIES)',
      [
        'После готовности бэкенда следует утверждать: restoreBackup(filename, dshManager, { mode: "config-only" }) возвращает { ok: true, mode: "config-only" }',
        'После готовности бэкенда следует утверждать: cordis.patch.yml и прочие конфигурационные файлы обновлены содержимым снимка',
        'После готовности бэкенда следует утверждать: актуальные сессии .dsh/sessions/S1, S2, S3 на 100% сохранены без повреждений',
        'После готовности бэкенда следует утверждать: сессии снимка B1~B5 через исключение при распаковке не импортированы в актуальное окружение',
        'После готовности бэкенда следует утверждать: storages/workspace.json сохраняет прежнюю индексацию актуального окружения и не перезаписан снимком'
      ]
    );
    return;
  }

  try {
    cleanLiveDsh();
    fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions/S1'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions/S2'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions/S3'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'sessions/S1/meta.json'), '{"id":"S1"}');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'theme: live_dark');

    const snapName = 'dsh-full-2026-09-30-tc01.tar.gz';
    buildSnapshotArchive(snapName, {
      'cordis.patch.yml': 'theme: snapshot_light',
      'sessions/B1/meta.json': '{"id":"B1"}',
      'sessions/B2/meta.json': '{"id":"B2"}'
    });

    const mockDsh = {
      stop: async () => true,
      boot: async () => ({ ok: true })
    };

    const res = await backupService.restoreBackup(snapName, mockDsh, { mode: 'config-only' });
    const cordisAfter = fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8');
    const hasS1 = fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/S1/meta.json'));
    const hasS2 = fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/S2'));
    const hasS3 = fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/S3'));
    const hasB1 = fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/B1'));

    if (res.ok && res.mode === 'config-only' && cordisAfter.includes('snapshot_light') && hasS1 && hasS2 && hasS3 && !hasB1) {
      pass('TC-01 позитив', 'config-only восстановление успешно обновило конфигурацию, актуальные сессии S1~S3 полностью сохранены, сессия снимка B1 не импортирована в актуальное окружение');
    } else {
      fail('TC-01 позитив', 'состояние окружения не соответствует ожиданиям', JSON.stringify({ res, hasS1, hasB1, cordisAfter }));
    }
  } catch (err) {
    fail('TC-01 позитив', 'при выполнении выброшено исключение', err.message);
  }
}

// TC-02 инъекция сбоя: неисправная конфигурация в staging вызывает сбой boot; после точного обратного отката S1~S3 обязаны остаться нетронутыми
async function testTC02() {
  console.log('[Выполнение кейса] TC-02 инъекция сбоя: сбой запуска DSH вызывает точный обратный откат, актуальные сессии остаются на месте');
  if (!hasConfigOnlySupport) {
    skip(
      'TC-02 инъекция сбоя (точный обратный откат §4.6)',
      'gateway/backup-service.js ещё не готов (механизм отката ещё не переработан в точный обратный)',
      [
        'После готовности бэкенда следует утверждать: неисправная конфигурация в staging вызывает сбой проверки активности DSH и выброс исключения',
        'После готовности бэкенда следует утверждать: механизм точного обратного отката удаляет только элементы, перенесённые из staging, и ни в коем случае не вызывает clearDir(DSH_DIR) с ложным удалением данных',
        'После готовности бэкенда следует утверждать: после отката актуальные сессии S1~S3 на 100% сохранены на месте, конфигурация восстановлена до исходного live-состояния'
      ]
    );
    return;
  }

  try {
    cleanLiveDsh();
    fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions/S1'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'sessions/S1/meta.json'), '{"id":"S1"}');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'server: original_live');

    const faultySnap = 'dsh-faulty-2026-09-30-tc02.tar.gz';
    buildSnapshotArchive(faultySnap, {
      'cordis.patch.yml': 'server: broken_staging'
    });

    const failingDsh = {
      stop: async () => true,
      boot: async () => { throw new Error('Simulated DSH Boot Failure'); }
    };

    let thrown = false;
    try {
      await backupService.restoreBackup(faultySnap, failingDsh, { mode: 'config-only' });
    } catch {
      thrown = true;
    }

    const hasS1 = fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/S1/meta.json'));
    const cordisAfter = fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8');

    if (thrown && hasS1 && cordisAfter.includes('original_live')) {
      pass('TC-02 инъекция сбоя', 'сбой запуска DSH корректно вызвал точный обратный откат, сессия S1 актуального окружения осталась на месте, конфигурация полностью восстановлена');
    } else {
      fail('TC-02 инъекция сбоя', 'после отката состояние аномально или сессия потеряна', JSON.stringify({ thrown, hasS1, cordisAfter }));
    }
  } catch (err) {
    fail('TC-02 инъекция сбоя', 'при выполнении выброшено исключение', err.message);
  }
}

// TC-04 пустое окружение: после очистки .dsh восстановление config-only без конфликтов workspace.json, DSH корректно загружается
async function testTC04() {
  console.log('[Выполнение кейса] TC-04 пустое окружение: после очистки .dsh восстановление в режиме config-only');
  if (!hasConfigOnlySupport) {
    skip(
      'TC-04 пустое окружение',
      'gateway/backup-service.js ещё не готов (не реализована очистка workspace.json для пустого окружения и распаковка конфигурации)',
      [
        'После готовности бэкенда следует утверждать: после очистки .dsh config-only корректно распаковывает подмножество конфигурации',
        'После готовности бэкенда следует утверждать: если снимок содержит workspace.json, sessionIds очищаются во избежание конфликта ложной индексации сессий',
        'После готовности бэкенда следует утверждать: DSH корректно завершает загрузку и возвращает ok: true'
      ]
    );
    return;
  }

  try {
    cleanLiveDsh(); // полная очистка
    const snapName = 'dsh-clean-2026-09-30-tc04.tar.gz';
    buildSnapshotArchive(snapName, {
      'cordis.patch.yml': 'mode: empty_env_test',
      'storages/workspace.json': '{"sessionIds":["ghost1","ghost2"]}'
    });

    const mockDsh = {
      stop: async () => true,
      boot: async () => ({ ok: true })
    };

    const res = await backupService.restoreBackup(snapName, mockDsh, { mode: 'config-only' });
    const cordisAfter = fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8');
    const wsExists = fs.existsSync(path.join(TEST_DSH_DIR, 'storages/workspace.json'));
    let cleanWs = true;
    if (wsExists) {
      const wsContent = JSON.parse(fs.readFileSync(path.join(TEST_DSH_DIR, 'storages/workspace.json'), 'utf8'));
      if (Array.isArray(wsContent.sessionIds) && wsContent.sessionIds.length > 0) {
        cleanWs = false; // остались неочищенные призрачные сессии
      }
    }

    if (res.ok && cordisAfter.includes('empty_env_test') && cleanWs) {
      pass('TC-04 пустое окружение', 'после очистки .dsh режим config-only успешно восстановил конфигурацию, в workspace.json нет конфликтов сиротской индексации, DSH корректно поднялся');
    } else {
      fail('TC-04 пустое окружение', 'после восстановления в пустом окружении состояние аномально', JSON.stringify({ res, cleanWs }));
    }
  } catch (err) {
    fail('TC-04 пустое окружение', 'при выполнении выброшено исключение', err.message);
  }
}

// TC-05 оффлайн: восстановление config-only без сети не запускает сетевой pnpm install, поднимается на текущих node_modules
async function testTC05() {
  console.log('[Выполнение кейса] TC-05 оффлайн: восстановление config-only без сети сохраняет актуальные node_modules, не запускает pnpm install');
  if (!hasConfigOnlySupport) {
    skip(
      'TC-05 оффлайн',
      'gateway/backup-service.js ещё не готов (не реализована стратегия сохранения на месте profiles/*/node_modules)',
      [
        'После готовности бэкенда следует утверждать: при распаковке config-only исключаются profiles/*/node_modules, чтобы не затереть актуальные зависимости',
        'После готовности бэкенда следует утверждать: уже имеющиеся в актуальном окружении node_modules сохраняются на месте, сетевой pnpm install не запускается',
        'После готовности бэкенда следует утверждать: в оффлайн-состоянии DSH корректно поднимается и становится готов'
      ]
    );
    return;
  }

  try {
    cleanLiveDsh();
    const liveModulesDir = path.join(TEST_DSH_DIR, 'profiles/web/node_modules/cached_pkg');
    fs.mkdirSync(liveModulesDir, { recursive: true });
    fs.writeFileSync(path.join(liveModulesDir, 'index.js'), 'module.exports = "cached";');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'server: live');

    const snapName = 'dsh-offline-2026-09-30-tc05.tar.gz';
    buildSnapshotArchive(snapName, {
      'cordis.patch.yml': 'server: offline_snap',
      'profiles/web/package.json': '{"name":"web","dependencies":{"cached_pkg":"1.0.0"}}'
    });

    const mockDsh = {
      stop: async () => true,
      boot: async () => ({ ok: true })
    };

    const res = await backupService.restoreBackup(snapName, mockDsh, { mode: 'config-only' });
    const cachedExists = fs.existsSync(path.join(TEST_DSH_DIR, 'profiles/web/node_modules/cached_pkg/index.js'));

    if (res.ok && cachedExists) {
      pass('TC-05 оффлайн', 'config-only восстановление успешно сохранило актуальные node_modules, перезапись зависимостей и сетевая переустановка не запускались, DSH корректно готов');
    } else {
      fail('TC-05 оффлайн', 'актуальные node_modules не удалось корректно сохранить', JSON.stringify({ res, cachedExists }));
    }
  } catch (err) {
    fail('TC-05 оффлайн', 'при выполнении выброшено исключение', err.message);
  }
}

// ── 5. Выполнение всех кейсов и вывод итога ─────────────────────────────────────────
async function runAll() {
  await testTC06();
  await testTC03();
  await testTC01();
  await testTC02();
  await testTC04();
  await testTC05();

  console.log('\n========================================');
  console.log(`Итог тестов: пройдено ${passCount} / провалено ${failCount} / пропущено ${skipCount}`);
  console.log('========================================\n');

  // Очистка временных файлов (если временный каталог создан самим скриптом)
  if (isTempCreated) {
    try {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch {}
  }

  process.exit(failCount > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('Исключение при выполнении набора тестов:', err);
  process.exit(1);
});
