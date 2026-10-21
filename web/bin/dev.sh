#!/usr/bin/env bash
# Run overmind-web in the foreground for development.
# Usage: bin/dev.sh [port]
#   Uses the shared overmind config ($OVERMIND_CONFIG or ~/.config/overmind/config.json);
#   without one it runs as a single local host on 127.0.0.1.
#   Env: OVERMIND_CONFIG, OVERMIND_WEB_BIND (default here: 127.0.0.1), OVERMIND_WEB_UI, OVERMIND_BIN.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-${OVERMIND_WEB_PORT:-7799}}"
BIND="${OVERMIND_WEB_BIND:-127.0.0.1}"

echo "overmind-web dev  config=${OVERMIND_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/overmind/config.json}  port=${PORT}"
echo "  http://${BIND}:${PORT}/"
exec env OVERMIND_WEB_PORT="$PORT" OVERMIND_WEB_BIND="$BIND" node "$WEB_DIR/server.mjs"
