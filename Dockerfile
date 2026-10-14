# ========================================================
# Dockerfile: deepseek-harness-docker
# Integrated DeepSeek Harness with Chromium Desktop & Unified Gateway
# Runtime base: Debian Trixie (glibc 2.41) & Node 24
# ========================================================

ARG NODE_IMAGE=node:24-trixie
FROM ${NODE_IMAGE}

LABEL maintainer="DeepSeek Harness Community"
LABEL description="Production Docker image for DeepSeek Harness with Container Browser, VNC, and Aesthetic Auth Gateway"

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_INSTALL_DIR=/usr/local \
    DSH_WORKSPACE=/workspace \
    PROXY_PORT=3080 \
    DSH_PORT=3079 \
    VNC_PORT=6080 \
    NOVNC_ASSET_REVISION=1.6.0 \
    DISPLAY=:99 \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    GOROOT=/usr/local/go \
    GOPATH=/go \
    PATH=/usr/local/go/bin:/go/bin:$PATH

# 0. Ускорение с помощью зеркал USTC для Китая (Debian + npm, включено по умолчанию;
#    при сборке в GitHub Actions или за рубежом можно передать USE_CHINA_MIRROR=0)
ARG USE_CHINA_MIRROR=1
RUN if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list 2>/dev/null || true; \
      npm config set registry https://registry.npmmirror.com; \
    fi

# 1. Установка базовых зависимостей, инструментов сборки, X11/VNC-окружения рабочего стола,
#    Chromium и китайских шрифтов
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    wget \
    git \
    openssh-client \
    ca-certificates \
    procps \
    psmisc \
    iproute2 \
    locales \
    python3 \
    python-is-python3 \
    build-essential \
    # Полезные CLI-инструменты разработки (задачи Агента работают из коробки)
    file \
    jq \
    less \
    ripgrep \
    rsync \
    zip \
    unzip \
    # Tcl/Tk-графические инструменты (редактор конфигурации рабочего стола и кросс-платформенный Shim)
    tk \
    # Виртуальный X11-дисплей и рабочий стол
    xvfb \
    x11-utils \
    xdotool \
    scrot \
    openbox \
    x11vnc \
    novnc \
    websockify \
    # Контейнерный браузер Chromium
    chromium \
    # Полная поддержка шрифтов и Emoji (без «кракозябр» на страницах и рабочем столе,
    # цветные Emoji и фолбэк для символов)
    fontconfig \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    fonts-noto-color-emoji \
    fonts-symbola \
    # Высокопроизводительные многопоточные утилиты сжатия и архивирования
    # (7-Zip и многопоточность для ускорения gzip)
    p7zip-full \
    pigz \
    && echo "zh_CN.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen zh_CN.UTF-8 \
    && mkdir -p /etc/fonts \
    && printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <alias>\n    <family>sans-serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>monospace</family>\n    <prefer>\n      <family>WenQuanYi Micro Hei Mono</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>emoji</family>\n    <prefer>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n</fontconfig>\n' > /etc/fonts/local.conf \
    && fc-cache -f \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 1.1 Установка официального GitHub CLI (gh)
RUN (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
     && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
     && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
     && apt-get update && apt-get install -y --no-install-recommends gh) \
    || (ARCH=$(dpkg --print-architecture) \
        && curl -sSL "https://github.com/cli/cli/releases/download/v2.60.1/gh_2.60.1_linux_${ARCH}.tar.gz" -o /tmp/gh.tar.gz \
        && tar -C /tmp -xzf /tmp/gh.tar.gz \
        && mv /tmp/gh_*/bin/gh /usr/local/bin/gh \
        && rm -rf /tmp/gh*) \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && gh --version

# 1.2 Изоляция и «пробивание» кэша версий статических ресурсов noVNC
# (чтобы после апгрейда браузер не смешивал старые кэши — иначе WebCodecs падает или белый экран)
ARG NOVNC_ASSET_REVISION=1.6.0
RUN novnc_copy="$(mktemp -d)" \
    && cp -a /usr/share/novnc/. "${novnc_copy}/" \
    && mkdir -p "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}" \
    && cp -a "${novnc_copy}/." "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}/" \
    && rm -rf "${novnc_copy}" \
    && if [ ! -e /usr/share/novnc/index.html ]; then ln -s vnc.html /usr/share/novnc/index.html; fi

# 1.3 Совместимый Shim для вызова путей WSL2 / Docker Desktop
# (чинит «spawn wslpath ENOENT» при клике «Открыть конфигурацию/каталог» в Web-UI)
RUN cat > /usr/local/bin/wslpath <<'SHIM'
#!/bin/sh
out=""
for arg in "$@"; do
  case "$arg" in
    -w|-u|-m|--*) ;;
    *) out="$arg" ;;
  esac
done
printf '%s\n' "${out:-/}"
exit 0
SHIM
RUN cat > /usr/local/bin/powershell.exe <<'SHIM'
#!/bin/sh
command_text=""
for arg in "$@"; do
  case "$arg" in
    -NoProfile|-Command) ;;
    *) command_text="$arg" ;;
  esac
done
path=""
if [ -n "$command_text" ]; then
  path=$(printf '%s' "$command_text" \
    | sed -n "s/.*-LiteralPath[[:space:]]*'\([^']*\)'[[:space:]]*$/\1/p" \
    | sed "s/''/'/g")
fi
if [ -z "$path" ] || [ ! -e "$path" ]; then exit 0; fi
DISPLAY="${DISPLAY:-:99}" /usr/bin/wish /usr/local/bin/dsh-editor.tcl "$path" >/dev/null 2>&1 &
exit 0
SHIM
RUN cat > /usr/local/bin/dsh-editor.tcl <<'SHIM'
#!/usr/bin/wish
set target [lindex $argv 0]
if {$target eq ""} { exit }

if {[file isdirectory $target]} {
  wm title . "DSH Workspace: $target"
  wm geometry . 680x520
  listbox .lb -width 90 -height 30 -yscrollcommand {.vs set}
  scrollbar .vs -command {.lb yview}
  pack .lb -side left -fill both -expand true
  pack .vs -side right -fill y
  foreach f [lsort [glob -nocomplain -directory $target *]] {
    .lb insert end [file tail $f]
  }
  bind .lb <Double-Button-1> {
    set sel [lindex [.lb curselection] 0]
    if {$sel ne ""} {
      exec wish [info script] [file join $target [.lb get $sel]] &
    }
  }
  return
}

wm title . "DSH Config Editor: $target"
wm geometry . 900x640
frame .bar
button .bar.save -text "Save (Ctrl+S)" -command saveFile
button .bar.close -text "Close (Ctrl+W)" -command exit
label .bar.path -text $target -anchor w
pack .bar.save .bar.close -side left -padx 3 -pady 3
pack .bar.path -side left -fill x -expand true -padx 6
pack .bar -side top -fill x

text .txt -wrap word -undo true -yscrollcommand {.vs set} -font {TkFixedFont 11}
scrollbar .vs -command {.txt yview}
pack .txt -side left -fill both -expand true
pack .vs -side right -fill y

if {[catch {set fd [open $target r]; fconfigure $fd -encoding utf-8; set content [read $fd]; close $fd} err]} {
  tk_messageBox -message "Open failed: $err" -type ok -icon warning
  exit
}
.txt insert 1.0 $content
focus .txt

proc saveFile {} {
  global target
  if {[catch {
    set fd [open $target w]
    fconfigure $fd -encoding utf-8
    puts -nonewline $fd [.txt get 1.0 end-1c]
    close $fd
  } err]} {
    tk_messageBox -message "Save failed: $err" -type ok -icon error
    return
  }
  .bar.save configure -text "Saved ✓"
  after 1200 { .bar.save configure -text "Save (Ctrl+S)" }
}
bind .txt <Control-s> saveFile
bind .txt <Control-w> exit
bind . <Control-s> saveFile
bind . <Control-w> exit
SHIM
RUN chmod 0755 /usr/local/bin/wslpath /usr/local/bin/powershell.exe /usr/local/bin/dsh-editor.tcl

# 2. Установка свежего официального окружения Golang (встроенное переключение китайских и зарубежных ускорителей)
ARG GO_VERSION=""
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    case "${ARCH}" in \
      amd64) GOARCH='amd64' ;; \
      arm64) GOARCH='arm64' ;; \
      armhf) GOARCH='armv6l' ;; \
      i386)  GOARCH='386' ;; \
      *) echo "Неподдерживаемая архитектура: ${ARCH}"; exit 1 ;; \
    esac; \
    TARGET_VERSION="${GO_VERSION}"; \
    if [ -z "${TARGET_VERSION}" ]; then \
      if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
        TARGET_VERSION="$(curl -sSL https://golang.google.cn/VERSION?m=text 2>/dev/null | head -n 1 | tr -d '\r\n' || true)"; \
      fi; \
      if [ -z "${TARGET_VERSION}" ]; then \
        TARGET_VERSION="$(curl -sSL https://go.dev/VERSION?m=text 2>/dev/null | head -n 1 | tr -d '\r\n' || echo 'go1.27.1')"; \
      fi; \
    fi; \
    case "${TARGET_VERSION}" in go*) ;; *) TARGET_VERSION="go${TARGET_VERSION}" ;; esac; \
    echo "===> Устанавливаем свежее окружение Golang (${TARGET_VERSION} for linux/${GOARCH})..."; \
    GO_TARBALL="${TARGET_VERSION}.linux-${GOARCH}.tar.gz"; \
    DOWNLOAD_SUCCESS=0; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      echo "===> Пробуем скачать Golang с официального китайского зеркала..."; \
      if curl -sSL --fail "https://golang.google.cn/dl/${GO_TARBALL}" -o /tmp/go.tar.gz; then \
        DOWNLOAD_SUCCESS=1; \
      fi; \
    fi; \
    if [ "${DOWNLOAD_SUCCESS}" = "0" ]; then \
      echo "===> Скачиваем Golang с глобального официального источника..."; \
      curl -sSL --fail "https://go.dev/dl/${GO_TARBALL}" -o /tmp/go.tar.gz; \
    fi; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm -f /tmp/go.tar.gz; \
    ln -s /usr/local/go/bin/go /usr/local/bin/go; \
    ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt; \
    mkdir -p /go/src /go/bin /go/pkg /workspace; \
    chmod -R 0755 /go; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      /usr/local/go/bin/go env -w GOPROXY="https://goproxy.cn,direct"; \
    fi; \
    go version

# 3. Глобальная установка официального CLI DeepSeek Harness и pnpm
#    (M10: фиксированная версия + проверка целостности + без исполнения скриптов пакета при установке)
#    Версии по умолчанию берутся из version.json#supply, который читает build.sh; можно
#    переопределить через --build-arg.
ARG DSH_VERSION="0.2.1-alpha.2"
ARG PNPM_VERSION="12.5.1"
RUN set -eux; \
    TARGET_PKG="@deepseek-ai/dsh@${DSH_VERSION}"; \
    echo "===> Устанавливаем официальное ядро DeepSeek Harness: ${TARGET_PKG} (pnpm@${PNPM_VERSION})..."; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      PRIMARY_REG="https://registry.npmmirror.com"; ALT_REG="https://registry.npmjs.org"; \
    else \
      PRIMARY_REG="https://registry.npmjs.org"; ALT_REG="https://registry.npmmirror.com"; \
    fi; \
    echo "===> Основной источник ${PRIMARY_REG}; резервный ${ALT_REG}"; \
    mkdir -p /tmp/dsh-pkg; \
    INTEG="$(npm view "${TARGET_PKG}" dist.integrity --registry="${PRIMARY_REG}" 2>/dev/null || npm view "${TARGET_PKG}" dist.integrity --registry="${ALT_REG}" 2>/dev/null || true)"; \
    TGZ="$(npm pack "${TARGET_PKG}" --registry="${PRIMARY_REG}" --pack-destination /tmp/dsh-pkg --silent 2>/dev/null | tail -n 1)"; \
    if [ -z "${TGZ}" ] || [ ! -f "/tmp/dsh-pkg/${TGZ}" ]; then \
      echo "===> Основной источник не синхронизировал ${TARGET_PKG}, тянем tarball с резервного..."; \
      TGZ="$(npm pack "${TARGET_PKG}" --registry="${ALT_REG}" --pack-destination /tmp/dsh-pkg --silent | tail -n 1)"; \
    fi; \
    if [ -n "${INTEG}" ]; then \
      node -e "const c=require('crypto'),f=require('fs');const [alg,b64]=String(process.argv[1]).split('-');const h=c.createHash(alg).update(f.readFileSync(process.argv[2])).digest('base64');if(h!==b64){console.error('Ошибка проверки integrity:',process.argv[1]);process.exit(1)}console.log('integrity OK ('+alg+')');" "${INTEG}" "/tmp/dsh-pkg/${TGZ}"; \
    else \
      echo "Предупреждение: registry не вернул dist.integrity, пропускаем проверку целостности"; \
    fi; \
    npm config set allow-scripts false --location=global 2>/dev/null || true; \
    INSTALL_OK=0; \
    for REG in "${PRIMARY_REG}" "${ALT_REG}"; do \
      if npm install -g --ignore-scripts --registry="${REG}" --prefer-online --fetch-retries=5 --fetch-retry-maxtimeout=60000 "pnpm@${PNPM_VERSION}" "/tmp/dsh-pkg/${TGZ}"; then INSTALL_OK=1; break; fi; \
      echo "===> Не удалось разрешить зависимости (зеркало не синхронизировало всю партию подпакетов либо метаданные апстрима в гонке), пробуем другой источник..."; \
    done; \
    if [ "${INSTALL_OK}" != "1" ]; then echo "Ошибка: разрешение зависимостей DSH не удалось ни на основном, ни на резервном источнике" >&2; exit 1; fi; \
    rm -rf /tmp/dsh-pkg; \
    (cd /usr/local/lib/node_modules/@deepseek-ai/dsh && npm rebuild node-pty --foreground-scripts) 2>/dev/null || true; \
    for d in /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*; do \
      pkg_name=$(basename "$d"); \
      if [ "$pkg_name" != "dsh" ] && [ ! -e "/usr/local/lib/node_modules/@deepseek-ai/$pkg_name" ]; then \
        ln -s "$d" "/usr/local/lib/node_modules/@deepseek-ai/$pkg_name"; \
      fi; \
    done; \
    find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true; \
    find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true; \
    dsh --version || node -e "console.log(require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version)"

# 3.1 Опциональная предустановка списка плагинов сообщества (по умолчанию PREINSTALL_PLUGINS=0;
#    при «1» автоматически устанавливаются плагины из plugins.market.list)
ARG PREINSTALL_PLUGINS=0
# Ключ сброса кэша слоя предустановки: передавайте каждый раз уникальное значение
# (в CI — run_id, локально — таймстамп),
# чтобы этот RUN-слой принудительно инвалидировался и исполнялся заново —
# иначе при неизменном содержимом plugins.market.list Docker переиспользует старый слой,
# и плагины, записанные как @latest (например dshmarket), никогда не подтянут новую версию.
ARG MARKET_REFRESH=""
COPY plugins.market.list /app/plugins.market.list
RUN if [ "$PREINSTALL_PLUGINS" = "1" ] || [ "$PREINSTALL_PLUGINS" = "true" ]; then \
      echo "===> Предустанавливаем список плагинов сообщества из plugins.market.list (Market-вариант, refresh=${MARKET_REFRESH:-none})..." \
      && sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' /app/plugins.market.list \
         | grep -v '^$' \
         | xargs -r npm install -g --ignore-scripts \
      && for p in dshmarket @hytime/dsh-thinking-effort; do \
           if [ -d "/usr/local/lib/node_modules/$p" ]; then \
             mkdir -p "/usr/local/lib/node_modules/$p/node_modules"; \
             ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai "/usr/local/lib/node_modules/$p/node_modules/@deepseek-ai"; \
           fi; \
         done \
      && echo "===> Предустановка плагинов сообщества завершена"; \
    else \
      echo "===> Базовая модель (по умолчанию сторонние плагины не предустанавливаются)"; \
    fi

# 4. Создание необходимой структуры каталогов (включая рабочее пространство Go и кэш)
# M11: добавлен non-root пользователь dsh(uid 1000). По умолчанию по-прежнему запускается root
#       для совместимости с существующими томами данных (/root/.dsh);
#       для non-root запуска: в compose задать user: "1000:1000" и DSH_HOME=/home/dsh,
#       а также перемонтировать тома данных на пути вида /home/dsh/.dsh (подробнее в README и .env.example).
RUN set -eux; \
    getent group dsh >/dev/null || groupadd -g 1001 dsh || groupadd dsh; \
    getent passwd dsh >/dev/null || useradd -m -u 1001 -g dsh -s /bin/bash dsh || useradd -m -g dsh -s /bin/bash dsh; \
    mkdir -p /app/gateway /app/scripts /app/plugins /workspace /root/.dsh /root/.dsh-snapshots /root/.config/chromium /go \
    && mkdir -p /home/dsh/.dsh /home/dsh/.dsh-snapshots /home/dsh/.config/chromium /home/dsh/workspace \
    && chown -R dsh:dsh /home/dsh /go \
    && chmod 0755 /home/dsh \
    && id dsh

# 5. Копирование скриптов проекта и программы шлюза
COPY version.json /app/version.json
COPY scripts/ /app/scripts/
COPY gateway/ /app/gateway/
COPY plugins/ /app/plugins/

# 5.1 Разрешение зависимостей плагина на время выполнения (M12): контекст сборки уже исключает
#     node_modules, здесь явно создаются симлинки на встроенные зависимости официального DSH —
#     чтобы не полагаться на «симлинки с абсолютными путями хоста» как на призрак сборки.
#     (index.js плагина напрямую импортирует '@deepseek-ai/schemastery', путь разрешения:
#       /app/plugins/<plugin>/node_modules/@deepseek-ai/*)
RUN for p in /app/plugins/*/; do \
      mkdir -p "${p}node_modules/@deepseek-ai"; \
      for d in /usr/local/lib/node_modules/@deepseek-ai/*; do \
        n=$(basename "$d"); \
        if [ "$n" != "dsh" ] && [ ! -e "${p}node_modules/@deepseek-ai/$n" ]; then \
          ln -s "$d" "${p}node_modules/@deepseek-ai/$n"; \
        fi; \
      done; \
    done \
    && ls -l /app/plugins/*/node_modules/@deepseek-ai/ | head -20

# 6. Установка зависимостей шлюза и выполнимость скриптов
RUN cd /app/gateway && npm install --omit=dev \
    && chmod +x /app/scripts/entrypoint.sh /app/scripts/chromium-docker \
    && ln -s /app/scripts/chromium-docker /usr/local/bin/chromium-docker \
    && npm config set registry https://registry.npmmirror.com 2>/dev/null || true \
    && which pnpm >/dev/null 2>&1 && pnpm config set registry https://registry.npmmirror.com 2>/dev/null || true

# 7. Рабочий каталог и объявление томов
WORKDIR /workspace
VOLUME ["/root/.dsh", "/root/.dsh-snapshots", "/workspace", "/root/.config/chromium"]

# 8. Единый внешний порт сервиса
EXPOSE 3080

# 9. Проверка готовности: шлюз даёт /healthz без аутентификации; при серии неудач
#    оркестрация помечает контейнер unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3080/healthz || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
