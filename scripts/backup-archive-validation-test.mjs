/**
 * Регресс S2: проверка белого списка членов архива снимка.
 * Использование: node scripts/backup-archive-validation-test.mjs
 *
 * Временно конструирует несколько архивов (включая вредоносные члены) и проверяет
 * отклонение/разрешение со стороны validateArchiveMembers.
 *
 * Кейсы, добавленные в Issue #8 (G/H/I/J/K/L), фиксируют три регрессии:
 *   - легитимные снимки с жёсткими ссылками должны разрешаться (GNU tar печатает ` link to ` / китайский ` 连接到 `, старый код понимал только ` -> `);
 *   - легитимные большие снимки с verbose-перечнем > 8 MiB должны разрешаться (старый код по байтовому пределу 8 MiB помечал нормальные снимки как «повреждённые»);
 *   - после смягчения сохраняется fail-closed: побег цели жёсткой ссылки и члены, вложенные под символической ссылкой, должны отклоняться.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { validateArchiveMembers, classifyArchiveMemberLine, repairEscapingRelativeLinks } = require(path.join(here, '../gateway/backup-service.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-arch-'));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };

function tar(args, cwd) {
  return spawnSync('tar', args, { cwd, encoding: 'utf8' });
}

// ── Вручную написанный минимальный tar: конструирует члены, которые неудобно строить GNU tar (произвольная цель жёсткой ссылки / вложенность символических ссылок) ─────────
const BLOCK = 512;
const octalField = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';

function tarHeader({ name, size, typeflag, linkname }) {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octalField(0o644, 8), 100, 8, 'ascii');   // mode
  buf.write(octalField(0, 8), 108, 8, 'ascii');       // uid
  buf.write(octalField(0, 8), 116, 8, 'ascii');       // gid
  buf.write(octalField(size, 12), 124, 12, 'ascii');  // size
  buf.write(octalField(0, 12), 136, 12, 'ascii');     // mtime
  buf.write('        ', 148, 8, 'ascii');             // chksum — заглушка (сначала пробелы)
  buf.write(typeflag, 156, 1, 'ascii');
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function writeRawTarGz(file, members) {
  const chunks = [];
  for (const m of members) {
    const data = Buffer.from(m.data ?? '', 'utf8');
    chunks.push(tarHeader({
      name: m.name,
      size: data.length,
      typeflag: m.typeflag ?? '0',
      linkname: m.linkname ?? ''
    }));
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
      data.copy(padded);
      chunks.push(padded);
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(chunks)));
}

async function expectReject(file, label, opts) {
  try {
    await validateArchiveMembers(file, opts);
    ok(false, `${label} (должен был быть отклонён, но прошёл)`);
  } catch (e) {
    ok(true, `${label} → отклонён: ${e.message.slice(0, 60)}`);
  }
}

async function main() {
  // ---- Нормальный архив: под .dsh/ ----
  const good = path.join(TMP, 'good');
  fs.mkdirSync(path.join(good, '.dsh', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(good, '.dsh', 'settings.yaml'), 'a: 1\n');
  fs.writeFileSync(path.join(good, '.dsh', 'profiles', 'web.json'), '{}\n');
  const goodTar = path.join(TMP, 'good.tar.gz');
  tar(['-czf', goodTar, '-C', good, '.dsh']);

  console.log('\n=== A. Нормальный снимок должен пройти ===');
  try {
    const r = await validateArchiveMembers(goodTar);
    ok(r.members >= 3, `нормальный архив прошёл (членов: ${r.members})`);
  } catch (e) { ok(false, 'нормальный архив был ошибочно отклонён: ' + e.message); }

  // ---- Злой 1: член вне .dsh/ (.ssh/authorized_keys) ----
  const esc = path.join(TMP, 'esc');
  fs.mkdirSync(path.join(esc, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(esc, '.ssh', 'authorized_keys'), 'ssh-rsa AAAA\n');
  const escTar = path.join(TMP, 'esc.tar.gz');
  tar(['-czf', escTar, '-C', esc, '.ssh']);
  console.log('\n=== B. Член за пределами (.ssh/authorized_keys) ===');
  await expectReject(escTar, 'член за префиксом .dsh/');

  // ---- Злой 2: член с абсолютным путём ----
  fs.writeFileSync(path.join(TMP, 'abs.txt'), 'x\n');
  const absTar = path.join(TMP, 'abs.tar.gz');
  tar(['-czPf', absTar, '-C', TMP, path.join(TMP, 'abs.txt')]);
  console.log('\n=== C. Член с абсолютным путём ===');
  await expectReject(absTar, 'член с абсолютным путём');

  // ---- Злой 3: член-символическая ссылка ----
  const sl = path.join(TMP, 'sl');
  fs.mkdirSync(path.join(sl, '.dsh'), { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(sl, '.dsh', 'link'));
  const slTar = path.join(TMP, 'sl.tar.gz');
  tar(['-czf', slTar, '-C', sl, '.dsh']);
  console.log('\n=== D. Член-символическая ссылка ===');
  await expectReject(slTar, 'член-символическая ссылка');

  // ---- Злой 4: сегмент пути `..` (конструируем через transform; если не вышло — пропускаем) ----
  const dd = path.join(TMP, 'dd');
  fs.mkdirSync(path.join(dd, '.dsh'), { recursive: true });
  fs.writeFileSync(path.join(dd, '.dsh', 'evil'), 'x\n');
  const ddTar = path.join(TMP, 'dd.tar.gz');
  const ddRes = tar(['-czf', ddTar, '--transform=s|^\\.dsh/|.dsh/../|', '-C', dd, '.dsh/evil']);
  console.log('\n=== E. Сегмент пути `..` ===');
  if (ddRes.status === 0 && fs.existsSync(ddTar)) {
    await expectReject(ddTar, 'член, содержащий сегмент ..');
  } else {
    console.log('   (tar отказался конструировать член с .., кейс пропущен)');
  }

  // ---- Легитимно: символическая ссылка на место установки зависимости (в снимках проекта реально встречается) ----
  const okLink = path.join(TMP, 'oklink');
  fs.mkdirSync(path.join(okLink, '.dsh', 'profiles', 'web', 'node_modules'), { recursive: true });
  fs.symlinkSync('/usr/local/lib/node_modules/dshmarket', path.join(okLink, '.dsh', 'profiles', 'web', 'node_modules', 'dshmarket'));
  const okLinkTar = path.join(TMP, 'oklink.tar.gz');
  tar(['-czf', okLinkTar, '-C', okLink, '.dsh']);
  console.log('\n=== D2. Легитимная символическая ссылка (на место установки зависимости) должна пройти ===');
  try {
    const r2 = await validateArchiveMembers(okLinkTar);
    ok(r2.members >= 1, `легитимная символическая ссылка прошла (членов: ${r2.members})`);
  } catch (e) { ok(false, 'легитимная символическая ссылка была ошибочно отклонена: ' + e.message); }

  // ---- Злой 5: повреждённый / не-архивный файл ----
  const broken = path.join(TMP, 'broken.tar.gz');
  fs.writeFileSync(broken, 'not a gzip');
  console.log('\n=== F. Повреждённый файл ===');
  await expectReject(broken, 'повреждённый / не-архивный файл');

  // ================= Регресс Issue #8 (G/H/I) и регресс безопасности после смягчения (J/K/L) ==================

  // ---- G. Жёсткие ссылки: легитимный снимок должен пройти ----
  const hl = path.join(TMP, 'hl');
  fs.mkdirSync(path.join(hl, '.dsh'), { recursive: true });
  fs.writeFileSync(path.join(hl, '.dsh', 'a.txt'), 'same content\n');
  fs.linkSync(path.join(hl, '.dsh', 'a.txt'), path.join(hl, '.dsh', 'b.txt'));
  const hlTar = path.join(TMP, 'hl.tar.gz');
  tar(['-czf', hlTar, '-C', hl, '.dsh']);
  console.log('\n=== G. Члены-жёсткие ссылки (регресс Issue #8: старая реализация отклоняла 100%) ===');
  try {
    const r = await validateArchiveMembers(hlTar);
    ok(r.hardLinks >= 1, `легитимный снимок с жёсткими ссылками прошёл (членов: ${r.members}, жёстких ссылок: ${r.hardLinks})`);
  } catch (e) { ok(false, 'легитимный снимок с жёсткими ссылками был ошибочно отклонён: ' + e.message); }

  // ---- H. verbose-перечень > 8 MiB: легитимный большой снимок должен пройти ----
  console.log('\n=== H. verbose-перечень > 8 MiB (ключевой регресс Issue #8: старая реализация сообщала «вывод превысил предел») ===');
  const deepRoot = path.join(TMP, 'deep');
  let deep = path.join(deepRoot, '.dsh', 'profiles', 'web', 'node_modules');
  for (let i = 0; i < 6; i++) deep = path.join(deep, 'pkg-' + 'x'.repeat(200));
  fs.mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 7500; i++) {
    fs.writeFileSync(path.join(deep, `module-${String(i).padStart(5, '0')}-${'y'.repeat(50)}.js`), 'x');
  }
  const bigTar = path.join(TMP, 'big.tar.gz');
  tar(['-czf', bigTar, '-C', deepRoot, '.dsh']);
  try {
    const r = await validateArchiveMembers(bigTar);
    ok(r.listingBytes > 8 * 1024 * 1024,
      `перечень ${(r.listingBytes / 1048576).toFixed(1)} MiB (> 8 MiB) всё равно прошёл, членов: ${r.members}`);
  } catch (e) { ok(false, 'большой снимок был ошибочно отклонён: ' + e.message); }

  // ---- I. Предел числа членов: настраиваемый, и формулировка не должна лгать «файл повреждён» ----
  console.log('\n=== I. Предел числа членов и формулировка ===');
  try {
    await validateArchiveMembers(goodTar, { maxMembers: 2 });
    ok(false, 'превысил предел числа членов, но прошёл');
  } catch (e) {
    ok(/превысило предел/.test(e.message) && !/повреждён|поврежден/.test(e.message),
      'отклонён с различимой формулировкой (больше не говорит «файл повреждён»): ' + e.message.slice(0, 46));
  }

  // ---- J. Вредоносная цель жёсткой ссылки должна отклоняться ----
  console.log('\n=== J. Вредоносная цель жёсткой ссылки (регресс безопасности после смягчения жёстких ссылок) ===');
  const hlRel = path.join(TMP, 'hlrel.tar.gz');
  writeRawTarGz(hlRel, [{ name: '.dsh/evil', typeflag: '1', linkname: '../../etc/passwd' }]);
  await expectReject(hlRel, 'цель жёсткой ссылки с побегом `..`');
  const hlAbs = path.join(TMP, 'hlabs.tar.gz');
  writeRawTarGz(hlAbs, [{ name: '.dsh/evil', typeflag: '1', linkname: '/etc/passwd' }]);
  await expectReject(hlAbs, 'цель жёсткой ссылки — абсолютный путь вне `.dsh/`');

  // ---- K. Члены, вложенные под символической ссылкой, должны отклоняться (глубокая защита) ----
  console.log('\n=== K. Член под символической ссылкой ===');
  const nested = path.join(TMP, 'nested.tar.gz');
  writeRawTarGz(nested, [
    // цель самой символической ссылки попадает в белый список; если смотреть только «законна ли цель» — пропустили бы весь архив
    { name: '.dsh/link', typeflag: '2', linkname: '/usr/local/lib/node_modules/whatever' },
    { name: '.dsh/link/pwned.txt', typeflag: '0', data: 'PWNED\n' }
  ]);
  await expectReject(nested, 'член под символической ссылкой');

  // ---- L. Юнит-утверждения уровня разбора ----
  console.log('\n=== L. Юнит-утвердения разбора (имя не обрезается / две формулировки жёстких ссылок) ===');
  try {
    classifyArchiveMemberLine('drwxr-xr-x root/root 0 2026-01-01 00:00 .dsh/a link to ../../etc');
    ok(false, '`../..` в имени каталога был обрезан и пропущен');
  } catch (e) {
    ok(/недопустимый сегмент пути/.test(e.message), 'обычное имя члена с ` link to ../..` не обрезается → отклонён');
  }
  const cHard = classifyArchiveMemberLine('hrw-r--r-- root/root 0 2026-01-01 00:00 .dsh/a.txt link to .dsh/b.txt');
  ok(cHard && cHard.type === 'hardlink' && cHard.name === '.dsh/a.txt', 'формулировка жёсткой ссылки в локали C разбирается');
  const zHard = classifyArchiveMemberLine('hrw-r--r-- root/root 0 2026-01-01 00:00 .dsh/a.txt 连接到 .dsh/b.txt');
  ok(zHard && zHard.type === 'hardlink' && zHard.name === '.dsh/a.txt', 'формулировка жёсткой ссылки в локали zh_CN разбирается');
  const fileWithArrow = classifyArchiveMemberLine('-rw-r--r-- root/root 1 2026-01-01 00:00 .dsh/a -> b.txt');
  ok(fileWithArrow && fileWithArrow.name === '.dsh/a -> b.txt', 'обычное имя члена с ` -> ` не обрезается');

  // ---- M. Абсолютная символическая ссылка на «корень самого архива» (реальная форма .dsh-module-fallback) ----
  console.log('\n=== M. Абсолютная символическая ссылка на корень самого архива (старая реализация отклоняла весь пакет) ===');
  const dshHome = process.env.DSH_HOME || '/root';
  const dshAbs = (rel) => path.posix.join(dshHome, '.dsh', rel);
  const mfTar = path.join(TMP, 'module-fallback.tar.gz');
  writeRawTarGz(mfTar, [{
    name: '.dsh/profiles/web/.dsh-module-fallback/node_modules/d3-hiera',
    typeflag: '2',
    linkname: dshAbs('profiles/web/node_modules/d3-hiera')
  }]);
  try {
    const r = await validateArchiveMembers(mfTar);
    ok(r.symLinks === 1, 'символическая ссылка на <DSH_HOME>/.dsh/... прошла (обязательна для настоящих старых снимков)');
  } catch (e) { ok(false, 'символическая ссылка на корень самого архива была ошибочно отклонена: ' + e.message); }

  const mfEscTar = path.join(TMP, 'module-fallback-esc.tar.gz');
  writeRawTarGz(mfEscTar, [{
    name: '.dsh/profiles/web/.dsh-module-fallback/node_modules/d3-hiera',
    typeflag: '2',
    linkname: `${dshHome}/.dsh/../../../etc/passwd`   // после нормализации выходит за пределы .dsh/
  }]);
  await expectReject(mfEscTar, 'символическая ссылка под корнем архива с побегом из .dsh/ через `..`');

  // ============ Следующие кейсы из независимой адверсариальной верификации (doc/issue-8/verification-adversarial.md) ============

  // ---- N. Возврат префикса цели символической ссылки: сначала нормализация, затем сравнение с префиксом белого списка ----
  console.log('\n=== N. Возврат префикса цели символической ссылки (`/opt/../etc/passwd`) ===');
  const pfx1 = path.join(TMP, 'pfx1.tar.gz');
  writeRawTarGz(pfx1, [{ name: '.dsh/link', typeflag: '2', linkname: '/opt/../etc/passwd' }]);
  await expectReject(pfx1, 'цель символической ссылки, выходящая из /opt/ после нормализации');
  const pfx2 = path.join(TMP, 'pfx2.tar.gz');
  writeRawTarGz(pfx2, [{ name: '.dsh/link', typeflag: '2', linkname: '/app/plugins/../../etc/shadow' }]);
  await expectReject(pfx2, 'цель символической ссылки, выходящая из /app/plugins/ после нормализации');
  const pfxOk = path.join(TMP, 'pfxok.tar.gz');
  writeRawTarGz(pfxOk, [{ name: '.dsh/link', typeflag: '2', linkname: '/opt/x/../y' }]);
  try {
    await validateArchiveMembers(pfxOk);
    ok(true, 'цель, остающаяся внутри /opt/ после нормализации, проходит как обычно (без ложного срабатывания)');
  } catch (e) { ok(false, 'легитимная цель /opt была ошибочно отклонена: ' + e.message); }

  // ---- O. Инъекция разделителя ссылки: при ` -> ` в имени не должно быть жадного разреза ----
  console.log('\n=== O. Инъекция ` -> ` в имя члена для обмана парсера ===');
  const inj = path.join(TMP, 'inject.tar.gz');
  writeRawTarGz(inj, [{ name: '.dsh/leak -> dummy', typeflag: '2', linkname: '/etc/passwd' }]);
  await expectReject(inj, 'символическая ссылка с ` -> ` в имени (неоднозначность разделителя → fail-closed)');

  // ---- P. Жёсткая ссылка наследует семантику символической ----
  console.log('\n=== P. Жёсткая ссылка на символическую, за ней дочерний член ===');
  const hlSym = path.join(TMP, 'hlsym.tar.gz');
  writeRawTarGz(hlSym, [
    { name: '.dsh/sym', typeflag: '2', linkname: '/usr/local/lib/node_modules/ok' },
    { name: '.dsh/h4', typeflag: '1', linkname: '.dsh/sym' },
    { name: '.dsh/h4/evil.txt', typeflag: '0', data: 'x' }
  ]);
  await expectReject(hlSym, 'член под символической, унаследованной через жёсткую ссылку');

  // ---- Q. Обратная вложенность: потоковый однопроходный разбор не может предсказать «позднюю» символическую, компенсирующий контроль держит распаковка fail-closed ----
  console.log('\n=== Q. Компенсирующий контроль обратной вложенности (сначала дочерний член, потом символическая) ===');
  const rev = path.join(TMP, 'reverse.tar.gz');
  writeRawTarGz(rev, [
    { name: '.dsh/link/pwned.txt', typeflag: '0', data: 'PWNED\n' },
    { name: '.dsh/link', typeflag: '2', linkname: '/usr/local/lib/node_modules/ok' }
  ]);
  let revAccepted = false;
  try { await validateArchiveMembers(rev); revAccepted = true; } catch { /* отклонение вопреки ожиданиям тоже допустимо */ }
  const stage = path.join(TMP, 'revstage');
  fs.mkdirSync(stage, { recursive: true });
  const extract = tar(['-xzf', rev, '-C', stage]);
  ok(extract.status !== 0,
    `слой проверки пропустил=${revAccepted}, но распаковка tar должна провалиться (restore тут же откатит): exit=${extract.status}`);

  // ---- R. Сам корневой каталог архива не должен быть членом-ссылкой (обнаружено при адверсариальной верификации второго раунда) ----
  console.log('\n=== R. Сам `.dsh` подделан под символическую ссылку ===');
  const rootLink = path.join(TMP, 'rootlink.tar.gz');
  writeRawTarGz(rootLink, [{ name: '.dsh', typeflag: '2', linkname: '/opt/my-tool' }]);
  await expectReject(rootLink, 'корень архива `.dsh` — символическая ссылка');
  const rootLinkSlash = path.join(TMP, 'rootlinkslash.tar.gz');
  writeRawTarGz(rootLinkSlash, [{ name: '.dsh/', typeflag: '2', linkname: '/opt/my-tool' }]);
  await expectReject(rootLinkSlash, 'корень архива `.dsh/` — символическая ссылка');
  const rootDir = path.join(TMP, 'rootdir.tar.gz');
  writeRawTarGz(rootDir, [{ name: '.dsh/', typeflag: '5' }]);
  try {
    await validateArchiveMembers(rootDir);
    ok(true, 'нормальный член-каталог `.dsh/` проходит как обычно (без ложного срабатывания)');
  } catch (e) { ok(false, 'нормальный член-каталог `.dsh/` был ошибочно отклонён: ' + e.message); }

  // ---- S. Issue #9: относительная символическая ссылка «выходит за корень архива» (pnpm создаёт такие для зависимостей `link:`) ----
  // В старых снимках `.dsh/profiles/web/node_modules/<pkg>` — это символическая ссылка с относительной целью, созданная pnpm;
  // в виде архива она уходит вверх за корень `.dsh/`; но после пересчёта на реальное место восстановления она указывает
  // именно на каталог из белого списка — по уровню доверия эквивалентна «записанной абсолютным путём» → должна проходить
  // (старая реализация отклоняла 100%).
  console.log('\n=== S. Issue #9: относительная символическая ссылка, выходящая за корень архива ===');
  const relDshmarket = '../../../../../usr/local/lib/node_modules/dshmarket';
  const relOk = path.join(TMP, 'rel-ok.tar.gz');
  writeRawTarGz(relOk, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/profiles/', typeflag: '5' },
    { name: '.dsh/profiles/web/', typeflag: '5' },
    { name: '.dsh/profiles/web/node_modules/', typeflag: '5' },
    { name: '.dsh/profiles/web/node_modules/dshmarket', typeflag: '2', linkname: relDshmarket }
  ]);
  try {
    const r = await validateArchiveMembers(relOk);
    ok(r.symLinks === 1, `относительная символическая, выходящая за корень архива, но попавшая в белый список зависимостей, прошла (symLinks=${r.symLinks})`);
  } catch (e) { ok(false, 'относительная символическая, выходящая за корень архива, но попавшая в белый список зависимостей, была ошибочно отклонена: ' + e.message); }

  const relOpt = path.join(TMP, 'rel-opt.tar.gz');
  writeRawTarGz(relOpt, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/bin/', typeflag: '5' },
    { name: '.dsh/bin/helper', typeflag: '2', linkname: '../../../opt/tools/helper' }
  ]);
  try {
    const r = await validateArchiveMembers(relOpt);
    ok(r.symLinks === 1, `относительная символическая, выходящая за корень архива и попавшая в белый список /opt/, прошла (symLinks=${r.symLinks})`);
  } catch (e) { ok(false, 'относительная символическая из белого списка /opt/ была ошибочно отклонена: ' + e.message); }

  const relDeep = path.join(TMP, 'rel-deep.tar.gz');
  writeRawTarGz(relDeep, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/profiles/web/node_modules/dshmarket', typeflag: '2', linkname: '../../../../../../../../../../usr/local/lib/node_modules/dshmarket' }
  ]);
  try {
    const r = await validateArchiveMembers(relDeep);
    ok(r.symLinks === 1, `сверхглубокие .. после обрезки на корне системы всё равно разрешаются в белый список → прошла (symLinks=${r.symLinks})`);
  } catch (e) { ok(false, 'легитимная относительная символическая со сверхглубокими .. была ошибочно отклонена: ' + e.message); }

  const relInside = path.join(TMP, 'rel-inside.tar.gz');
  writeRawTarGz(relInside, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/profiles/web/node_modules/', typeflag: '5' },
    { name: '.dsh/profiles/web/node_modules/foo', typeflag: '2', linkname: '../bar' }
  ]);
  try {
    const r = await validateArchiveMembers(relInside);
    ok(r.symLinks === 1, `относительная символическая внутри архива (не выходит наружу) проходит как обычно (symLinks=${r.symLinks})`);
  } catch (e) { ok(false, 'относительная символическая внутри архива была ошибочно отклонена: ' + e.message); }

  const relBack = path.join(TMP, 'rel-back.tar.gz');
  writeRawTarGz(relBack, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/a/', typeflag: '5' },
    { name: '.dsh/a/link', typeflag: '2', linkname: '../../../root/.dsh/profiles/web' }
  ]);
  try {
    const r = await validateArchiveMembers(relBack);
    ok(r.symLinks === 1, `после выхода наружу относительно указывает обратно на корень самого архива → прошла (symLinks=${r.symLinks})`);
  } catch (e) { ok(false, 'относительная символическая, указывающая обратно на корень архива, была ошибочно отклонена: ' + e.message); }

  // Контрпример: убегающая относительная символическая **должна** по-прежнему быть fail-closed
  const relEtc = path.join(TMP, 'rel-etc.tar.gz');
  writeRawTarGz(relEtc, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/profiles/web/node_modules/evil', typeflag: '2', linkname: relDshmarket.replace('/usr/local/lib/node_modules/dshmarket', '/etc/passwd') }
  ]);
  await expectReject(relEtc, 'относительный побег, указывающий на /etc/passwd');

  const relShadow = path.join(TMP, 'rel-shadow.tar.gz');
  writeRawTarGz(relShadow, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/bin/evil', typeflag: '2', linkname: '../../../opt/../etc/shadow' }
  ]);
  await expectReject(relShadow, 'относительный побег через префикс /opt/ до /etc/shadow');

  const relSsh = path.join(TMP, 'rel-ssh.tar.gz');
  writeRawTarGz(relSsh, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/evil', typeflag: '2', linkname: '../../../../root/.ssh/id_rsa' }
  ]);
  await expectReject(relSsh, 'относительный побег, указывающий на /root/.ssh/id_rsa');

  // Контрпример: член, вложенный под «пропущенной убегающей относительной символической» (глубокая защита обязана работать)
  const relNest = path.join(TMP, 'rel-nest.tar.gz');
  writeRawTarGz(relNest, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/link', typeflag: '2', linkname: relDshmarket },
    { name: '.dsh/link/pwned.js', typeflag: '0', data: 'x' }
  ]);
  await expectReject(relNest, 'обычный член под пропущенной убегающей символической');

  // Контрпример: жёсткая ссылка «наследует» семантику убегающей символической, затем под ней дочерний член
  const relHard = path.join(TMP, 'rel-hard.tar.gz');
  writeRawTarGz(relHard, [
    { name: '.dsh/', typeflag: '5' },
    { name: '.dsh/sym', typeflag: '2', linkname: relDshmarket },
    { name: '.dsh/hl', typeflag: '1', linkname: '.dsh/sym' },
    { name: '.dsh/hl/evil.txt', typeflag: '0', data: 'x' }
  ]);
  await expectReject(relHard, 'член под убегающей символической, унаследованной через жёсткую ссылку');

  // ---- T. Issue #9 «совместимое восстановление»: переписать убегающую относительную символическую в абсолютную ----
  console.log('\n=== T. Совместимое восстановление Issue #9: перезапись относительной символической ===');
  const repairRoot = path.join(TMP, 'repair-stage', '.dsh');
  const mkParent = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });
  const dshmarketPath = path.join(repairRoot, 'profiles/web/node_modules/dshmarket');
  mkParent(dshmarketPath);
  fs.symlinkSync(relDshmarket, dshmarketPath);
  const evilLinkPath = path.join(repairRoot, 'evil');
  mkParent(evilLinkPath);
  fs.symlinkSync('../../../../etc/passwd', evilLinkPath);
  const innerLinkPath = path.join(repairRoot, 'profiles/web/node_modules/.bin/katex');
  mkParent(innerLinkPath);
  fs.symlinkSync('../katex/cli.js', innerLinkPath);

  const rep = repairEscapingRelativeLinks(repairRoot);
  ok(rep.repaired === 1, `перезаписываются только убегающие относительные символические из белого списка (repaired=${rep.repaired}, kept=${rep.kept})`);
  ok(fs.readlinkSync(dshmarketPath) === '/usr/local/lib/node_modules/dshmarket', 'результат перезаписи — эквивалентная абсолютная символическая');
  ok(fs.readlinkSync(evilLinkPath) === '../../../../etc/passwd', 'цели вне белого списка остаются как были (fail-closed)');
  ok(fs.readlinkSync(innerLinkPath) === '../katex/cli.js', 'относительная символическая внутри архива остаётся как была (не переписана по ошибке)');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n===== Итог: пройдено ${pass} / провалено ${fail} =====`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('Исключение в тесте:', e.message); process.exit(1); });
