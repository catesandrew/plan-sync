#!/usr/bin/env bash
# Build the TS (dist/cli.js) and Go (go/plan-sync-go) binaries, then link both
# globally: `plan-sync` via npm link, `plan-sync-go` via symlink into BIN_DIR.
# Usage: scripts/install.sh [--no-npm-install]   BIN_DIR defaults to ~/.local/bin
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
root=$PWD
bin_dir=${BIN_DIR:-$HOME/.local/bin}

[[ ${1:-} == --no-npm-install ]] || npm install
npm run build
npm link

go/build.sh
mkdir -p "$bin_dir"
ln -sfn "$root/go/plan-sync-go" "$bin_dir/plan-sync-go"

echo "linked: $(command -v plan-sync || echo 'plan-sync (check npm global bin on PATH)')"
echo "linked: $bin_dir/plan-sync-go"
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "warning: $bin_dir not on PATH" ;; esac
