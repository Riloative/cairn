#!/usr/bin/env bash
# Drive a release build of Cairn under Xvfb through first-run setup, the command palette,
# theme switching, settings, lock, a failed unlock and unlock, capturing a screenshot of
# each key screen. Fails if the app dies or the vault was not created.
#
# Usage: scripts/ui-smoke.sh <path-to-cairn-binary> <output-dir>
# Needs: Xvfb, xdotool, imagemagick (import), x11-utils (xdpyinfo).
set -euo pipefail
BIN=$(realpath "${1:?binary path}")
OUT=${2:?output directory}
mkdir -p "$OUT"
OUT=$(realpath "$OUT")

export DISPLAY=${SMOKE_DISPLAY:-:97}
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1400x900x24 >/dev/null 2>&1 &
  XVFB=$!
  sleep 2
fi

# Isolated, throwaway data directory.
export XDG_DATA_HOME
XDG_DATA_HOME=$(mktemp -d)
WEBKIT_DISABLE_DMABUF_RENDERER=1 "$BIN" >"$OUT/app.log" 2>&1 &
APP=$!
cleanup() {
  kill "$APP" 2>/dev/null || true
  [ -n "${XVFB:-}" ] && kill "$XVFB" 2>/dev/null || true
  rm -rf "$XDG_DATA_HOME"
}
trap cleanup EXIT

WID=$(timeout 30 xdotool search --sync --name '^Cairn$' | head -1)
xdotool windowfocus --sync "$WID" 2>/dev/null || true
sleep 4

alive() { kill -0 "$APP" || { echo "Cairn exited unexpectedly"; cat "$OUT/app.log"; exit 1; }; }
shot() { alive; import -window root "$OUT/$1.png"; echo "captured $1"; }
type_text() { xdotool type --delay 15 "$1"; }

PW='glacier-tandem-orbit-velvet'
shot 01-setup
type_text "$PW"; sleep 1
shot 02-setup-strength
xdotool key Tab; type_text "$PW"; xdotool key Tab space Return
sleep 6
shot 03-sessions-empty
xdotool key ctrl+k; sleep 1
shot 04-command-palette
type_text "theme obsidian"; xdotool key Return; sleep 1
xdotool key ctrl+comma; sleep 1
shot 05-settings-obsidian
for theme in midnight graphite paper porcelain sand; do
  xdotool key ctrl+k; sleep 0.5; type_text "theme $theme"; xdotool key Return; sleep 1
  shot "06-theme-$theme"
done
xdotool key ctrl+shift+l; sleep 1
shot 07-locked
type_text "not-the-password"; xdotool key Return; sleep 4
shot 08-wrong-password
type_text "$PW"; xdotool key Return; sleep 4
xdotool key ctrl+4; sleep 1.5
shot 09-audit

# Local terminal: colors, resize, a privileged-looking prompt, then exit closes the tab.
xdotool key ctrl+t; sleep 3
type_text 'printf "\033[1;32mgreen\033[0m \033[38;2;255;100;0mtruecolor\033[0m\n"; tput cols; tput lines'
xdotool key Return; sleep 1.5
shot 10-terminal
type_text 'PS1="core-sw1# " sh'; xdotool key Return; sleep 1.5
shot 11-terminal-privileged

if grep -q "\[ui error\]" "$OUT/app.log"; then
  echo "The UI reported errors:"; grep "\[ui error\]" "$OUT/app.log"; exit 1
fi
test -f "$XDG_DATA_HOME/app.cairn.desktop/vault.json" || { echo "vault.json missing"; exit 1; }
test -f "$XDG_DATA_HOME/app.cairn.desktop/cairn.db" || { echo "cairn.db missing"; exit 1; }
echo "UI smoke test passed; screenshots in $OUT"
