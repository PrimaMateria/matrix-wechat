FROM docker.io/oven/bun:1.3.14 AS client
# Download the validated release asset with retries; the native profile owns the hash pin.
ARG WECHAT_APPIMAGE_URL=https://github.com/yamada-sexta/matrix-wechat/releases/download/wechat-client-4.1.13-4526180b/WeChatLinux_x86_64.AppImage
COPY packages/wechatlinux/scripts/download-client.ts /tmp/download-client.ts
COPY packages/wechatlinux/src/native/storage_profile.toml /tmp/storage_profile.toml
RUN bun /tmp/download-client.ts "$WECHAT_APPIMAGE_URL" /opt/wechat-client/WeChatLinux_x86_64.AppImage /tmp/storage_profile.toml

FROM docker.io/oven/bun:1.3.14 AS build
WORKDIR /opt/matrix-wechat
RUN ln -sf /usr/local/bin/bun /usr/local/bin/node
COPY package.json bun.lock ./
COPY packages/wechatlinux/package.json ./packages/wechatlinux/package.json
COPY packages/matrix-bridge/package.json ./packages/matrix-bridge/package.json
RUN bun install --frozen-lockfile
COPY .gitignore ./
COPY packages/wechatlinux ./packages/wechatlinux
COPY packages/matrix-bridge ./packages/matrix-bridge
RUN bun run check && bun run test && bun run lint && bun run build
RUN cd packages/matrix-bridge && bun -e 'const m=await import("matrix-appservice-bridge");console.log(typeof m.Bridge)'

FROM docker.io/oven/bun:1.3.14 AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates squashfs-tools xvfb xauth fonts-noto-cjk fontconfig x11-utils x11-xserver-utils \
    libasound2 libatomic1 libdbus-1-3 libdrm2 libegl1 libexpat1 libfontconfig1 libfreetype6 libgbm1 libgl1 libglib2.0-0 \
    libgssapi-krb5-2 libgtk-3-0 libnotify4 libnss3 libnspr4 libpulse0 libsecret-1-0 libsqlite3-0 libstdc++6 \
    libqt5dbus5 libqt5gui5 libqt5svg5 libqt5widgets5 libx11-6 libx11-xcb1 libxcb1 libxcb-cursor0 libxcb-icccm4 \
    libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render0 libxcb-render-util0 libxcb-shape0 libxcb-shm0 libxcb-sync1 \
    libxcb-util1 libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxkbcommon0 libxkbcommon-x11-0 libxrandr2 libxrender1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/matrix-wechat
COPY --from=build /opt/matrix-wechat /opt/matrix-wechat
COPY --from=client /opt/wechat-client/WeChatLinux_x86_64.AppImage /opt/wechat-client/WeChatLinux_x86_64.AppImage
COPY example-config.yaml /opt/matrix-wechat/example-config.yaml
ENV WECHAT_INSTALL_DIR=/opt/wechat-client/app
RUN bun -e 'import {Runtime} from "./packages/wechatlinux/src/runtime.ts";console.log(await new Runtime().executable())' \
    && chmod -R a+rX,a-w /opt/wechat-client
RUN usermod --home /home/wechat --move-home bun \
    && mkdir -p /data /tmp/runtime-wechat \
    && chown bun:bun /data /tmp/runtime-wechat && chmod 0700 /data /tmp/runtime-wechat
ENV HOME=/home/wechat XDG_RUNTIME_DIR=/tmp/runtime-wechat
USER bun
VOLUME ["/data", "/home/wechat"]
EXPOSE 17778 18742
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/opt/matrix-wechat/packages/matrix-bridge/src/main.ts", "-c", "/data/config.yaml"]
