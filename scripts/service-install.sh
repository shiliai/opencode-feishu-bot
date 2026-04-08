#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_NAME="opencode-feishu-bridge"
SERVICE_FILE="$REPO_ROOT/systemd/${UNIT_NAME}.service"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

mkdir -p "$USER_SYSTEMD_DIR"

sed \
  -e "s|%h/opencode-feishu-bridge|${REPO_ROOT}|g" \
  -e "s|/usr/bin/node|${NODE_BIN}|g" \
  "$SERVICE_FILE" > "${USER_SYSTEMD_DIR}/${UNIT_NAME}.service"

echo "Installed service file to ${USER_SYSTEMD_DIR}/${UNIT_NAME}.service"
echo "  WorkingDirectory: ${REPO_ROOT}"
echo "  ExecStart: ${NODE_BIN} ${REPO_ROOT}/dist/index.js"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"

echo ""
echo "Service installed and enabled. Start with:"
echo "  systemctl --user start ${UNIT_NAME}"
echo ""
echo "Check status:"
echo "  systemctl --user status ${UNIT_NAME}"
echo ""
echo "View logs:"
echo "  journalctl --user -u ${UNIT_NAME} -f"
echo ""
echo "For services to persist after logout:"
echo "  sudo loginctl enable-linger \$USER"
