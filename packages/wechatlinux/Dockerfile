FROM docker.io/oven/bun:1.3.14 AS client
# The vendor's mutable download URL must still match the reverse-engineered build.
ADD --checksum=sha256:4526180bca980128791599af122ff4795002a5715a510f6a65480e2be6874244 https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.AppImage /opt/wechat-client/WeChatLinux_x86_64.AppImage

FROM docker.io/oven/bun:1.3.14 AS build
WORKDIR /opt/wechatlinux
# Frida's npm install script invokes `node`; Bun provides that executable here.
RUN ln -sf /usr/local/bin/bun /usr/local/bin/node
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
RUN bun -e 'const f=await import("frida");await f.getLocalDevice();console.log("Frida binding works under Bun")'
COPY tsconfig.json biome.json .gitignore ./
COPY src ./src
COPY tests ./tests
COPY scripts/adb-login.ts ./scripts/adb-login.ts
RUN bun run lint && bun run check && bun run test && bun run build

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
WORKDIR /opt/wechatlinux
COPY --from=build /opt/wechatlinux/package.json /opt/wechatlinux/bun.lock ./
COPY --from=build /opt/wechatlinux/node_modules ./node_modules
COPY --from=build /opt/wechatlinux/src ./src
COPY --from=build /opt/wechatlinux/dist ./dist
COPY --from=client /opt/wechat-client/WeChatLinux_x86_64.AppImage /opt/wechat-client/WeChatLinux_x86_64.AppImage
ENV WECHAT_INSTALL_DIR=/opt/wechat-client/app
# Extract and verify both hashes during build, without starting WeChat.
RUN bun -e 'import {Runtime} from "./src/runtime.ts";console.log(await new Runtime().executable())' \
    && chmod -R a+rX,a-w /opt/wechat-client
RUN usermod --home /home/wechat --move-home bun \
    && mkdir -p /tmp/runtime-wechat && chown bun:bun /tmp/runtime-wechat && chmod 0700 /tmp/runtime-wechat
ENV HOME=/home/wechat XDG_RUNTIME_DIR=/tmp/runtime-wechat
USER bun
EXPOSE 18742
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/opt/wechatlinux/src/server.ts"]
