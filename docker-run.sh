#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
    exec /usr/bin/matrix-wechat "$@"
fi
if [ ! -f /data/config.yaml ]; then
    cp /opt/matrix-wechat/example-config.yaml /data/config.yaml
    echo "Created /data/config.yaml. Configure your homeserver and permissions, then restart."
    exit 0
fi
if [ ! -f /data/registration.yaml ]; then
    /usr/bin/matrix-wechat -g -c /data/config.yaml -r /data/registration.yaml
    echo "Created registration.yaml. Register it with the homeserver before restarting."
    exit 0
fi
exec /usr/bin/matrix-wechat -c /data/config.yaml -r /data/registration.yaml
