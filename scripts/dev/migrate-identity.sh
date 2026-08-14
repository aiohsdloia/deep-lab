#!/usr/bin/env bash
# Migrate Open Lab's app container to its new bundle identity
# (com.ai4s.workbench -> com.sculab.openlab), freeing com.ai4s.workbench for the
# original Open Science app so the two can run side by side.
#
# Run ONLY after quitting BOTH apps (Cmd+Q):
#   bash scripts/dev/migrate-identity.sh
set -euo pipefail

OLD="$HOME/Library/Application Support/com.ai4s.workbench"
NEW="$HOME/Library/Application Support/com.sculab.openlab"

echo "==> Checking no Open Lab / Open Science instance is still running..."
RUNNING=$(ps ax -o args | grep -iE "Open Lab\.app|Open Science\.app|opencode serve" | grep -v grep || true)
if [ -n "$RUNNING" ]; then
  echo "!! These processes are still running — quit them first (Cmd+Q):"
  echo "$RUNNING" | sed 's/^/   /'
  echo "   Then re-run this script."
  exit 1
fi

if [ ! -d "$OLD" ]; then
  echo "!! $OLD does not exist — nothing to migrate. Aborting."
  exit 1
fi

if [ -d "$NEW" ]; then
  echo "==> Removing the empty container the first (empty) launch created..."
  rm -rf "$NEW"
fi

echo "==> Moving $OLD -> $NEW"
mv "$OLD" "$NEW"

echo "==> Done. Launch the new Open Lab from /Applications/Open Lab.app —"
echo "    sessions, projects, providers and MCP are all back."
