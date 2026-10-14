'use strict';
/**
 * **Хирургическое** удаление записей cordis.patch.yml + предохранитель.
 *
 * Предыстория (вторая рискованная грань P6): с официальной 0.1.7 `profiles/web/cordis.patch.yml`
 * одновременно является авторитетным хранилищем «настроек DSH» (туда пишет `dsh-config-editor`),
 * в нём могут быть ключевые записи пользователя, например `- id: llm-pi-ai`
 * (определение model-provider; потерять — значит исчезнет конфигурация моделей).
 *
 * Прежняя реализация была «разбить строки → фильтр → пересобрать → записать весь файл»:
 * текст прочих записей вроде бы сохранялся, но это всё равно **полная перезапись** —
 * если прочитанный снапшот отстал от конкурентной записи DSH, свеженаписанное целиком затиралось.
 *
 * Теперь:
 *   1) в исходном тексте **локализуется диапазон символов удаляемой записи** и удаляется только он,
 *      остальные байты (комментарии, пустые строки, `!!js`-выражения, CRLF, пробелы в конце строк)
 *      **сохраняются дословно**;
 *   2) перед записью прогоняется предохранитель `assertPatchSafe()`: результат не должен терять
 *      ни одну «не подлежащую удалению» верхнеуровневую запись и не должен терять защищённые записи
 *      (по умолчанию `llm-pi-ai`, список можно заменить через `DSH_PATCH_PROTECTED_IDS`),
 *      а также обязан быть корректной верхнеуровневой YAML-последовательностью;
 *      при нарушении любого условия — **отказ от записи с броском ошибки**.
 *
 * Лучше оставить один безобидный патч, чем потерять конфигурацию моделей пользователя.
 */

/** Верхнеуровневые id записей, которые обязаны выжить и не могут быть удалены этим модулем */
const DEFAULT_PROTECTED_IDS = ['llm-pi-ai'];

/** Стартовая строка верхнеуровневой записи: `- ` / `-\t`; `- id: x` считается записью с id */
const ENTRY_START_RE = /^-\s/;
const ENTRY_ID_RE = /^-\s*id:\s*["']?([^\s"'\r\n]+)/;

/** Разбивка «с сохранением конца строк», чтобы пересборка давала байт-в-байт исходный текст (включая CRLF) */
function splitKeepEol(content) {
  return String(content).split(/(?<=\n)/);
}

function lineWithoutEol(chunk) {
  return String(chunk).replace(/\r?\n$/, '');
}

/** Перечисляет id верхнеуровневых записей с id (вложенные с отступами `- id:` не учитываются) */
function topLevelEntryIds(content) {
  const ids = [];
  for (const chunk of splitKeepEol(content)) {
    const m = ENTRY_ID_RE.exec(chunk);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * Удаляет попавшие под критерий записи по гранулярности «записи»; не попавшие байты остаются как есть.
 * @param {string} content исходный текст патча
 * @param {(block: string) => boolean} matcher критерий попадания (block содержит полный текст записи)
 * @returns {{ text: string, removed: number, removedIds: string[] }}
 */
function removePatchEntries(content, matcher) {
  const chunks = splitKeepEol(content);
  const out = [];
  const removedIds = [];
  let removed = 0;
  let i = 0;

  while (i < chunks.length) {
    if (!ENTRY_START_RE.test(chunks[i])) {
      out.push(chunks[i]);
      i += 1;
      continue;
    }
    // Продолжение записи: строки с отступом или пустые строки между записями (как в прежней семантике)
    const start = i;
    let j = i + 1;
    while (j < chunks.length && !ENTRY_START_RE.test(chunks[j])) {
      const bare = lineWithoutEol(chunks[j]);
      if (bare.trim() === '' || /^\s/.test(bare)) {
        j += 1;
        continue;
      }
      break;
    }
    const block = chunks.slice(start, j).join('');
    i = j;
    if (matcher(block)) {
      removed += 1;
      const m = ENTRY_ID_RE.exec(block);
      if (m) removedIds.push(m[1]);
      continue;
    }
    out.push(block);
  }

  return { text: out.join(''), removed, removedIds };
}

function protectedPatchIds() {
  const raw = process.env.DSH_PATCH_PROTECTED_IDS;
  if (raw === undefined) return DEFAULT_PROTECTED_IDS.slice();
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Похож ли результат на корректный документ патча: пусто, '[]' или начинается с верхнеуровневого `- ` */
function looksLikePatchDocument(content) {
  const trimmed = String(content).trim();
  if (trimmed === '' || trimmed === '[]') return true;
  return /^-\s/m.test(trimmed) && !/^\s+-\s/m.test(trimmed.split('\n')[0] || '');
}

/**
 * Предохранитель: любую перезапись, «теряющую записи / ломающую документ», нужно блокировать.
 * @param {{ before: string, after: string, removedIds?: string[] }} input
 * @throws {Error} при нарушении инварианта (вызывающий должен отказаться от записи)
 */
function assertPatchSafe({ before, after, removedIds = [] }) {
  const beforeIds = topLevelEntryIds(before);
  const afterIds = topLevelEntryIds(after);
  const removed = new Set(removedIds);

  const unexpectedLoss = beforeIds.filter((id) => !afterIds.includes(id) && !removed.has(id));
  if (unexpectedLoss.length > 0) {
    throw new Error(`patch-yaml: перезапись потеряет записи, которые удалять нельзя [${unexpectedLoss.join(', ')}], отказано в записи`);
  }

  const protectedLoss = protectedPatchIds().filter((id) => beforeIds.includes(id) && !afterIds.includes(id));
  if (protectedLoss.length > 0) {
    throw new Error(`patch-yaml: перезапись удалит защищённые записи [${protectedLoss.join(', ')}], отказано в записи (список защиты можно поменять через DSH_PATCH_PROTECTED_IDS)`);
  }

  if (!looksLikePatchDocument(after)) {
    throw new Error('patch-yaml: результат перезаписи не является корректной верхнеуровневой YAML-последовательностью, отказано в записи');
  }
  return true;
}

module.exports = {
  DEFAULT_PROTECTED_IDS,
  splitKeepEol,
  topLevelEntryIds,
  removePatchEntries,
  protectedPatchIds,
  looksLikePatchDocument,
  assertPatchSafe
};
