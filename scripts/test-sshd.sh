#!/usr/bin/env bash
# Start throwaway OpenSSH servers for Cairn's SSH integration tests (Linux, needs root).
#
#   modern  127.0.0.1:2222  default algorithms; password, publickey, keyboard-interactive
#   legacy  127.0.0.1:2223  ONLY dh-group1/14-sha1, ssh-rsa host key, aes-cbc, hmac-sha1
#
# Creates user `cairntest` (password `cairn-test-pw`) and client keys (ed25519, ecdsa,
# RSA encrypted with passphrase `cairn-key-pw`). Writes env vars to $DIR/env for
# `cargo test` (source it, then run tests with CAIRN_SSH_TESTS=1).
#
# Usage: sudo scripts/test-sshd.sh [dir]     Stop: sudo scripts/test-sshd.sh stop [dir]
set -euo pipefail
DIR=${2:-${1:-/tmp/cairn-sshd}}
[ "${1:-}" = "stop" ] && { pkill -F "$DIR/modern.pid" 2>/dev/null || true; pkill -F "$DIR/legacy.pid" 2>/dev/null || true; exit 0; }
DIR=${1:-/tmp/cairn-sshd}
USER_NAME=cairntest
PASSWORD=cairn-test-pw
KEY_PW=cairn-key-pw

mkdir -p "$DIR" /run/sshd
chmod 755 "$DIR"
id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"
echo "$USER_NAME:$PASSWORD" | chpasswd
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)

# Host keys.
[ -f "$DIR/host_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -f "$DIR/host_ed25519"
[ -f "$DIR/host_rsa" ] || ssh-keygen -q -t rsa -b 2048 -N "" -f "$DIR/host_rsa"

# Client keys.
[ -f "$DIR/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C cairn-ed25519 -f "$DIR/id_ed25519"
[ -f "$DIR/id_ecdsa" ] || ssh-keygen -q -t ecdsa -b 256 -N "" -C cairn-ecdsa -f "$DIR/id_ecdsa"
[ -f "$DIR/id_rsa_enc" ] || ssh-keygen -q -t rsa -b 2048 -N "$KEY_PW" -C cairn-rsa -f "$DIR/id_rsa_enc"
chmod 644 "$DIR"/id_*
mkdir -p "$HOME_DIR/.ssh"
cat "$DIR"/id_*.pub > "$HOME_DIR/.ssh/authorized_keys"
chown -R "$USER_NAME:" "$HOME_DIR/.ssh"
chmod 700 "$HOME_DIR/.ssh"; chmod 600 "$HOME_DIR/.ssh/authorized_keys"

common() {
  cat <<CFG
ListenAddress 127.0.0.1
PidFile $DIR/$1.pid
PasswordAuthentication yes
PubkeyAuthentication yes
KbdInteractiveAuthentication yes
UsePAM yes
AllowUsers $USER_NAME
AllowAgentForwarding yes
AllowTcpForwarding yes
PermitRootLogin no
Subsystem sftp internal-sftp
LogLevel VERBOSE
CFG
}

{ common modern; cat <<CFG
Port 2222
HostKey $DIR/host_ed25519
HostKey $DIR/host_rsa
CFG
} > "$DIR/sshd_modern.conf"

{ common legacy; cat <<CFG
Port 2223
HostKey $DIR/host_rsa
KexAlgorithms diffie-hellman-group1-sha1,diffie-hellman-group14-sha1
HostKeyAlgorithms ssh-rsa
PubkeyAcceptedAlgorithms +ssh-rsa
Ciphers aes128-cbc,aes256-cbc
MACs hmac-sha1
CFG
} > "$DIR/sshd_legacy.conf"

for name in modern legacy; do
  pkill -F "$DIR/$name.pid" 2>/dev/null || true
  /usr/sbin/sshd -t -f "$DIR/sshd_$name.conf"
  /usr/sbin/sshd -f "$DIR/sshd_$name.conf" -E "$DIR/sshd_$name.log"
done

cat > "$DIR/env" <<ENV
export CAIRN_SSH_HOST=127.0.0.1
export CAIRN_SSH_PORT=2222
export CAIRN_SSH_LEGACY_PORT=2223
export CAIRN_SSH_USER=$USER_NAME
export CAIRN_SSH_PASSWORD=$PASSWORD
export CAIRN_SSH_KEY_ED25519=$DIR/id_ed25519
export CAIRN_SSH_KEY_ECDSA=$DIR/id_ecdsa
export CAIRN_SSH_KEY_RSA_ENC=$DIR/id_rsa_enc
export CAIRN_SSH_KEY_PASSPHRASE=$KEY_PW
export CAIRN_SSH_HOST_ED25519_PUB=$DIR/host_ed25519.pub
export CAIRN_SSH_HOST_RSA_PUB=$DIR/host_rsa.pub
ENV
sleep 0.5
echo "sshd running on 2222 (modern) and 2223 (legacy); env in $DIR/env"
