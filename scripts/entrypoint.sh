#!/bin/bash
set -eo pipefail

export DSH_WORKSPACE="${DSH_WORKSPACE:-/workspace}"
export PROXY_PORT="${PROXY_PORT:-3080}"
export DSH_PORT="${DSH_PORT:-3079}"
export VNC_PORT="${VNC_PORT:-6080}"
# M13: ADMIN_PATH / VNC_PATH экспортируются в окружение только при **явно заданном** значении;
# без значения ничего не подставляется, чтобы сохранённая панелью управления конфигурация
# продолжала действовать (явный env имеет приоритет).
if [ -n "${ADMIN_PATH:-}" ]; then export ADMIN_PATH; fi
if [ -n "${VNC_PATH:-}" ]; then export VNC_PATH; fi
export NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION:-1.6.0}"
export DSH_DESKTOP_ENABLED="${DSH_DESKTOP_ENABLED:-1}"
export DSH_DESKTOP_WIDTH="${DSH_DESKTOP_WIDTH:-1920}"
export DSH_DESKTOP_HEIGHT="${DSH_DESKTOP_HEIGHT:-1080}"
export DSH_DESKTOP_DEPTH="${DSH_DESKTOP_DEPTH:-24}"
# M11: корневой каталог можно переносить (при non-root развёртывании ставить /home/<user>), по умолчанию /root
export DSH_HOME="${DSH_HOME:-/root}"
export DSH_DIR="${DSH_HOME}/.dsh"
export DSH_SNAPSHOT_DIR="${DSH_SNAPSHOT_DIR:-${DSH_HOME}/.dsh-snapshots}"
# Issue #7: хранилище версий изолировано по ядрам. По умолчанию — подкаталог внутри тома «снимки и резервные
# копии» (переиспользуем существующее монтирование, без новых точек монтирования)
export DSH_VERSIONS_DIR="${DSH_VERSIONS_DIR:-${DSH_SNAPSHOT_DIR}/versions}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-${DSH_HOME}/.config/chromium}"
# Незначительное: журнал DSH пишется в том данных (удобно для диагностики и сохранности), плюс простая ротация по размеру
export DSH_WEB_LOG="${DSH_WEB_LOG:-${DSH_HOME:-/root}/.dsh/logs/dsh-web.log}"
export DSH_WEB_LOG_MAX_BYTES="${DSH_WEB_LOG_MAX_BYTES:-10485760}"
export NODE_OPTIONS="${NODE_OPTIONS} --no-deprecation"
export NODE_PATH="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules:/usr/local/lib/node_modules:${NODE_PATH}"

# Нормализация переменных окружения исходящего прокси (совместимость с нативным исходящим
# прокси официальной 0.1.5-rc.1)
[ -n "$HTTP_PROXY" ] && export HTTP_PROXY="$HTTP_PROXY" http_proxy="${http_proxy:-$HTTP_PROXY}"
[ -n "$HTTPS_PROXY" ] && export HTTPS_PROXY="$HTTPS_PROXY" https_proxy="${https_proxy:-$HTTPS_PROXY}"
[ -n "$ALL_PROXY" ] && export ALL_PROXY="$ALL_PROXY" all_proxy="${all_proxy:-$ALL_PROXY}"
[ -n "$NO_PROXY" ] && export NO_PROXY="$NO_PROXY" no_proxy="${no_proxy:-$NO_PROXY}"

child_pid=""

stop_all() {
  echo "[entrypoint] Получен сигнал остановки, выходим..."
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit 0
}

trap stop_all SIGINT SIGTERM SIGHUP

echo "========================================================"
echo "    Запускаем DeepSeek Harness"
echo "========================================================"

# 1. Готовим необходимые каталоги
mkdir -p "${DSH_WORKSPACE}" "${DSH_DIR}" "${DSH_SNAPSHOT_DIR}" "${CHROME_USER_DATA_DIR}" "/tmp/dsh-desktop"
mkdir -p "$(dirname "${DSH_WEB_LOG}")" 2>/dev/null || true
if [ -f "${DSH_WEB_LOG}" ]; then
  _log_size=$(wc -c < "${DSH_WEB_LOG}" 2>/dev/null || echo 0)
  if [ "${_log_size:-0}" -gt "${DSH_WEB_LOG_MAX_BYTES}" ]; then
    mv -f "${DSH_WEB_LOG}" "${DSH_WEB_LOG}.1" 2>/dev/null || true
  fi
fi
touch "${DSH_WEB_LOG}"

# 1.0 Автонастройка зеркал npm и pnpm (по умолчанию npmmirror; за рубежом можно переопределить через NPM_REGISTRY)
NPM_REG="${NPM_REGISTRY:-https://registry.npmmirror.com}"
npm config set registry "${NPM_REG}" 2>/dev/null || true
which pnpm >/dev/null 2>&1 && pnpm config set registry "${NPM_REG}" 2>/dev/null || true

# 1.01 Обеспечиваем исполняемость spawn-helper для node-pty
find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true
find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true

# 1.1 Чиним строгие права каталога .dsh и файлов с учётными данными
# (сервис учётных данных DSH принудительно требует mode 600 и отказывается при 777/644 — краш при чтении из других прав)
if [ -d "${DSH_DIR}" ]; then
  chmod 700 "${DSH_DIR}" 2>/dev/null || true
  find "${DSH_DIR}" -name "*credentials*.yaml" -o -name "*credentials*.yml" 2>/dev/null | while read -r f; do
    chmod 600 "$f" || true
  done
fi

# 1.2 Контейнерные пресеты конфигурации: официально с 0.1.7 авторитет настроек переехал
#      с $DSH_DIR/settings.yaml на патч-слой (старый settings.yaml импортируется только один раз
#      после старта DSH и переименовывается в settings.yaml.imported),
#      поэтому settings.yaml здесь **не пересоздаём** — иначе при каждом перезапуске он снова
#      импортировался бы и откатывал значения, изменённые пользователем на странице настроек.
#      Контейнерные пресеты (страж перезапуска маркетплейса, переключатель нативного браузера
#      боковой панели) целиком пишутся install-plugin.mjs в патч уровня Home
#      $DSH_DIR/cordis.patch.yml (слой 0.1.7 с наивысшим приоритетом, действует на все профили).
#      Если в существующем контейнере ещё остался settings.yaml — однократную миграцию выполняет
#      сам DSH при первом старте, сюда не вмешиваемся.

# 1.15 хранилище версий (Issue #7): подготовка каталога + самовосстановление после обрыва + уборка остатков + самопроверка персистентности
mkdir -p "${DSH_VERSIONS_DIR}/.staging" 2>/dev/null || true

CORE_PARENT="/usr/local/lib/node_modules/@deepseek-ai"
CORE_DIR="${CORE_PARENT}/dsh"

# 1.15.1 Самовосстановление после обрыва: если активного ядра нет (последняя атомарная замена
# была прервана) — восстанавливаем из свежайшей точки отката, чтобы контейнер не «окипел».
# В приоритете временная точка отката (.dsh-rollback-tmp-*), при её отсутствии — защищённый
# однослотовый запасной набор (.dsh-rollback-preserved) (спасение важнее сохранения)
if [ ! -d "${CORE_DIR}" ]; then
  _rb="$(ls -1d "${CORE_PARENT}"/.dsh-rollback-tmp-* 2>/dev/null | sort | tail -1 || true)"
  if [ -z "${_rb}" ] || [ ! -d "${_rb}" ]; then
    if [ -d "${CORE_PARENT}/.dsh-rollback-preserved" ]; then
      _rb="${CORE_PARENT}/.dsh-rollback-preserved"
    fi
  fi
  if [ -n "${_rb}" ] && [ -d "${_rb}" ]; then
    echo "[entrypoint] ⚠️ Активное ядро отсутствует, восстанавливаем из точки отката: ${_rb}"
    mv "${_rb}" "${CORE_DIR}" 2>/dev/null || true
  fi
fi

# 1.15.2 Убираем устаревшие остатки staging/rollback (>60 минут), никогда не трогая
# активное ядро и защищённую точку отката
find "${CORE_PARENT}" -maxdepth 1 -name ".dsh-staging-*" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${CORE_PARENT}" -maxdepth 1 -name ".dsh-rollback-*" ! -name ".dsh-rollback-preserved" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${DSH_VERSIONS_DIR}/.staging" -maxdepth 1 -mindepth 1 -mmin +60 -exec rm -rf {} + 2>/dev/null || true

# 1.15.3 Самопроверка персистентности: хранилище версий обязано лежать внутри какого-либо
# персистентного монтирования (по умолчанию — том снимков <snapshots>/versions)
_persisted=0
while IFS= read -r _mp; do
  [ -z "$_mp" ] && continue
  [ "$_mp" = "/" ] && continue
  case "${DSH_VERSIONS_DIR}/" in "${_mp}/"*) _persisted=1; break ;; esac
done < <(awk '{print $5}' /proc/self/mountinfo 2>/dev/null)
if [ "$_persisted" != "1" ]; then
  echo "[entrypoint] ⚠️ хранилище версий ${DSH_VERSIONS_DIR} не находится ни в одном персистентном монтировании: после пересоздания контейнера/обновления образа архивные версии пропадут (при откате придётся качать заново)."
  echo "[entrypoint] ⚠️ По умолчанию оно должно лежать в томе снимков (${DSH_SNAPSHOT_DIR}/versions); для независимой изоляции можно примонтировать -v ./data/versions:/root/.dsh-versions и задать DSH_VERSIONS_DIR=/root/.dsh-versions"
fi

# 2. Автоматически регистрируем и устанавливаем плагин dsh-browser-desktop в DSH profile
if [ -f "/app/scripts/install-plugin.mjs" ]; then
  echo "[entrypoint] Регистрируем плагин dsh-browser-desktop в Web Profile..."
  node /app/scripts/install-plugin.mjs || true
fi

# 3. Применяем патчи loopback-персистентности клиента и сервера (обязательные патчи при недост.
# выходят с ненулевым кодом — здесь громко предупреждаем, но запуск не блокируем)
if [ -f "/app/scripts/patch-dsh-client.mjs" ]; then
  echo "[entrypoint] Применяем патчи loopback-подключения DSH-клиента и персистентности настроек хоста..."
  if ! node /app/scripts/patch-dsh-client.mjs; then
    echo "[entrypoint] ⚠️⚠️⚠️ Обязательные патчи не применились (см. строки [FATAL] выше)!"
    echo "[entrypoint] ⚠️ Сервис продолжит запуск, но патчи вроде пропуска аутентификации / loopback host-режима / самовосстановления 404 пакетов плагинов могут отсутствовать;"
    echo "[entrypoint] ⚠️ Пожалуйста, обновите образ или поправьте якоря патчей в scripts/patch-dsh-client.mjs."
  fi
fi

# 4. Запускаем единый цикл-страж шлюза
#    - поддержка горячего перезапуска шлюза из панели управления (точечный NODE_ENV=production)
#    - экспоненциальный backoff (1с→2с→…→30с); после 10 неудач подряд контейнер выходит,
#      и вмешивается оркестрация/пользователь
attempt=0
backoff=1
while true; do
  echo "[entrypoint] Запускаем шлюз..."
  start_ts=$(date +%s)
  NODE_ENV=production node /app/gateway/index.js &
  child_pid=$!
  code=0
  wait "$child_pid" || code=$?
  child_pid=""
  ran=$(( $(date +%s) - start_ts ))

  # Стабильная работа дольше 60с считается успешным стартом: сбрасываем счётчик backoff
  if [ "$ran" -ge 60 ]; then
    attempt=0
    backoff=1
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "[entrypoint] ❌ Шлюз аварийно вышел ${attempt} раз подряд (последний код выхода ${code}, работал ${ran}с), прекращаем перезапуски и выходим из контейнера"
    exit 1
  fi
  echo "[entrypoint] Процесс шлюза вышел (code=${code}, работал ${ran}с), перезапуск через ${backoff}с (попытка ${attempt})..."
  sleep "$backoff"
  backoff=$(( backoff * 2 ))
  [ "$backoff" -gt 30 ] && backoff=30
done
