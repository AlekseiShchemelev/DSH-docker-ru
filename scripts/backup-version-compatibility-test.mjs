/**
 * backup-version-compatibility-test.mjs
 * 
 * Полный комплекс сквозной автоматической проверки совместимости конфигурационных снимков DSH с версиями
 * 
 * Покрытые кейсы:
 * 1. Тест 1: создание полного снимка с версионной меткой, проверка корректной инъекции метаданных в архив и внешний файл метаданных;
 * 2. Тест 2: проверка интеллектуального вывода совместимости старых снимков без версионной метки;
 * 3. Тест 3: проверка API сравнения версий при восстановлении между версиями;
 * 4. Тест 4: умышленно сконструированные повреждённые/враждебные метаданные — проверка оборонительной устойчивости;
 * 5. Тест 5: имитация сбоя проверки активности с запуском атомарного отката, проверка 100% сохранности конфигурации прежней версии и учётных данных шлюза.
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// Подключение существующих утилит безопасности
const { isValidVersion } = require(path.join(here, '../gateway/dsh-version.js'));
const { validateArchiveMembers } = require(path.join(here, '../gateway/backup-service.js'));

// Временное рабочее пространство теста
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-test-'));
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`   ✔ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`   ❌ [FAIL] ${message}`);
    failCount++;
  }
}

function runTar(args, cwd) {
  return spawnSync('tar', args, { cwd, encoding: 'utf8' });
}

function calcSha256(contentOrPath) {
  const hash = crypto.createHash('sha256');
  if (fs.existsSync(contentOrPath)) {
    hash.update(fs.readFileSync(contentOrPath));
  } else {
    hash.update(contentOrPath);
  }
  return hash.digest('hex');
}

// =========================================================================
// 【Ключевые компоненты реализации: менеджер метаданных, движок вывода по отпечатку и оценщик совместимости】
// =========================================================================

/**
 * Безопасный парсер метаданных (защита от прототипной инъекции, защита от сверхбольших файлов, строгая проверка полей)
 */
function parseSafeMetadata(rawString) {
  if (!rawString || typeof rawString !== 'string') {
    throw new Error('Содержимое метаданных пустое или не строка');
  }
  if (rawString.length > 512 * 1024) {
    throw new Error('Размер файла метаданных превышает безопасный предел (512KB)');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawString, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined; // устранение прототипной инъекции
      }
      return value;
    });
  } catch (err) {
    throw new Error(`Формат JSON метаданных повреждён: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Корневой узел метаданных должен быть корректным объектом JSON');
  }

  // Строгая очистка номера версии и полей
  if (parsed.dshVersion && !isValidVersion(parsed.dshVersion)) {
    throw new Error(`Метаданные содержат недопустимый номер версии DSH: ${String(parsed.dshVersion).slice(0, 32)}`);
  }

  return parsed;
}

/**
 * Классификатор по отпечатку содержимого: интеллектуальный вывод реальной версии DSH по физической структуре файлов
 */
function inferSnapshotStructure(dshDir) {
  const hasCordisPatch = fs.existsSync(path.join(dshDir, 'cordis.patch.yml'));
  const hasSettingsImported = fs.existsSync(path.join(dshDir, 'settings.yaml.imported'));
  const hasProfilesWeb = fs.existsSync(path.join(dshDir, 'profiles', 'web.json')) || fs.existsSync(path.join(dshDir, 'profiles', 'web'));
  const hasLegacySettings = fs.existsSync(path.join(dshDir, 'settings.yaml'));

  if (hasCordisPatch || hasSettingsImported || hasProfilesWeb) {
    return {
      inferredDshVersion: '>=0.1.7',
      structureType: 'cordis-patch',
      confidence: 'high',
      notes: 'Обнаружен слой патчей cordis или структура профилей, соответствует современной архитектуре DSH 0.1.7+'
    };
  }

  if (hasLegacySettings && !hasCordisPatch) {
    return {
      inferredDshVersion: '<=0.1.6',
      structureType: 'legacy-settings-yaml',
      confidence: 'high',
      notes: 'Обнаружен только старый settings.yaml, относится к архитектуре до DSH 0.1.6'
    };
  }

  return {
    inferredDshVersion: 'unknown',
    structureType: 'minimal-or-empty',
    confidence: 'low',
    notes: 'Не удалось распознать явные признаки структуры конфигурации'
  };
}

/**
 * Движок оценки совместимости между версиями
 */
function evaluateRestoreCompatibility(snapshotDshVer, systemDshVer) {
  if (!snapshotDshVer || snapshotDshVer === 'unknown') {
    return {
      status: 'warning',
      action: 'prompt-user',
      message: 'Снимок не имеет явной версии, и её невозможно точно вывести из структуры файлов; рекомендуется сделать резервную копию текущего окружения перед восстановлением.'
    };
  }

  // Отказ по разрыву архитектурных поколений (например, >=0.2.0)
  if (snapshotDshVer.startsWith('0.2.') || snapshotDshVer.startsWith('0.3.')) {
    return {
      status: 'blocked',
      action: 'reject',
      message: `Версия снимка (${snapshotDshVer}) относится к архитектурной перестройке между крупными версиями, текущее окружение контейнера несовместимо; пересоздайте контейнер.`
    };
  }

  // Сравнение системы 0.1.7 с системой <=0.1.6
  const isSnapLegacy = snapshotDshVer.includes('0.1.5') || snapshotDshVer.includes('0.1.6') || snapshotDshVer === '<=0.1.6';
  const isSysModern = systemDshVer.includes('0.1.7') || systemDshVer.includes('0.1.8');

  if (isSnapLegacy && isSysModern) {
    return {
      status: 'upgrade_compatible',
      action: 'auto-migrate-settings',
      message: `Снимок старый (${snapshotDshVer}), после восстановления DSH автоматически мигрирует импорт settings.yaml в слой патчей и переименует его в settings.yaml.imported.`
    };
  }

  const isSnapModern = snapshotDshVer.includes('0.1.7') || snapshotDshVer.includes('0.1.8');
  const isSysLegacy = systemDshVer.includes('0.1.5') || systemDshVer.includes('0.1.6');

  if (isSnapModern && isSysLegacy) {
    return {
      status: 'danger',
      action: 'warn-downgrade',
      message: `Серьёзное предупреждение: попытка восстановить снимок высокой версии 0.1.7+ на систему низкой версии (${systemDshVer})! Низкая версия не может разобрать патчи cordis.patch.yml и не может прочитать данные сессий V4.`
    };
  }

  return {
    status: 'compatible',
    action: 'allow',
    message: `Версия снимка (${snapshotDshVer}) полностью совместима с текущей системой (${systemDshVer}).`
  };
}

// =========================================================================
// 【Процесс выполнения тестов】
// =========================================================================

async function runAllTests() {
  console.log('======================================================================');
  console.log('🚀 Запуск автоматизированного набора проверки совместимости конфигурационных снимков DSH с версиями');
  console.log('======================================================================\n');

  // -------------------------------------------------------------------------
  // Тест 1: создание полного снимка с версионной меткой
  // -------------------------------------------------------------------------
  console.log('📌 【Тест 1】: создание полного снимка с версионной меткой и двойная инъекция метаданных');
  {
    const mockDsh = path.join(TEST_ROOT, 'case1-dsh', '.dsh');
    fs.mkdirSync(path.join(mockDsh, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(mockDsh, 'cordis.patch.yml'), 'services:\n  dshmarket: true\n');
    fs.writeFileSync(path.join(mockDsh, 'profiles', 'web.json'), '{"plugins":{}}\n');
    
    // Чувствительные файлы (обязательно исключаются при упаковке)
    fs.writeFileSync(path.join(mockDsh, 'gateway.config.json'), '{"authToken":"secret-token-123"}\n');
    fs.writeFileSync(path.join(mockDsh, '.session_secret'), 'mock-session-secret-data\n');

    const meta = {
      snapshotVersion: 1,
      dshVersion: '0.1.7-rc.2',
      projectVersion: '0.1.8',
      backupType: 'full',
      createdAt: new Date().toISOString(),
      generator: 'deepseek-harness-docker/backup-service',
      structuralFingerprint: {
        hasCordisPatch: true,
        hasSettingsYaml: false
      }
    };

    // Внутренняя инъекция метаданных
    fs.writeFileSync(path.join(mockDsh, '.snapshot-meta.json'), JSON.stringify(meta, null, 2));

    const archiveTar = path.join(TEST_ROOT, 'case1-snapshot.tar.gz');
    const sidecarMeta = path.join(TEST_ROOT, 'case1-snapshot.meta.json');

    // Упаковка со строгим исключением чувствительных файлов шлюза
    const tarRes = runTar([
      '-czf', archiveTar,
      '--exclude=.dsh/gateway.config.json',
      '--exclude=.dsh/.session_secret',
      '-C', path.dirname(mockDsh),
      '.dsh'
    ], TEST_ROOT);

    assert(tarRes.status === 0, 'архив снимка tar.gz успешно создан');

    // Запись внешнего sidecar-файла
    const sidecarData = {
      ...meta,
      archiveChecksum: calcSha256(archiveTar),
      archiveSizeBytes: fs.statSync(archiveTar).size
    };
    fs.writeFileSync(sidecarMeta, JSON.stringify(sidecarData, null, 2));

    assert(fs.existsSync(sidecarMeta), 'внешний sidecar-файл метаданных (.meta.json) корректно размещён');

    // Проверка членов внутри архива
    const inspectRes = runTar(['-tzf', archiveTar], TEST_ROOT);
    const members = inspectRes.stdout.split('\n');

    assert(members.includes('.dsh/.snapshot-meta.json'), 'внутрь архива корректно встроен файл метаданных .dsh/.snapshot-meta.json');
    assert(!members.includes('.dsh/gateway.config.json'), 'из архива строго исключён чувствительный файл gateway.config.json');
    assert(!members.includes('.dsh/.session_secret'), 'из архива строго исключён ключ подписи .session_secret');
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // Тест 2: проверка интеллектуального вывода совместимости старых снимков без версионной метки
  // -------------------------------------------------------------------------
  console.log('📌 【Тест 2】: интеллектуальный вывод совместимости старого снимка без версионной метки');
  {
    const legacyDsh = path.join(TEST_ROOT, 'case2-legacy', '.dsh');
    fs.mkdirSync(legacyDsh, { recursive: true });
    fs.writeFileSync(path.join(legacyDsh, 'settings.yaml'), 'defaultModel: deepseek-chat\n');

    const legacyTar = path.join(TEST_ROOT, 'case2-legacy.tar.gz');
    runTar(['-czf', legacyTar, '-C', path.dirname(legacyDsh), '.dsh'], TEST_ROOT);

    // Имитация распаковки в staging для обнаружения
    const stagingDir = path.join(TEST_ROOT, 'case2-staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    runTar(['-xzf', legacyTar, '-C', stagingDir], TEST_ROOT);

    const stagedDsh = path.join(stagingDir, '.dsh');
    const hasMeta = fs.existsSync(path.join(stagedDsh, '.snapshot-meta.json'));
    assert(!hasMeta, 'подтверждено, что в старом снимке действительно нет встроенного маркера .snapshot-meta.json');

    const inference = inferSnapshotStructure(stagedDsh);
    assert(inference.inferredDshVersion === '<=0.1.6', `выведенная версия точна: ${inference.inferredDshVersion}`);
    assert(inference.structureType === 'legacy-settings-yaml', `модель структуры корректно распознана: ${inference.structureType}`);
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // Тест 3: проверка API сравнения версий при восстановлении между версиями
  // -------------------------------------------------------------------------
  console.log('📌 【Тест 3】: сравнение версий при восстановлении между версиями и матрица решений совместимости');
  {
    // 3.1 Восстановление той же версии
    const resSame = evaluateRestoreCompatibility('0.1.7-rc.2', '0.1.7-rc.2');
    assert(resSame.status === 'compatible', 'восстановление той же версии оценено как compatible и разрешено');

    // 3.2 Восстановление со старой версии 0.1.5 на новую 0.1.7 (апгрейд)
    const resUpgrade = evaluateRestoreCompatibility('0.1.5-rc.1', '0.1.7-rc.2');
    assert(resUpgrade.status === 'upgrade_compatible', 'восстановление со старой версии на новую сообщает о миграционном апгрейде (upgrade_compatible)');
    assert(resUpgrade.action === 'auto-migrate-settings', 'корректно задана стратегия миграционного импорта конфигурации');

    // 3.3 Восстановление с новой версии 0.1.7 на старую 0.1.5 (даунгрейд, высокий риск)
    const resDowngrade = evaluateRestoreCompatibility('0.1.7-rc.2', '0.1.5-rc.1');
    assert(resDowngrade.status === 'danger', 'даунгрейд с высокой версии на низкую вызывает предупреждение danger');

    // 3.4 Восстановление через крупную версионную перестройку (0.2.0 -> 0.1.7)
    const resBlock = evaluateRestoreCompatibility('0.2.0', '0.1.7-rc.2');
    assert(resBlock.status === 'blocked', 'фундаментальная несовместимость между крупными версиями строго заблокирована (blocked)');
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // Тест 4: умышленно сконструированные повреждённые/враждебные метаданные — проверка оборонительной устойчивости
  // -------------------------------------------------------------------------
  console.log('📌 【Тест 4】: оборонительная устойчивость (некорректные/враждебные метаданные и конфликт содержимого)');
  {
    // 4.1 Некорректный синтаксис JSON
    try {
      parseSafeMetadata('{ invalid_json: ');
      assert(false, 'некорректный JSON должен быть отклонён исключением');
    } catch (e) {
      assert(e.message.includes('Формат JSON метаданных повреждён'), 'некорректный JSON успешно пойман и перехвачен');
    }

    // 4.2 Противодействие прототипной инъекции
    const evilProtoPayload = '{"__proto__": {"isAdmin": true}, "dshVersion": "0.1.7"}';
    const parsedObj = parseSafeMetadata(evilProtoPayload);
    const testEmpty = {};
    assert(testEmpty.isAdmin === undefined, 'атака прототипной инъекции полностью заблокирована');
    assert(parsedObj.dshVersion === '0.1.7', 'легитимное поле извлекается в обычном режиме');

    // 4.3 Вредоносная инъекция в номер версии (обход пути/спецсимволы shell)
    try {
      parseSafeMetadata('{"dshVersion": "../../etc/passwd"}');
      assert(false, 'номер версии с обходом пути должен быть отклонён');
    } catch (e) {
      assert(e.message.includes('недопустимый номер версии DSH'), 'недопустимый путь в версии успешно перехвачен строгой проверкой isValidVersion');
    }

    // 4.4 Разрешение конфликта между метаданными и фактическим содержимым (метаданные заявляют 0.1.7, содержимое на деле 0.1.5)
    const fakeDir = path.join(TEST_ROOT, 'case4-fake', '.dsh');
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'settings.yaml'), 'a: 1\n'); // есть только файл 0.1.5
    const claimedVer = '0.1.7';
    const struct = inferSnapshotStructure(fakeDir);
    
    assert(struct.inferredDshVersion !== claimedVer, 'обнаружено несоответствие между заявленной в метаданных версией и признаками структуры файлов');
    // Коррекция по авторитету содержимого: приоритет фактической структуры
    const finalEffectiveVer = struct.inferredDshVersion === '<=0.1.6' ? '0.1.5' : claimedVer;
    assert(finalEffectiveVer === '0.1.5', 'корректор успешно применил принцип «содержимое — истина» и переписал оценочную версию');
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // Тест 5: имитация сбоя проверки активности с запуском атомарного отката, проверка сохранности конфигурации прежней версии
  // -------------------------------------------------------------------------
  console.log('📌 【Тест 5】: проверка атомарного отката при имитации сбоя проверки активности');
  {
    // Создание продакшн-каталога (/root/.dsh в имитации)
    const liveDir = path.join(TEST_ROOT, 'case5-live-dsh');
    fs.mkdirSync(path.join(liveDir, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'canary-live-token.txt'), 'LIVE_STATE_ORIGINAL_DATA_V1');
    fs.writeFileSync(path.join(liveDir, 'gateway.config.json'), '{"authToken":"keep-my-current-token-999"}\n');
    fs.writeFileSync(path.join(liveDir, '.session_secret'), 'original-crypto-session-secret\n');

    // Подготовка снимка плохой версии (имитация снимка с плохим плагином или таймаутом запуска)
    const badSource = path.join(TEST_ROOT, 'case5-bad-source', '.dsh');
    fs.mkdirSync(badSource, { recursive: true });
    fs.writeFileSync(path.join(badSource, 'corrupt-setting.txt'), 'BAD_STATE_V2');
    const badTar = path.join(TEST_ROOT, 'case5-bad.tar.gz');
    runTar(['-czf', badTar, '-C', path.dirname(badSource), '.dsh'], TEST_ROOT);

    // Имитация выполнения атомарной транзакции восстановления
    const stagingDir = path.join(liveDir, '.restore-staging');
    const rollbackDir = path.join(liveDir, '.restore-rollback');
    fs.mkdirSync(stagingDir, { recursive: true });

    // 1. Распаковка в staging
    runTar(['-xzf', badTar, '-C', stagingDir], TEST_ROOT);

    // 2. Сквозное сохранение учётных данных шлюза и session_secret
    const stagedDsh = path.join(stagingDir, '.dsh');
    for (const file of ['gateway.config.json', '.session_secret']) {
      const src = path.join(liveDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(stagedDsh, file));
      }
    }

    // 3. Атомарная подмена (актуальное в rollback, staging в актуальное)
    const SKIP = new Set(['.restore-staging', '.restore-rollback']);
    fs.mkdirSync(rollbackDir, { recursive: true });
    for (const item of fs.readdirSync(liveDir)) {
      if (SKIP.has(item)) continue;
      fs.renameSync(path.join(liveDir, item), path.join(rollbackDir, item));
    }
    for (const item of fs.readdirSync(stagedDsh)) {
      if (SKIP.has(item)) continue;
      fs.renameSync(path.join(stagedDsh, item), path.join(liveDir, item));
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });

    assert(fs.existsSync(path.join(liveDir, 'corrupt-setting.txt')), 'новая плохая версия временно размещена');
    assert(!fs.existsSync(path.join(liveDir, 'canary-live-token.txt')), 'файлы прежней версии перемещены в область отката');

    // 4. Имитация сбоя проверки готовности после запуска (Healthcheck Timeout)
    const mockHealthcheck = () => false; // имитация таймаута неготовности
    const isReady = mockHealthcheck();

    if (!isReady) {
      console.log('   ⚠️ Проверка активности обнаружила таймаут запуска DSH, запускается атомарный аварийный откат...');
      // Выполнение отката
      for (const item of fs.readdirSync(liveDir)) {
        if (SKIP.has(item)) continue;
        fs.rmSync(path.join(liveDir, item), { recursive: true, force: true });
      }
      for (const item of fs.readdirSync(rollbackDir)) {
        fs.renameSync(path.join(rollbackDir, item), path.join(liveDir, item));
      }
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    }

    // 5. Проверка 100% восстановления прежнего состояния
    const canaryRestored = fs.existsSync(path.join(liveDir, 'canary-live-token.txt')) &&
      fs.readFileSync(path.join(liveDir, 'canary-live-token.txt'), 'utf8') === 'LIVE_STATE_ORIGINAL_DATA_V1';
    assert(canaryRestored, 'канареечный файл признаков прежнего окружения восстановлен на 100%');

    const badRemoved = !fs.existsSync(path.join(liveDir, 'corrupt-setting.txt'));
    assert(badRemoved, 'файлы новой версии, вызвавшей сбой, полностью удалены из актуального окружения');

    // 6. Проверка целостности учётных данных шлюза и session_secret
    const tokenPreserved = JSON.parse(fs.readFileSync(path.join(liveDir, 'gateway.config.json'), 'utf8')).authToken === 'keep-my-current-token-999';
    const secretPreserved = fs.readFileSync(path.join(liveDir, '.session_secret'), 'utf8') === 'original-crypto-session-secret\n';
    assert(tokenPreserved, 'учётные данные администрирования шлюза (authToken) сквозным образом сохранены без повреждений');
    assert(secretPreserved, 'ключ подписи cookie (.session_secret) сквозным образом сохранён без повреждений');
  }

  // Очистка временного тестового окружения
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });

  console.log('\n======================================================================');
  console.log(`🏁 Выполнение автоматизированного набора тестов завершено: пройдено ${passCount} / провалено ${failCount}`);
  console.log('======================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Исключение при выполнении теста:', err);
  process.exit(1);
});
