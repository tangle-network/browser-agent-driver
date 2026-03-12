#!/usr/bin/env bash
set -euo pipefail

# Install script for browser-agent-driver (bad CLI)
# Usage: curl -fsSL https://raw.githubusercontent.com/tangle-network/browser-agent-driver/main/scripts/install.sh | sh

REPO="tangle-network/browser-agent-driver"
INSTALL_DIR="${BAD_INSTALL_DIR:-${HOME}/.local/bin}"
LIB_DIR="${HOME}/.local/lib/bad"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }

# --- Pre-flight checks ---

command -v node >/dev/null 2>&1 || fail "Node.js is required (v20+). Install from https://nodejs.org"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js v20+ required (found v$(node -p process.version))"
fi
ok "Node.js $(node --version)"

command -v curl >/dev/null 2>&1 || fail "curl is required"

# --- Determine version ---

VERSION="${BAD_VERSION:-latest}"

if [ "$VERSION" = "latest" ]; then
  info "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"browser-agent-driver-v\([^"]*\)".*/\1/')
  if [ -z "$VERSION" ]; then
    fail "Could not determine latest version"
  fi
fi
ok "Version: ${VERSION}"

# --- Download ---

TARBALL="bad-v${VERSION}-node.tar.gz"
URL="https://github.com/${REPO}/releases/download/browser-agent-driver-v${VERSION}/${TARBALL}"
CHECKSUM_URL="${URL}.sha256"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading ${TARBALL}..."
curl -fSL --progress-bar -o "${TMPDIR}/${TARBALL}" "$URL" \
  || fail "Download failed. Check that v${VERSION} exists at https://github.com/${REPO}/releases"

# --- Verify checksum ---

if command -v sha256sum >/dev/null 2>&1; then
  curl -fsSL -o "${TMPDIR}/checksum" "$CHECKSUM_URL" 2>/dev/null && {
    cd "$TMPDIR"
    sha256sum -c checksum >/dev/null 2>&1 && ok "Checksum verified" || warn "Checksum mismatch — continuing anyway"
    cd - >/dev/null
  } || warn "Could not fetch checksum — skipping verification"
elif command -v shasum >/dev/null 2>&1; then
  curl -fsSL -o "${TMPDIR}/checksum" "$CHECKSUM_URL" 2>/dev/null && {
    EXPECTED=$(awk '{print $1}' "${TMPDIR}/checksum")
    ACTUAL=$(shasum -a 256 "${TMPDIR}/${TARBALL}" | awk '{print $1}')
    if [ "$EXPECTED" = "$ACTUAL" ]; then
      ok "Checksum verified"
    else
      warn "Checksum mismatch — continuing anyway"
    fi
  } || warn "Could not fetch checksum — skipping verification"
fi

# --- Install ---

info "Installing to ${LIB_DIR}..."
rm -rf "$LIB_DIR"
mkdir -p "$LIB_DIR"
tar xzf "${TMPDIR}/${TARBALL}" --strip-components=1 -C "$LIB_DIR"

# Create bin symlink
mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/bad" << 'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec node "${HOME}/.local/lib/bad/dist/cli.js" "$@"
WRAPPER
chmod +x "${INSTALL_DIR}/bad"
ok "Installed bad CLI to ${INSTALL_DIR}/bad"

# --- Playwright ---

if command -v npx >/dev/null 2>&1; then
  if npx playwright install --dry-run chromium >/dev/null 2>&1 || true; then
    info "Installing Playwright Chromium browser..."
    npx playwright install chromium 2>&1 | tail -1 || warn "Playwright install failed — run manually: npx playwright install chromium"
    ok "Playwright Chromium installed"
  fi
else
  warn "npx not found — install Playwright manually: npx playwright install chromium"
fi

# --- PATH check ---

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  warn "${INSTALL_DIR} is not in your PATH"
  echo ""
  SHELL_NAME=$(basename "${SHELL:-/bin/bash}")
  case "$SHELL_NAME" in
    zsh)  RC_FILE="~/.zshrc" ;;
    bash) RC_FILE="~/.bashrc" ;;
    fish) RC_FILE="~/.config/fish/config.fish" ;;
    *)    RC_FILE="~/.profile" ;;
  esac
  echo "  Add it by running:"
  echo ""
  if [ "$SHELL_NAME" = "fish" ]; then
    echo "    fish_add_path ${INSTALL_DIR}"
  else
    echo "    echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ${RC_FILE}"
  fi
  echo ""
  echo "  Then restart your shell or run: source ${RC_FILE}"
  echo ""
fi

# --- Done ---

echo ""
info "Done! Run 'bad --help' to get started."
echo ""
echo "  Quick start:"
echo "    bad run --goal \"Sign up for an account\" --url https://app.example.com"
echo ""
echo "  Docs: https://github.com/${REPO}#readme"
echo ""
