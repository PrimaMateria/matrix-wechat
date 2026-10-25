#!/bin/sh
# Step through the WeChat image viewer so the client downloads each original.
#
# WeChat writes <cacheID>.dat only when an image is opened; a thumbnail is all
# that arrives otherwise. There is no RPC that requests a download, so the
# viewer is driven instead: open one image by hand over VNC, then run this to
# walk the rest of the conversation.
#
#   walk-images.sh [steps] [delay-seconds] [key]
#
# Keys go through XTEST, which needs no window manager, but the viewer must
# already be open and focused.
set -eu

STEPS="${1:-50}"
DELAY="${2:-1.5}"
KEY="${3:-Right}"
DISPLAY="${DISPLAY:-:0}"
export DISPLAY

case "$STEPS" in ''|*[!0-9]*) echo "steps must be a number" >&2; exit 2;; esac

originals() {
  find /home/wechat -path '*/Img/*' -name '*.dat' ! -name '*_t.dat' 2>/dev/null | wc -l
}

WID=$(xdotool search --class -- wechat 2>/dev/null | tail -1 || true)
if [ -z "$WID" ]; then
  echo "No WeChat window on $DISPLAY" >&2
  exit 1
fi
xdotool windowfocus "$WID" 2>/dev/null || true

BEFORE=$(originals)
echo "window $WID, $BEFORE original(s) cached; sending $STEPS x $KEY"

i=0
while [ "$i" -lt "$STEPS" ]; do
  xdotool key --clearmodifiers "$KEY"
  sleep "$DELAY"
  i=$((i + 1))
  if [ $((i % 10)) -eq 0 ]; then
    echo "  $i/$STEPS, originals: $(originals)"
  fi
done

AFTER=$(originals)
echo "done: $BEFORE -> $AFTER originals (+$((AFTER - BEFORE)))"
