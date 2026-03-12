#!/usr/bin/env bash
set -euo pipefail

# Uninstall browser-agent-driver (bad CLI)

INSTALL_DIR="${BAD_INSTALL_DIR:-${HOME}/.local/bin}"
LIB_DIR="${HOME}/.local/lib/bad"

removed=0

if [ -f "${INSTALL_DIR}/bad" ]; then
  rm -f "${INSTALL_DIR}/bad"
  echo "Removed ${INSTALL_DIR}/bad"
  removed=1
fi

if [ -d "$LIB_DIR" ]; then
  rm -rf "$LIB_DIR"
  echo "Removed ${LIB_DIR}"
  removed=1
fi

if [ "$removed" -eq 0 ]; then
  echo "Nothing to remove. bad CLI not found at ${INSTALL_DIR}/bad or ${LIB_DIR}"
else
  echo "Done. bad CLI uninstalled."
fi
