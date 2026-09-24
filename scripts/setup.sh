#!/usr/bin/env bash
# Explicit developer setup assistant for macOS and Linux.
# This file is never run automatically by git clone.

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"

ok() { printf '✓ %s\n' "$1"; }
warn() { printf '⚠ %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1" >&2; }

ask() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

node_is_supported() {
  command_exists node && [[ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -ge 18 ]]
}

install_with_system_manager() {
  local package_name="$1"
  local purpose="$2"
  local install_command=""

  if [[ "$OS" == "Darwin" ]] && command_exists brew; then
    install_command="brew install $package_name"
  elif command_exists apt-get; then
    install_command="sudo apt-get update && sudo apt-get install -y $package_name"
  elif command_exists dnf; then
    install_command="sudo dnf install -y $package_name"
  elif command_exists pacman; then
    install_command="sudo pacman -Sy --needed $package_name"
  fi

  if [[ -z "$install_command" ]]; then
    warn "$purpose is missing. Install it with your system package manager, then run this script again."
    return 1
  fi

  warn "$purpose is missing. The following system-level command can install it: $install_command"
  if ask "Run this command?"; then
    eval "$install_command"
  else
    warn "Skipped installation."
    return 1
  fi
}

printf 'Vyntrix setup assistant\n'
printf 'Project: %s\n\n' "$PROJECT_DIR"

case "$OS" in
  Darwin) ok 'Operating system: macOS' ;;
  Linux) ok 'Operating system: Linux' ;;
  *)
    fail "This script supports macOS and Linux. On Windows run: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1"
    exit 1
    ;;
esac

if command_exists git; then
  ok "Git: $(git --version)"
else
  install_with_system_manager git 'Git is required to clone and manage this repository' || true
fi

if ! command_exists git; then
  fail 'Git is still unavailable. Install Git, then rerun this setup assistant.'
  exit 1
fi

if node_is_supported; then
  ok "Node.js: $(node --version)"
  [[ "$(node -p "process.versions.node.split('.')[0]")" == '20' ]] || warn 'Node 20 LTS is recommended; Node 18+ is supported.'
else
  if command_exists node; then
    warn "Node.js $(node --version) is too old. Node.js 18+ is required; Node 20 LTS is recommended."
  fi
  install_with_system_manager node 'Node.js 18+ is required to run Vyntrix' || true
fi

if command_exists npm; then
  ok "npm: $(npm --version)"
else
  warn 'npm is missing. It is normally installed with Node.js; reinstall or upgrade Node.js 18+.'
fi

if ! node_is_supported || ! command_exists npm; then
  fail 'Required tools are unavailable. Install Node.js 18+ (including npm), then rerun this setup assistant.'
  exit 1
fi

cd "$PROJECT_DIR"

if [[ -d node_modules ]]; then
  ok 'node_modules directory found.'
else
  warn 'node_modules directory is missing.'
fi

if ask 'Install or update project dependencies with npm install?'; then
  npm install
  ok 'Project dependencies installed.'
else
  warn 'Skipped npm install. Run it before starting if dependencies are missing.'
fi

if [[ -f .env.local ]]; then
  ok '.env.local found.'
else
  warn '.env.local is not present. It is optional for local development, but required values should be set before production.'
  if ask 'Create .env.local from .env.example?'; then
    cp .env.example .env.local
    ok 'Created .env.local. Set DATABASE_URL and replace the SESSION_SECRET placeholder before production use.'
  fi
fi

printf '\nRunning read-only diagnostics...\n\n'
npm run doctor || true

printf '\nSetup complete. Start Vyntrix with:\n  npm start\n'
