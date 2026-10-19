#!/usr/bin/env bash
# Start a throwaway Telnet server for integration tests (Linux): inetutils telnetd,
# handed each TCP connection by socat, running /bin/sh instead of login.
# Usage: sudo scripts/test-telnetd.sh [port]   (default 2323)
set -euo pipefail
PORT=${1:-2323}
TELNETD=$(command -v telnetd || echo /usr/sbin/telnetd)
pkill -f "TCP-LISTEN:$PORT" 2>/dev/null || true
nohup socat "TCP-LISTEN:$PORT,reuseaddr,fork,bind=127.0.0.1" "EXEC:$TELNETD -E /bin/sh,nofork" >/dev/null 2>&1 &
sleep 0.5
echo "telnetd listening on 127.0.0.1:$PORT"
