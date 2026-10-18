#!/usr/bin/env bash
# Launch a built Cairn binary under Xvfb and capture a screenshot of the main window.
# Usage: scripts/screenshot.sh <path-to-binary> <output.png>
set -euo pipefail
BIN=${1:?binary path}
OUT=${2:?output png}
export DISPLAY=${DISPLAY:-:99}
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1400x900x24 >/dev/null 2>&1 &
  sleep 2
fi
WEBKIT_DISABLE_DMABUF_RENDERER=1 "$BIN" &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
mkdir -p "$(dirname "$OUT")"
sleep 10
kill -0 $PID # fail if the app exited early
import -window root "$OUT"
echo "Saved $OUT"
