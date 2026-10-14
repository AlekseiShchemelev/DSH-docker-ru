/**
 * Быстрый регрессионный тест: вычисление составных диапазонов в gateway/version-service.js
 * + рефакторинг поверхности экспорта.
 *
 * Покрытие:
 *   1. satisfiesRange для `>=0.1.2-rc.1 <=0.2.1-alpha.2` (0.2.1-alpha.2 IN; 0.2.1-alpha.1 IN;
 *      0.2.0-rc.2 IN; 0.2.0-rc.1 IN; 0.1.7-rc.2 IN; 0.2.1 / 0.2.2 / 0.3.0 OUT)
 *   2. исправление составного AND в matchSemverPattern (0.2.2 / 0.3.0 больше не распознаются как true)
 *   3. выражения из одного term и разбиение по нескольким пробелам, поддержка pre-release в isSemver
 *   4. обратная совместимость: экспорт по умолчанию — синглтон
 *      (getLiveMeta / evaluateTargetVersion / check и т.п. остаются доступными)
 *   5. новая возможность: именованный destructuring-экспорт ({ satisfiesRange, compareSemver } и др.)
 *   6. интеграция: evaluateTargetVersion('0.3.0') попадает в жёсткую блокировку danger
 *
 * Запуск: node scripts/version-range-fix-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; }
};
const eq = (actual, expected, msg) => ok(actual === expected, `${msg} (ожидается ${expected}, факт ${actual})`);

const RANGE = '>=0.1.2-rc.1 <=0.2.1-alpha.2';

// ── Экспорт по умолчанию — синглтон (путь обратной совместимости) ─────────────────────────────
const versionService = require('../gateway/version-service');
// ── Именованный destructuring-экспорт (путь новой возможности) ─────────────────────────────────
const { parseSemver, isSemver, compareSemver, matchSemverPattern, satisfiesRange } = versionService;

console.log('\n=== A. Экспорт по умолчанию — синглтон, обратная совместимость ===');
ok(versionService && typeof versionService === 'object', 'require() возвращает объект-синглтон');
ok(typeof versionService.getLiveMeta === 'function', 'versionService.getLiveMeta() доступен');
ok(typeof versionService.getLocalProjectVersion === 'function', 'versionService.getLocalProjectVersion() доступен');
ok(typeof versionService.evaluateTargetVersion === 'function', 'versionService.evaluateTargetVersion() доступен');
ok(typeof versionService.isUsingRemoteMeta === 'function', 'versionService.isUsingRemoteMeta() доступен');
ok(typeof versionService.check === 'function', 'versionService.check() доступен');
const live = versionService.getLiveMeta();
ok(live && live.compatibility && live.compatibility.supportedDshRange === RANGE,
  `getLiveMeta() работает, supportedDshRange = ${live?.compatibility?.supportedDshRange}`);

console.log('\n=== B. Именованный destructuring-экспорт ===');
ok(typeof satisfiesRange === 'function', 'destructuring satisfiesRange доступен');
ok(typeof parseSemver === 'function', 'destructuring parseSemver доступен');
ok(typeof isSemver === 'function', 'destructuring isSemver доступен');
ok(typeof compareSemver === 'function', 'destructuring compareSemver доступен');
ok(typeof matchSemverPattern === 'function', 'destructuring matchSemverPattern доступен');
ok(satisfiesRange === versionService.satisfiesRange, 'destructuring-функция и свойство синглтона — одна и та же ссылка (без дублирования реализации)');

console.log('\n=== C. Определение составного диапазона satisfiesRange (ядро фикса) ===');
eq(satisfiesRange('0.2.0-rc.1', RANGE), true,  '0.2.0-rc.1 IN');
eq(satisfiesRange('0.2.1-alpha.2', RANGE), true,  '0.2.1-alpha.2 IN (верхняя граница, замкнутый интервал)');
eq(satisfiesRange('0.2.1-alpha.1', RANGE), true,  '0.2.1-alpha.1 IN (предыдущая рекомендация, всё ещё в диапазоне)');
eq(satisfiesRange('0.2.1-alpha.3', RANGE), false, '0.2.1-alpha.3 OUT (выше верхней границы)');
eq(satisfiesRange('0.2.0-rc.2', RANGE), true,  '0.2.0-rc.2 IN (предыдущая рекомендация, всё ещё в диапазоне)');
eq(satisfiesRange('0.1.7-rc.2', RANGE), true,  '0.1.7-rc.2 IN');
eq(satisfiesRange('0.2.0',      RANGE), true,  '0.2.0 IN (<=0.2.1-alpha.2, верхняя граница поднята, включена)');
eq(satisfiesRange('0.2.1',      RANGE), false, '0.2.1 OUT (стабильная выше 0.2.1-alpha.2)');
eq(satisfiesRange('0.2.2',      RANGE), false, '0.2.2 OUT');
eq(satisfiesRange('0.3.0',      RANGE), false, '0.3.0 OUT');
// граничные дополнения
eq(satisfiesRange('0.1.2-rc.1', RANGE), true,  '0.1.2-rc.1 IN (нижняя граница, замкнутый интервал)');
eq(satisfiesRange('0.1.2',      RANGE), true,  '0.1.2 IN (> 0.1.2-rc.1)');
eq(satisfiesRange('0.1.1',      RANGE), false, '0.1.1 OUT (ниже нижней границы)');
eq(satisfiesRange('0.1.7-rc.3', RANGE), true,  '0.1.7-rc.3 IN');
eq(satisfiesRange('0.1.8',      RANGE), true,  '0.1.8 IN');
eq(satisfiesRange('v0.2.0-rc.1', RANGE), true, 'с префиксом v 0.2.0-rc.1 IN');
// недопустимый ввод и пустые значения обязаны безопасно вернуть false
eq(satisfiesRange('not-a-version', RANGE), false, 'недопустимая версия → false');
eq(satisfiesRange('0.2.0-rc.1', ''), false, 'пустой диапазон → false');
eq(satisfiesRange('', RANGE), false, 'пустая версия → false');

console.log('\n=== D. Исправление составного AND в matchSemverPattern ===');
eq(matchSemverPattern('0.2.0', RANGE), true, 'matchSemverPattern(0.2.0, составной диапазон) = true (верхняя граница поднята, включено)');
eq(matchSemverPattern('0.2.1', RANGE), false, 'matchSemverPattern(0.2.1, составной диапазон) исправлен на false');
eq(matchSemverPattern('0.2.2', RANGE), false, 'matchSemverPattern(0.2.2, составной диапазон) исправлен на false');
eq(matchSemverPattern('0.3.0', RANGE), false, 'matchSemverPattern(0.3.0, составной диапазон) исправлен на false');
eq(matchSemverPattern('0.2.0-rc.1', RANGE), true, 'matchSemverPattern(0.2.0-rc.1, составной диапазон) = true');
eq(matchSemverPattern('0.1.7-rc.2', RANGE), true, 'matchSemverPattern(0.1.7-rc.2, составной диапазон) = true');
// семантика одного term регрессировать не должна
eq(matchSemverPattern('0.1.4', '<0.1.5-rc.1'), true,  'один term <0.1.5-rc.1: 0.1.4 попадает');
eq(matchSemverPattern('0.1.5-rc.1', '<0.1.5-rc.1'), false, 'один term <0.1.5-rc.1: 0.1.5-rc.1 не попадает');
eq(matchSemverPattern('0.3.0', '>=0.3.0'), true,  'один term >=0.3.0: 0.3.0 попадает');
eq(matchSemverPattern('0.2.0', '>=0.3.0'), false, 'один term >=0.3.0: 0.2.0 не попадает');
eq(matchSemverPattern('0.1.5-rc.2', '=0.1.5-rc.2'), true, 'один term = точное совпадение');
eq(matchSemverPattern('0.1.5-rc.2', '0.1.5-rc.2'), true, 'голая версия — точное совпадение');
// разбиение по нескольким пробелам / Tab
eq(matchSemverPattern('0.2.2', '>=0.1.2-rc.1    <=0.2.1-alpha.2'), false, 'разбиение по нескольким пробелам: 0.2.2 OUT');
eq(satisfiesRange('0.2.2', '\t>=0.1.2-rc.1\t<=0.2.1-alpha.2\n'), false, 'разбиение по Tab/переводу строки: 0.2.2 OUT');
eq(satisfiesRange('0.2.1-alpha.2', '  >=0.1.2-rc.1   <=0.2.1-alpha.2  '), true, 'толерантность к ведущим/замыкающим пробелам: 0.2.1-alpha.2 IN');

console.log('\n=== E. Поддержка pre-release в isSemver ===');
ok(isSemver('0.2.0-rc.1'), 'isSemver("0.2.0-rc.1") = true');
ok(isSemver('0.1.7-rc.2'), 'isSemver("0.1.7-rc.2") = true');
ok(isSemver('v0.2.0-rc.1'), 'isSemver("v0.2.0-rc.1") = true');
ok(isSemver('0.1.7-alpha.10'), 'isSemver("0.1.7-alpha.10") = true');
ok(!isSemver('0.2.0-'), 'isSemver("0.2.0-") = false (пустой pre-release отклоняется)');
ok(!isSemver('0.2'), 'isSemver("0.2") = false');
ok(!isSemver('1.2.3+build'), 'isSemver не поддерживает build-metadata (известная граница, false)');

console.log('\n=== F. Интеграция: жёсткая блокировка evaluateTargetVersion ===');
const danger = versionService.evaluateTargetVersion('0.3.0');
eq(danger.level, 'danger', '0.3.0 → срабатывает правило danger');
eq(danger.action, 'force-docker-pull', '0.3.0 → force-docker-pull');
const okRc1 = versionService.evaluateTargetVersion('0.2.0-rc.1');
eq(okRc1.level, 'success', '0.2.0-rc.1 → официальная глубокая адаптация success');
const okRc17 = versionService.evaluateTargetVersion('0.1.7-rc.2');
eq(okRc17.level, 'success', '0.1.7-rc.2 → официальная глубокая адаптация success');
const okRc2 = versionService.evaluateTargetVersion('0.2.0-rc.2');
eq(okRc2.level, 'success', '0.2.0-rc.2 → официальная глубокая адаптация success');
const okA1 = versionService.evaluateTargetVersion('0.2.1-alpha.1');
eq(okA1.level, 'success', '0.2.1-alpha.1 → официальная глубокая адаптация success');
eq(okA1.isAdapted, true, '0.2.1-alpha.1 → isAdapted=true');
const okA2 = versionService.evaluateTargetVersion('0.2.1-alpha.2');
eq(okA2.level, 'success', '0.2.1-alpha.2 → официальная глубокая адаптация success');
eq(okA2.isAdapted, true, '0.2.1-alpha.2 → isAdapted=true');
const warnLow = versionService.evaluateTargetVersion('0.1.4');
eq(warnLow.level, 'warning', '0.1.4 → warning (риск формата при даунгрейде)');

console.log(`\n[version-range-fix] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
