#!/bin/sh
# Installs Fixooly as a user LaunchAgent (runs on login, restarts on failure).
# Run from the project root: ./deploy/install-daemon.sh
# Requires: npm run build already done, .env configured.
# Migrates from the old com.senna.bugbot-autofix job if present.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_NAME="com.senna.fixooly"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
PLIST_DEST="${LAUNCH_AGENTS}/${PLIST_NAME}.plist"
LOG_DIR="${HOME}/.fixooly/logs"

OLD_PLIST_NAME="com.senna.bugbot-autofix"
OLD_PLIST_DEST="${LAUNCH_AGENTS}/${OLD_PLIST_NAME}.plist"

if [ ! -f "$PROJECT_ROOT/dist/main.js" ]; then
  echo "Error: dist/main.js not found. Run 'npm run build' first."
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/.env" ]; then
  echo "Warning: .env not found. Copy .env.example to .env and configure."
fi

NODE_BIN="$(which node)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Install Node.js first."
  exit 1
fi

# Migrate from old bugbot-autofix daemon if present
if [ -f "$OLD_PLIST_DEST" ]; then
  echo "Unloading old bugbot-autofix daemon..."
  launchctl unload "$OLD_PLIST_DEST" 2>/dev/null || true
  rm -f "$OLD_PLIST_DEST"
  echo "Old daemon removed."
fi

mkdir -p "$LAUNCH_AGENTS"
mkdir -p "$LOG_DIR"

# Escape sed-special characters in replacement values (& and \ with | delimiter)
escape_sed() {
  printf '%s\n' "$1" | sed -e 's/[&\\/|]/\\&/g'
}
SAFE_PROJECT_ROOT="$(escape_sed "$PROJECT_ROOT")"
SAFE_HOME="$(escape_sed "$HOME")"
SAFE_NODE_BIN="$(escape_sed "$NODE_BIN")"

sed -e "s|__PROJECT_ROOT__|$SAFE_PROJECT_ROOT|g" -e "s|__HOME__|$SAFE_HOME|g" -e "s|__NODE_PATH__|$SAFE_NODE_BIN|g" \
  "$SCRIPT_DIR/fixooly-daemon.plist" > "$PLIST_DEST"
chmod 644 "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
echo "Fixooly daemon installed. Logs: $LOG_DIR/stdout.log and $LOG_DIR/stderr.log"
echo "Commands: launchctl list | grep fixooly | start/stop: launchctl start/stop $PLIST_NAME"
