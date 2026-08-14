#!/usr/bin/env bash
# Install the pinned DeepSeek Harness CLI (@deepseek-ai/dsh) into runtime/dsh/,
# the app-private sidecar bundle the Rust shell spawns (via runtime/dsh/launcher.mjs).
# The version must agree with the SDK's DSH_VERSION (tested by dsh-version.test.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."

DSH_VERSION="${DSH_VERSION:-0.1.0-rc.6}"
DIR="runtime/dsh"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to run the dsh sidecar" >&2
  exit 1
fi

echo "installing @deepseek-ai/dsh@${DSH_VERSION} into ${DIR}/"
mkdir -p "$DIR"
cat > "$DIR/package.json" <<EOF
{
  "name": "deeplab-dsh-sidecar",
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/dsh": "${DSH_VERSION}"
  }
}
EOF

(cd "$DIR" && npm install --no-save --no-package-lock)

echo "done: dsh ${DSH_VERSION} installed at ${DIR}/node_modules/@deepseek-ai/dsh"
