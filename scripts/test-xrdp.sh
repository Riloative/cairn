#!/usr/bin/env bash
# Start a throwaway xrdp server for Cairn's RDP integration tests (Linux, needs root and
# the xrdp + xorgxrdp packages).
#
#   127.0.0.1:3389  xrdp with TLS (self-signed certificate); sessions run Xorg + xterm
#
# Creates user `cairnrdp` (password `cairn-rdp-pw`). xrdp has no NLA, so the client falls
# back to TLS and logs in with the Client Info credentials. Writes env vars to $DIR/env
# for `cargo test` (source it, then run tests with CAIRN_RDP_TESTS=1).
#
# Usage: sudo scripts/test-xrdp.sh [dir]     Stop: sudo scripts/test-xrdp.sh stop
set -euo pipefail
if [ "${1:-}" = "stop" ]; then
  pkill -x xrdp 2>/dev/null || true
  pkill -x xrdp-sesman 2>/dev/null || true
  exit 0
fi
DIR=${1:-/tmp/cairn-xrdp}
USER_NAME=cairnrdp
PASSWORD=cairn-rdp-pw

mkdir -p "$DIR"
id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"
echo "$USER_NAME:$PASSWORD" | chpasswd
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
# A bare X session: no desktop environment to install or wait for.
printf '#!/bin/sh\nexec xterm -geometry 80x24+20+20\n' > "$HOME_DIR/.xsession"
chmod +x "$HOME_DIR/.xsession"
chown "$USER_NAME:" "$HOME_DIR/.xsession"

# Self-signed TLS certificate for xrdp (the package's snakeoil may be missing).
if [ ! -s /etc/xrdp/cert.pem ] || [ ! -s /etc/xrdp/key.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=cairn-xrdp" \
    -keyout /etc/xrdp/key.pem -out /etc/xrdp/cert.pem 2>/dev/null
fi
chmod 644 /etc/xrdp/cert.pem
chmod 640 /etc/xrdp/key.pem
chgrp xrdp /etc/xrdp/key.pem 2>/dev/null || true
# Containers may lack the ssl-cert group the default key path needs.
usermod -aG ssl-cert xrdp 2>/dev/null || true

# Prefer TLS; allow the Xorg session to start without a console.
sed -i 's/^security_layer=.*/security_layer=negotiate/' /etc/xrdp/xrdp.ini
sed -i 's|^certificate=.*|certificate=/etc/xrdp/cert.pem|; s|^key_file=.*|key_file=/etc/xrdp/key.pem|' /etc/xrdp/xrdp.ini
if [ -f /etc/X11/Xwrapper.config ]; then
  sed -i 's/^allowed_users=.*/allowed_users=anybody/' /etc/X11/Xwrapper.config
fi

pkill -x xrdp 2>/dev/null || true
pkill -x xrdp-sesman 2>/dev/null || true
sleep 1
rm -f /var/run/xrdp/*.pid /var/run/xrdp-sesman.pid /var/run/xrdp.pid 2>/dev/null || true
mkdir -p /var/run/xrdp
xrdp-sesman
xrdp
for _ in $(seq 1 20); do
  if (exec 3<>/dev/tcp/127.0.0.1/3389) 2>/dev/null; then break; fi
  sleep 0.5
done

cat > "$DIR/env" <<ENV
export CAIRN_RDP_HOST=127.0.0.1
export CAIRN_RDP_PORT=3389
export CAIRN_RDP_USER=$USER_NAME
export CAIRN_RDP_PASSWORD=$PASSWORD
ENV
echo "xrdp listening on 127.0.0.1:3389 (env in $DIR/env)"
