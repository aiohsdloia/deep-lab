#!/usr/bin/env bash
# Fetch the bundled DeepSeek Harness ACP runtime (runtime/dsh-acp/node_modules,
# git-ignored; bundled into the installer as Tauri resources). Mirrors
# fetch-skills.sh: runs locally and in CI so the packages never live in git.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/runtime/dsh-acp"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to fetch the dsh ACP runtime" >&2
  exit 1
fi

echo "Installing dsh ACP runtime in $OUT_DIR (node_modules is git-ignored)"
npm install --prefix "$OUT_DIR" --omit=dev --no-audit --no-fund
echo "Done:"
ls "$OUT_DIR/node_modules/@deepseek-ai"
