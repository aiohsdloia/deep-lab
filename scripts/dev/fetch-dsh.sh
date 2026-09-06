#!/usr/bin/env bash
# Install the pinned DeepSeek Harness CLI (@deepseek-ai/dsh) into runtime/dsh/,
# the app-private sidecar bundle the Rust shell spawns (via runtime/dsh/launcher.mjs).
# The version must agree with the SDK's DSH_VERSION (tested by dsh-version.test.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."

DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
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

# Tauri copies resources as regular files and directories. pnpm-style links
# are not preserved in Windows bundles, so always replace any existing tree
# and use npm's link-free nested layout, including runtime peer dependencies.
rm -rf "$DIR/node_modules"
(cd "$DIR" && npm install --no-save --no-package-lock --install-strategy=nested)

# Self-check: fail loudly if the install produced a partial dependency tree
# (an incomplete copy boots far enough to open windows, then the sidecar crashes
# with a Cordis loader error). Catches it at fetch time instead.
node scripts/dev/check-dsh-bundle.mjs --root "$DIR" --min-files 1
if [ $? -ne 0 ]; then
  echo "error: dsh ${DSH_VERSION} failed bundle integrity verification under ${DIR}/" >&2
  exit 1
fi

echo "done: dsh ${DSH_VERSION} installed at ${DIR}/node_modules/@deepseek-ai/dsh"
