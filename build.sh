#!/bin/bash
set -e

# Инструмент сборки образа deepseek-harness
# Использование:
#   ./build.sh          -> собирает базовый чистый образ по умолчанию (deepseek-harness-docker:latest и доп. теги)
#   ./build.sh --market -> собирает образ с предустановленным списком плагинов (deepseek-harness-docker:latest-market и доп. теги)

IMAGE_NAME="deepseek-harness-docker"
PROJ_VER="0.2.3"
NODE_IMAGE="${NODE_IMAGE:-node:24-trixie}"
NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION:-1.6.0}"
# Ключ сброса кэша слоя предустановки: по умолчанию текущий таймстамп, каждая сборка заново
# исполняет слой предустановки, и плагины из plugins.market.list на @latest (dshmarket)
# подтягивают свежайшую версию.
MARKET_REFRESH="${MARKET_REFRESH:-$(date +%s)}"
# ── M10 фиксация цепочки поставок ───────────────────────────────────────────────
# Версии по умолчанию зашиты в version.json#supply (больше не дёргаем npm за «последней alpha»
# при каждой сборке — иначе один и тот же релиз соберётся в различающиеся образы);
# при необходимости апгрейда явно меняем version.json или переопределяем переменной окружения.
read_supply() {
  node -e "const v=require('./version.json').supply||{};process.stdout.write(String(v['$1']||''))" 2>/dev/null \
    || grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" version.json | head -1 | sed 's/.*:\(.*\)/\1/' | tr -d '", '
}
PINNED_DSH="$(read_supply dshVersion)"
PINNED_PNPM="$(read_supply pnpmVersion)"
DSH_VERSION="${DSH_VERSION:-${PINNED_DSH:-0.2.1-alpha.2}}"
PNPM_VERSION="${PNPM_VERSION:-${PINNED_PNPM:-12.5.1}}"
echo " Фиксированные версии цепочки поставок: DSH=${DSH_VERSION}  pnpm=${PNPM_VERSION}"
if [ -z "${DSH_VERSION}" ]; then echo "Ошибка: не удалось определить версию DSH" >&2; exit 1; fi

# ── Дополнительные теги образа (Issue #9) ──────────────────────────────────────
# Назначение: отдельно собирать тестовый образ под конкретный issue / пользователя,
# не затрагивая :latest и официальные релизные теги.
# Использование: EXTRA_TAGS="issue9-fix" ./build.sh
#                EXTRA_TAGS="issue9-fix-market" ./build.sh --market
# Несколько тегов через пробел; каждый ставится и локально, и в ghcr.io.
EXTRA_TAGS="${EXTRA_TAGS:-}"
EXTRA_TAG_ARGS=""
for _t in ${EXTRA_TAGS}; do
  EXTRA_TAG_ARGS="${EXTRA_TAG_ARGS} -t ${IMAGE_NAME}:${_t} -t ghcr.io/misaka-link/${IMAGE_NAME}:${_t}"
  echo " Доп. тег: ${IMAGE_NAME}:${_t}  /  ghcr.io/misaka-link/${IMAGE_NAME}:${_t}"
done

if [ "$1" = "--market" ] || [ "$1" = "-m" ] || [ "$PREINSTALL_PLUGINS" = "1" ]; then
  echo "========================================================="
  echo " Сборка Market-образа с предустановленным списком плагинов: ${IMAGE_NAME}:latest-market"
  echo " Базовый образ (Node/OS): ${NODE_IMAGE}"
  echo " Доп. тег 1 (версия DSH): ${IMAGE_NAME}:${DSH_VERSION}-market"
  echo " Доп. тег 2 (версия проекта): ${IMAGE_NAME}:${PROJ_VER}-market"
  echo " Список предустановки: plugins.market.list"
  echo "========================================================="
  docker build \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION}" \
    --build-arg PREINSTALL_PLUGINS=1 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg MARKET_REFRESH="${MARKET_REFRESH}" \
    -t "${IMAGE_NAME}:latest-market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest-market" \
    -t "${IMAGE_NAME}:market" \
    -t "${IMAGE_NAME}:${DSH_VERSION}-market" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}-market" \
    -t "${IMAGE_NAME}:${PROJ_VER}-market" \
    -t "${IMAGE_NAME}:v${PROJ_VER}-market" \
    ${EXTRA_TAG_ARGS} \
    .
  echo ">>> Образ собран: ${IMAGE_NAME}:latest-market (доп. DSH:${DSH_VERSION}-market и проект:${PROJ_VER}-market)"
  echo ">>> Запуск для проверки: 'docker compose -f docker-compose.market.yml up -d'"
else
  echo "========================================================="
  echo " Сборка базового образа по умолчанию: ${IMAGE_NAME}:latest (без предустановки плагинов)"
  echo " Базовый образ (Node/OS): ${NODE_IMAGE}"
  echo " Доп. тег 1 (версия DSH): ${IMAGE_NAME}:${DSH_VERSION}"
  echo " Доп. тег 2 (версия проекта): ${IMAGE_NAME}:${PROJ_VER}"
  echo " Если нужны предустановленные маркет-плагины, выполните: ./build.sh --market"
  echo "========================================================="
  docker build \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION}" \
    --build-arg PREINSTALL_PLUGINS=0 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg MARKET_REFRESH="${MARKET_REFRESH}" \
    -t "${IMAGE_NAME}:latest" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest" \
    -t "${IMAGE_NAME}:${DSH_VERSION}" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}" \
    -t "${IMAGE_NAME}:${PROJ_VER}" \
    -t "${IMAGE_NAME}:v${PROJ_VER}" \
    ${EXTRA_TAG_ARGS} \
    .
  echo ">>> Образ собран: ${IMAGE_NAME}:latest (доп. DSH:${DSH_VERSION} и проект:${PROJ_VER})"
  echo ">>> Запуск для проверки: 'docker compose up -d'"
fi
