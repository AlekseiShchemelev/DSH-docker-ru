#!/usr/bin/env node
/**
 * Юнит-тесты хранилища версий (Issue #7): персистентность / целостность / GC
 *
 * Покрытие:
 *   A. Незавершённый архив (только package.json, нет .ready) никогда не считается «закэшированным»
 *   B. Архив с несовпадающими Node ABI / архитектурой в .ready считается недействительным
 *   C. Внутренние каталоги вроде .staging не отображаются как версии
 *   D. deleteCachedVersion защищает активную версию и опорную версию образа
 *   E. gcVersions сохраняет keepN + активную версию + опорную версию образа, остальное чистит по LRU
 *   F. getVersionsStoreStats возвращает корректную структуру
 *
 * Запуск: node scripts/version-store-test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Переменную окружения нужно задать до require (константы уровня модуля вычисляются при загрузке)
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-test-'));
process.env.DSH_VERSIONS_DIR = STORE;
process.env.DSH_HOME = STORE;
// Тестовый хук: указывает «родительский каталог активного ядра / симлинк dsh» на временный каталог,
// чтобы проверить логику подмены с откатом
const CORE_PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-core-test-'));
process.env.DSH_TEST_CORE_PARENT = CORE_PARENT;
process.env.DSH_TEST_BIN_LINK = path.join(CORE_PARENT, 'fake-dsh-bin');

const mgr = require('../gateway/dsh-manager.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`   ✔ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`   ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
}

/** Создаёт «полностью готовый» каталог архива */
function makeReady(version, { abi = process.versions.modules, arch = process.arch } = {}) {
  const dir = path.join(STORE, version);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'index.js'), '// dep\n');
  fs.writeFileSync(path.join(dir, '.ready'), JSON.stringify({ version, nodeAbi: abi, arch, imageRevision: 'test' }));
  return dir;
}
/** Создаёт незавершённый архив: записан только package.json (имитация SIGKILL посреди `cp -a`) */
function makeHalfBaked(version) {
  const dir = path.join(STORE, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return dir;
}

console.log(`\n===== Юнит-тесты хранилища версий (Issue #7) (store=${STORE}) =====\n`);

// ── A/B/C: проверка целостности ──────────────────────────────────────
console.log('[A/B/C] Проверка целостности');
makeReady('1.0.0');
makeHalfBaked('2.0.0');
makeReady('3.0.0', { abi: '999' });            // несовпадение ABI → недействителен
makeReady('4.0.0', { arch: 'mips' });          // несовпадение архитектуры → недействителен
fs.mkdirSync(path.join(STORE, '.staging', 'junk'), { recursive: true });

eq('getCachedVersions возвращает только версии, прошедшие проверку .ready', mgr.getCachedVersions(), ['1.0.0']);
check('незавершённый 2.0.0 не считается закэшированным', !mgr.getCachedVersions().includes('2.0.0'));
check('3.0.0 с несовпадающим ABI признан недействительным', !mgr.getCachedVersions().includes('3.0.0'));
check('4.0.0 с несовпадающей архитектурой признан недействительным', !mgr.getCachedVersions().includes('4.0.0'));
check('внутренний каталог .staging не попадает в список версий', !mgr.getCachedVersions().some(v => v.startsWith('.')));
check('versionsCacheDir указывает на персистентное хранилище (не /app)', mgr.versionsCacheDir === STORE, mgr.versionsCacheDir);

// ── F: статистика ────────────────────────────────────────────────────
console.log('\n[F] Статистика хранилища версий');
mgr.lastKnownVersion = '1.0.0';
const stats = mgr.getVersionsStoreStats();
check('stats.ok истинно', stats.ok === true);
check('stats.dir корректен', stats.dir === STORE);
check('stats.persisted — булево значение', typeof stats.persisted === 'boolean');
check('stats содержит 4 записи (включая незавершённую)', stats.versions.length === 4, `фактически ${stats.versions.length}`);
const v100 = stats.versions.find(v => v.version === '1.0.0');
check('активная версия помечена active', v100 && v100.active === true);
check('запись несёт флаг ready', stats.versions.find(v => v.version === '2.0.0')?.ready === false);
check('запись несёт поле размера', typeof v100.sizeBytes === 'number');

// ── D: защита при удалении ───────────────────────────────────────────
console.log('\n[D] Защита при удалении');
const dActive = mgr.deleteCachedVersion('1.0.0');
check('удаление запущенной версии отклонено', dActive.ok === false, JSON.stringify(dActive));
const dPinned = mgr.deleteCachedVersion('0.1.7-rc.1');
check('удаление опорной версии образа отклонено', dPinned.ok === false, JSON.stringify(dPinned));
const dBad = mgr.deleteCachedVersion('../../etc');
check('недопустимый номер версии отклонён (path traversal)', dBad.ok === false, JSON.stringify(dBad));
const dHalf = mgr.deleteCachedVersion('2.0.0');
check('удаление незавершённого архива разрешено', dHalf.ok === true, JSON.stringify(dHalf));
check('после удаления 2.0.0 больше не существует', !fs.existsSync(path.join(STORE, '2.0.0')));

// ── E: политика сохранения при GC ───────────────────────────────────
console.log('\n[E] Политика сохранения при GC');
// У активной версии делаем более старый mtime, чтобы она не занимала место в keepN
// (у активной версии есть отдельная защита)
const activeDir = path.join(STORE, '1.0.0');
fs.utimesSync(activeDir, new Date(Date.now() - 9000), new Date(Date.now() - 9000));
for (const [v, ageMs] of [['1.1.0', 4000], ['1.2.0', 3000], ['1.3.0', 2000], ['1.4.0', 1000]]) {
  const dir = makeReady(v);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, t, t); // искусственно растягиваем времена LRU
}
mgr.lastKnownVersion = '1.0.0';
const gc = mgr.gcVersions({ keepN: 2, activeVersion: '1.0.0' });
check('GC возвращает ok', gc.ok === true);
check('GC сохранил активную версию 1.0.0', fs.existsSync(path.join(STORE, '1.0.0')));
check('GC сохранил keepN=2 свежайшие версии (1.4.0 / 1.3.0)', fs.existsSync(path.join(STORE, '1.4.0')) && fs.existsSync(path.join(STORE, '1.3.0')));
check('GC почистил вторую по свежести 1.2.0', !fs.existsSync(path.join(STORE, '1.2.0')));
check('GC почистил самую старую 1.1.0', !fs.existsSync(path.join(STORE, '1.1.0')));
check('GC сообщает освобождённые байты > 0', gc.freedBytes > 0, String(gc.freedBytes));
check('в список удалённых GC входит 1.1.0', gc.removed.some(r => r.version === '1.1.0'));

// Опорная версия образа должна быть защищена
makeReady('0.1.7-rc.1');
const gc2 = mgr.gcVersions({ keepN: 1, activeVersion: '1.0.0' });
check('GC никогда не чистит опорную версию образа 0.1.7-rc.1', fs.existsSync(path.join(STORE, '0.1.7-rc.1')), JSON.stringify(gc2.removed));
check('в список сохранённых GC входит версия образа', gc2.kept.includes('0.1.7-rc.1'), JSON.stringify(gc2.kept));

// dryRun ничего не пишет на диск
makeReady('1.9.0');
const before = fs.existsSync(path.join(STORE, '1.9.0'));
const gc3 = mgr.gcVersions({ keepN: 1, activeVersion: '1.0.0', dryRun: true });
check('dryRun не удаляет файлы', fs.existsSync(path.join(STORE, '1.9.0')) === before);
check('dryRun всё равно возвращает предпросмотр очистки', Array.isArray(gc3.removed));

// ── G: предварительная проверка места / защита от параллельного запуска / очистка остатков ────
console.log('\n[G] Предварительная проверка места на диске (предохранитель ENOSPC)');
const logs = [];
let threw = false;
try { mgr._assertDiskSpace([STORE], 1024 ** 5, (m) => logs.push(m)); }
catch (e) { threw = /Недостаточно дискового пространства/.test(e.message); }
check('при нехватке места брошено исключение и операция прервана (актуальное ядро не затронуто)', threw === true);
let passedOk = false;
try { mgr._assertDiskSpace([STORE], 1024, (m) => logs.push(m)); passedOk = true; } catch { passedOk = false; }
check('при достаточном места проверка проходит и печатает уровень заполнения', passedOk === true && logs.some(l => l.includes('Проверка дискового пространства пройдена')));

console.log('\n[H] Защита от параллельного запуска');
mgr.installing = true;
check('GC отклонён во время переключения', mgr.gcVersions({}).ok === false);
check('удаление отклонено во время переключения', mgr.deleteCachedVersion('1.9.0').ok === false);
mgr.installing = false;

console.log('\n[I] Очистка остатков staging');
const orphanOld = path.join(STORE, '.staging', 'orphan-old');
fs.mkdirSync(orphanOld, { recursive: true });
const oldT = new Date(Date.now() - 2 * 3600 * 1000);
fs.utimesSync(orphanOld, oldT, oldT);
mgr.cleanupStagingOrphans();
check('просроченные остатки staging удалены', !fs.existsSync(orphanOld));
const orphanFresh = path.join(STORE, '.staging', 'orphan-fresh');
fs.mkdirSync(orphanFresh, { recursive: true });
mgr.cleanupStagingOrphans();
check('не просроченный staging сохранён', fs.existsSync(orphanFresh));

console.log('\n[J] Регрессия раннего пути отказа (область видимости блока catch)');
// Был реальный дефект: tmpPrefix объявлялся внутри try и был невидим в catch → при сбое в try
// первая же строка catch `if (tmpPrefix)` бросала ReferenceError и скрывала настоящую причину сбоя.
makeReady('9.9.9');
mgr.lastKnownVersion = '1.0.0';
const origAssert = mgr._assertDiskSpace;
mgr._assertDiskSpace = () => { throw new Error('Недостаточно дискового пространства: вставка теста'); };
let r;
try { r = await mgr.installVersion('9.9.9'); } catch (e) { r = { threw: e.message }; }
mgr._assertDiskSpace = origAssert;
check('ранний отказ возвращает объект ошибки, а не ReferenceError', r && r.ok === false && !r.threw, JSON.stringify(r));
check('если актуальное ядро не трогали, выставлен флаг untouched', r && r.untouched === true, JSON.stringify(r));
check('после сбоя installing сброшен', mgr.installing === false);
check('журнал сбоев содержит настоящую причину (не скрыта)', mgr.installLog.some(l => l.includes('Недостаточно дискового пространства')), mgr.installLog.slice(-2).join(' | '));

console.log('\n[K] Статический страж области видимости (ключевые переменные объявлены вне try, иначе catch их не видит)');
const src = fs.readFileSync(new URL('../gateway/dsh-manager.js', import.meta.url), 'utf8');
const fnStart = src.indexOf('async installVersion(');
const body = src.slice(fnStart);
// Основной try идёт сразу за комментарием «Этап 1/5»; используем его как якорь (нельзя брать indexOf('try {'),
// потому что try есть и в замыканиях вроде emitProgress).
const mainTryAnchor = body.indexOf('// === Этап 1/5');
check('основной блок try в installVersion найден', fnStart > 0 && mainTryAnchor > 0);
for (const v of ['stagingDir', 'tmpPrefix', 'rollbackDir', 'coreMutated']) {
  const decl = body.indexOf(`let ${v}`);
  check(`${v} объявлен до try (виден в catch)`, decl > 0 && decl < mainTryAnchor, `decl@${decl} try@${mainTryAnchor}`);
}
// Временный каталог архива: не должен объявляться внутри try, если используется в catch
for (const v of ['archTmp']) {
  const declIdx = body.indexOf(`const ${v} =`);
  if (declIdx < 0) continue;
  const around = body.slice(declIdx, declIdx + 600);
  const catchIdx = around.indexOf('} catch (e) {');
  const useInCatch = catchIdx >= 0 && around.slice(catchIdx).includes(v);
  const declInsideTry = body.slice(Math.max(0, declIdx - 400), declIdx).lastIndexOf('try {') > body.slice(Math.max(0, declIdx - 400), declIdx).lastIndexOf('}');
  check(`${v}: если используется в catch — должен быть объявлен вне try`, !(useInCatch && declInsideTry), `useInCatch=${useInCatch} declInsideTry=${declInsideTry}`);
}

// ── L: атомарная подмена и жизненный цикл точки отката (изоляция через DSH_TEST_CORE_PARENT) ──
console.log('\n[L] Атомарная подмена и жизненный цикл точки отката');
const LIVE = path.join(CORE_PARENT, 'dsh');
const writeCore = (dir, ver) => {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: ver }));
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), `// ${ver}\n`);
};
const verOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const makeStaging = (name, ver) => {
  const d = path.join(CORE_PARENT, `.dsh-staging-${name}`);
  writeCore(d, ver);
  return d;
};

writeCore(LIVE, '9.0.0');
const rb = mgr._atomicSwapCore(makeStaging('t1', '9.1.0'));
check('подмена возвращает путь к точке отката', !!rb && fs.existsSync(rb), String(rb));
check('точка отката не удаляется до прохождения проверки активности', !!rb && fs.existsSync(rb));
check('активное ядро переключено на новую версию', verOf(LIVE) === '9.1.0');
check('в точке отката сохранена старая версия', !!rb && verOf(rb) === '9.0.0');

// Имитация «проверка активности не прошла → мгновенное восстановление из точки отката» (без архива и сети)
mgr._restoreFromRollbackDir(rb);
check('после восстановления из точки отката активное ядро вернулось к старой версии', verOf(LIVE) === '9.0.0');
check('после восстановления точка отката израсходована', !fs.existsSync(rb));

// Имитация «проверка активности прошла → точка отката очищена»
const rb2 = mgr._atomicSwapCore(makeStaging('t2', '9.2.0'));
mgr._disposeRollbackDir(rb2);
check('после успешной проверки активности точка отката очищена', !fs.existsSync(rb2));
check('после очистки активное ядро остаётся новым', verOf(LIVE) === '9.2.0');

// Имитация EXDEV на overlayfs: первый rename («переместить активное ядро в точку отката») падает,
// проверяем деградацию до «копирование + удаление» и что точка отката остаётся полным рабочим старым ядром.
const realRename = fs.renameSync;
let exdevHits = 0;
fs.renameSync = function (from, to) {
  if (from === LIVE && exdevHits === 0) {
    exdevHits++;
    const e = new Error('cross-device link not permitted');
    e.code = 'EXDEV';
    throw e;
  }
  return realRename.apply(fs, arguments);
};
let rb3 = null;
let exdevThrew = null;
try { rb3 = mgr._atomicSwapCore(makeStaging('t3', '9.3.0')); } catch (e) { exdevThrew = e.message; }
fs.renameSync = realRename;
check('EXDEV вызвал одно деградирование', exdevHits === 1, `hits=${exdevHits}`);
check('при EXDEV подмена всё равно успешна', !exdevThrew && verOf(LIVE) === '9.3.0', exdevThrew || '');
check('при EXDEV точка отката — полное старое ядро', !!rb3 && verOf(rb3) === '9.2.0', String(rb3));
mgr._restoreFromRollbackDir(rb3);
check('при EXDEV восстановление из точки отката успешно', verOf(LIVE) === '9.2.0');

// ── M: управление точкой отката движка (чередование слота, защита от ложного удаления, проверка ABI и консольные методы восстановления) ──
console.log('\n[M] Управление точкой отката движка и восстановление на месте');

// M1: исходное пустое состояние
check('в исходном состоянии точки отката нет', mgr.getRollbackPoint().exists === false);

// M2: продвижение и ограничение единственного слота
const tmp1 = path.join(CORE_PARENT, '.dsh-rollback-tmp-1');
writeCore(tmp1, '8.0.0');
mgr._promoteToPreservedRollback(tmp1, '8.0.0');
const p1 = mgr.getRollbackPoint();
check('после продвижения точка отката существует', p1.exists === true);
check('после продвижения версия равна 8.0.0', p1.version === '8.0.0');
check('после продвижения ABI совпадает', p1.abiMatches === true);
check('временный каталог перемещён и израсходован', !fs.existsSync(tmp1));
check('защищённый слот называется .dsh-rollback-preserved', path.basename(p1.path) === '.dsh-rollback-preserved');

// M3: чередование (после продвижения только что снятого ядра старый запасной экземпляр удаляется, слот всегда ≤1)
const tmp2 = path.join(CORE_PARENT, '.dsh-rollback-tmp-2');
writeCore(tmp2, '8.1.0');
mgr._promoteToPreservedRollback(tmp2, '8.1.0');
const p2 = mgr.getRollbackPoint();
check('после чередования точка отката всё ещё существует', p2.exists === true);
check('после чередования содержимое — только что снятое 8.1.0', p2.version === '8.1.0');
const allRollbacks = fs.readdirSync(CORE_PARENT).filter(n => n.startsWith('.dsh-rollback-'));
check('защищённый слот всегда ≤1 и называется .dsh-rollback-preserved', allRollbacks.length === 1 && allRollbacks[0] === '.dsh-rollback-preserved', JSON.stringify(allRollbacks));

// M4: cleanupStagingOrphans — защита от ложного удаления и очистка просроченного
const tmpExpired = path.join(CORE_PARENT, '.dsh-rollback-tmp-expired');
writeCore(tmpExpired, '7.9.0');
const pastTime = new Date(Date.now() - 2 * 3600 * 1000);
fs.utimesSync(tmpExpired, pastTime, pastTime);
fs.utimesSync(p2.path, pastTime, pastTime); // защищённый слот тоже имитируем как 2-часовой
mgr.cleanupStagingOrphans(3600 * 1000);
check('просроченный временный -tmp- очищен', !fs.existsSync(tmpExpired));
check('защищённый слот .dsh-rollback-preserved не очищен (нет ложного удаления)', fs.existsSync(p2.path));

// M5: проверка ABI / архитектуры и отказ в восстановлении
const readyPath = path.join(p2.path, '.ready');
const markerData = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
markerData.nodeAbi = '99999';
fs.writeFileSync(readyPath, JSON.stringify(markerData));
const pMismatched = mgr.getRollbackPoint();
check('при несовпадении ABI abiMatches равен false', pMismatched.abiMatches === false);
check('при несовпадении ABI canRestore равен false', pMismatched.canRestore === false);

let abiThrew = false;
try { mgr._restoreFromRollbackDir(p2.path); }
catch (e) { abiThrew = /Node ABI.*не совпадает/.test(e.message); }
check('_restoreFromRollbackDir отказывает в восстановлении при несовпадении ABI', abiThrew);

const restoreAbiFail = await mgr.restoreRollbackPoint();
check('restoreRollbackPoint отказывает в восстановлении при несовпадении ABI', restoreAbiFail.ok === false && /Node ABI.*не совпадает/.test(restoreAbiFail.error));

// M6: ручная очистка точки отката deleteRollbackPoint
markerData.nodeAbi = process.versions.modules;
fs.writeFileSync(readyPath, JSON.stringify(markerData));
const delRes = mgr.deleteRollbackPoint();
check('deleteRollbackPoint выполнен успешно', delRes.ok === true);
check('deleteRollbackPoint сообщает освобождённые байты > 0', delRes.freedBytes > 0);
check('каталог точки отката удалён', !fs.existsSync(p2.path));
check('после очистки состояние вернулось к пустому', mgr.getRollbackPoint().exists === false);
const delNonExist = mgr.deleteRollbackPoint();
check('удаление несуществующей точки отката возвращает отказ', delNonExist.ok === false && /не существует/.test(delNonExist.error));

// M7: защита от параллельного запуска
mgr.installing = true;
const delBusy = mgr.deleteRollbackPoint();
check('удаление точки отката отклонено во время переключения', delBusy.ok === false && /Идёт переключение/.test(delBusy.error));
const restoreBusy = await mgr.restoreRollbackPoint();
check('восстановление точки отката отклонено во время переключения', restoreBusy.ok === false && /уже выполняется/.test(restoreBusy.error));
mgr.installing = false;

// M8: сквозная имитация восстановления на месте (успешный сценарий + сценарий отката при сбое)
writeCore(LIVE, '8.2.0');
const tmpRestore = path.join(CORE_PARENT, '.dsh-rollback-tmp-r1');
writeCore(tmpRestore, '8.1.0');
mgr._promoteToPreservedRollback(tmpRestore, '8.1.0');
check('запасной экземпляр для восстановления готов (8.1.0)', mgr.getRollbackPoint().exists && mgr.getRollbackPoint().version === '8.1.0');

const origStop = mgr.stop;
const origRestart = mgr.restart;
mgr.stop = async () => ({ ok: true });
mgr.restart = async () => ({ ok: true });

const restoreSuccess = await mgr.restoreRollbackPoint();
check('restoreRollbackPoint возвращает успех', restoreSuccess.ok === true && restoreSuccess.version === '8.1.0');
check('активное ядро восстановлено на месте до версии-запасного 8.1.0', verOf(LIVE) === '8.1.0');
check('прежнее активное ядро (8.2.0) сохранено в защищённом слоте', mgr.getRollbackPoint().exists && mgr.getRollbackPoint().version === '8.2.0');

// Имитация неудачной проверки активности после восстановления: автоматический откат к активному ядру,
// запасной экземпляр остаётся нетронутым
mgr.restart = async () => ({ ok: false });
const restoreFail = await mgr.restoreRollbackPoint();
check('при неудачной проверке активности restoreRollbackPoint возвращает rolledBack: true', restoreFail.ok === false && restoreFail.rolledBack === true);
check('после сбоя активное ядро автоматически откатилось к прежней рабочей версии (8.1.0)', verOf(LIVE) === '8.1.0');
check('после сбоя запасной экземпляр нетронут (8.2.0 не повреждён)', mgr.getRollbackPoint().exists && mgr.getRollbackPoint().version === '8.2.0');

mgr.stop = origStop;
mgr.restart = origRestart;

// ── Очистка ──────────────────────────────────────────────────────────
fs.rmSync(STORE, { recursive: true, force: true });
fs.rmSync(CORE_PARENT, { recursive: true, force: true });

console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
if (fail > 0) { console.log('Проваленные проверки:\n - ' + failures.join('\n - ')); process.exit(1); }
