'use strict';
/**
 * Инструменты безопасной работы с номером версии и путями DSH.
 *
 * Чистые функции, без побочных эффектов и зависимостей от окружения — удобно юнит-тестировать.
 * Предыстория: у /api/dsh/install версия раньше шла сразу на trim() и дальше в
 *   - path.join(versionsCacheDir, version)  → можно было `../../..` сбежать из каталога кэша
 *   - `@deepseek-ai/dsh@${version}`         → можно было внедрить npm-алиасы и прочие спецификаторы
 * Здесь — единая строгая проверка, двойной контроль на входе и в ядре (эшелонированная оборона).
 */
const path = require('path');

// Строгий semver: главная.побочная.патч [-pre] [+build]; запрещены разделители путей, `..`,
// npm:`-алиасы, пробелы и слишком длинные строки
const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/** Является ли значение безопасно используемым номером версии DSH */
function isValidVersion(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return false;
  return VERSION_RE.test(v);
}

/**
 * Разрешает name внутри baseDir; при выходе за границы бросает ошибку (запрещены `..` и абсолютные пути).
 * @param {string} baseDir разрешённый корневой каталог
 * @param {string} name подпуть/имя
 * @returns {string} абсолютный разрешённый путь
 */
function resolveWithinDir(baseDir, name) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, String(name));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Недопустимый путь (выход за границы): ${String(name).slice(0, 64)}`);
  }
  return target;
}

module.exports = { isValidVersion, resolveWithinDir, VERSION_RE };
