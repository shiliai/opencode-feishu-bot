#!/usr/bin/env bash
set -euo pipefail

UNIT_NAME="opencode-feishu-bridge"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"

if [ -f "${USER_SYSTEMD_DIR}/${UNIT_NAME}.service" ]; then
  systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
  systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
  rm -f "${USER_SYSTEMD_DIR}/${UNIT_NAME}.service"
  systemctl --user daemon-reload
  echo "Service uninstalled."
else
  echo "Service file not found at ${USER_SYSTEMD_DIR}/${UNIT_NAME}.service"
fi
