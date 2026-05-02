#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
RESET='\033[0m'

info()  { echo -e "${GREEN}●${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚡${RESET} $*"; }
error() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "Node.js is required. Install it from https://nodejs.org"

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ is required (you have v${NODE_VERSION}). Upgrade at https://nodejs.org"
fi

info "Installing ${BOLD}term-bridge-agent${RESET}..."

if npm install -g term-bridge-agent 2>/dev/null; then
  info "Installed. Run ${BOLD}term-bridge${RESET} to share your terminal."
else
  warn "npm install failed. Trying with npx..."
  info "No global install needed. Just run: ${BOLD}npx term-bridge-agent${RESET}"
fi

echo ""
echo -e "  ${GRAY}Usage:${RESET} ${CYAN}term-bridge${RESET}"
echo -e "  ${GRAY}Then share the URL with your peer.${RESET}"
echo ""
