/**
 * Регрессионный тест: согласованность «единого источника данных» матрицы адаптации версий DSH.
 *
 * Предыстория: adaptedVersions раньше писался в трёх местах — version.json / version-service.js /
 * dsh-manager.js; при апгрейде до 0.1.7-alpha.1/alpha.2 про dsh-manager.js забыли, из-за чего
 * панель управления ошибочно считала текущую версию «без специальной адаптации»; при этом
 * в admin.html `hubCompatRecommended` упоминался лишь в getElementById, а соответствующего id
 * не было — «рекомендуемое ядро» навсегда висело на жёстко пробитом старом значении.
 *
 * Запуск: node scripts/version-matrix-sync-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; }
};

const meta = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
const recommended = meta?.compatibility?.recommendedDsh;
const adapted = meta?.compatibility?.adaptedVersions || [];
const dshSrc = fs.readFileSync(path.join(root, 'gateway/dsh-manager.js'), 'utf8');
const vsSrc = fs.readFileSync(path.join(root, 'gateway/version-service.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'gateway/public/admin.html'), 'utf8');

const uniq = (a) => [...new Set(a)];

console.log('\n=== A. Внутренняя согласованность version.json ===');
ok(typeof recommended === 'string' && recommended.length > 0, `recommendedDsh задан (${recommended})`);
ok(adapted.includes(recommended), `adaptedVersions содержит recommendedDsh (${recommended})`);
ok(adapted[0] === recommended, `первым в adaptedVersions стоит recommendedDsh (${adapted[0]})`);
ok(adapted.includes('0.2.1-alpha.2'), 'adaptedVersions содержит 0.2.1-alpha.2');
ok(adapted.includes('0.2.1-alpha.1'), 'adaptedVersions сохраняет предыдущую 0.2.1-alpha.1');
ok(adapted.includes('0.2.0-rc.2'), 'adaptedVersions сохраняет предыдущую 0.2.0-rc.2');
ok(adapted.includes('0.1.7-rc.2') && adapted.includes('0.1.7-rc.1') && adapted.includes('0.1.7-alpha.2') && adapted.includes('0.1.7-alpha.1'), 'adaptedVersions содержит 0.1.7-rc.2 / 0.1.7-rc.1 / 0.1.7-alpha.2 / 0.1.7-alpha.1');
ok(meta?.supply?.dshVersion && adapted.includes(meta.supply.dshVersion), `supply.dshVersion входит в список адаптированных (${meta?.supply?.dshVersion})`);

console.log('\n=== B. Фолбэк-список в dsh-manager.js обязан совпадать с version.json ===');
const dmBlock = dshSrc.match(/const DEFAULT_ADAPTED_VERSIONS = \[([\s\S]*?)\];/);
ok(Boolean(dmBlock), 'найдено определение DEFAULT_ADAPTED_VERSIONS');
const dmList = dmBlock ? uniq([...dmBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
for (const v of adapted) ok(dmList.includes(v), `фолбэк dsh-manager содержит ${v}`);
ok(dmList.includes(recommended), `фолбэк dsh-manager содержит recommendedDsh (${recommended})`);
ok(JSON.stringify(dmList) === JSON.stringify(adapted), 'фолбэк dsh-manager совпадает с version.json побайтово');

console.log('\n=== C. Фолбэк-список в version-service.js обязан совпадать с version.json ===');
const vsBlock = vsSrc.match(/adaptedVersions:\s*\[([\s\S]*?)\]/);
const vsList = vsBlock ? uniq([...vsBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
ok(vsList.includes(recommended), `фолбэк version-service getLocalMeta содержит recommendedDsh (${recommended})`);
ok(!vsList.length || vsList.every(v => adapted.includes(v)), 'в фолбэке version-service getLocalMeta нет лишних версий');
ok(JSON.stringify(vsList) === JSON.stringify(adapted), 'фолбэк version-service getLocalMeta совпадает с version.json побайтово');

const vsEvalBlock = vsSrc.match(/const adapted = m\.compatibility\?\.adaptedVersions \|\| \[([\s\S]*?)\];/);
const vsEvalList = vsEvalBlock ? uniq([...vsEvalBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
ok(vsEvalList.includes(recommended), `фолбэк version-service evaluateTargetVersion содержит recommendedDsh (${recommended})`);
ok(JSON.stringify(vsEvalList) === JSON.stringify(adapted), 'фолбэк version-service evaluateTargetVersion совпадает с version.json побайтово');

console.log('\n=== D. Фронтенд-фолбэки / статические значения по умолчанию в admin.html ===');
const fbLists = [
  ...[...adminSrc.matchAll(/const adaptedList = compat\.adaptedVersions \|\| \[([^\]]*)\]/g)].map(m => m[1]),
  ...[...adminSrc.matchAll(/availableAdaptedVersions = data\.adaptedVersions \|\| \[([^\]]*)\]/g)].map(m => m[1]),
];
ok(fbLists.length >= 3, `найдено ${fbLists.length} массивов-фолбэков adaptedVersions (ожидается ≥3)`);
for (const [i, raw] of fbLists.entries()) {
  const list = uniq([...raw.matchAll(/'([^']+)'/g)].map(m => m[1]));
  ok(list.includes(recommended), `фолбэк admin.html #${i + 1} содержит recommendedDsh`);
  ok(JSON.stringify(list) === JSON.stringify(adapted), `фолбэк admin.html #${i + 1} совпадает с version.json побайтово`);
}
for (const re of [/recommendedDsh \|\| '([^']+)'/, /supportedDshRange \|\| '([^']+)'/]) {
  const all = [...adminSrc.matchAll(new RegExp(re.source, 'g'))].map(m => m[1]);
  ok(all.length > 0 && all.every(v => !v.includes('0.2.0-rc.2') && !v.includes('<=0.2.0-rc.2')), `в фронтенд-фолбэке нет предыдущего рекомендуемого значения или старого диапазона (найдено ${all.length})`);
}
const recPattern = new RegExp(`compat\\.recommendedDsh \\|\\| '(?!${recommended.replace(/\\./g, '\\.')})`);
ok(!recPattern.test(adminSrc), `фолбэк recommendedDsh равен ${recommended}`);
const chipCount = (adminSrc.match(new RegExp(`>${recommended.replace(/\./g, '\\.')}</span>`, 'g')) || []).length;
ok(chipCount >= 2, `статически адаптированные чипы содержат ${recommended} (${chipCount} шт.)`);
// Регрессия: при апгрейде рекомендуемого ядра новый добавляется «сверху», а НЕ заменяет
// предыдущую рекомендацию, — иначе на статичной странице холодного старта (до прихода API)
// не будет видно предыдущее глубоко адаптированное ядро.
const prevRecommended = '0.2.0-rc.2';
const prevChipCount = (adminSrc.match(new RegExp(`>${prevRecommended.replace(/\./g, '\\.')}</span>`, 'g')) || []).length;
ok(prevChipCount >= 2, `статически адаптированные чипы сохраняют предыдущую рекомендацию ${prevRecommended} (${prevChipCount} шт.)`);

console.log('\n=== E. Каждый getElementById в admin.html обязан иметь соответствующий id ===');
const ids = new Set([...adminSrc.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const refs = uniq([...adminSrc.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
// Разрешённый список: settingsTab — это осознанный фолбэк
// `getElementById('settingsTab') || getElementById('tab-settings')`;
// отсутствие элемента здесь ожидаемо.
const OPTIONAL_IDS = new Set(['settingsTab']);
const missing = refs.filter(r => !ids.has(r) && !OPTIONAL_IDS.has(r));
ok(missing.length === 0, `нет «висячих» ссылок${missing.length ? ' -> ' + missing.join(', ') : ''}`);
ok(ids.has('hubCompatRecommended'), 'id="hubCompatRecommended" существует (рекомендуемое ядро обновляемо)');

console.log(`\n[version-matrix-sync] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
