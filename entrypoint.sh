#!/bin/bash
# Entrypoint for Fixooly Docker container.
# Verifies Claude CLI authentication and GitHub App credentials
# before starting the daemon.

set -e

# Fix ~/.claude.json if Docker created it as a directory
if [ -d /root/.claude.json ]; then
  echo "WARNING: /root/.claude.json is a directory. Removing and creating as file."
  rm -rf /root/.claude.json
  echo '{}' > /root/.claude.json
fi

# Ensure ~/.claude.json exists
if [ ! -f /root/.claude.json ]; then
  echo '{}' > /root/.claude.json
fi

# Check Claude CLI auth
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "Claude authentication configured via environment variable."
elif [ -f /root/.claude/.credentials.json ]; then
  echo "Claude authentication configured via credentials file."
else
  echo "WARNING: No Claude authentication detected."
  echo "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or mount ~/.claude with credentials."
fi

# Check GitHub App credentials
if [ -n "$AUTOFIX_APP_ID" ] && { [ -n "$AUTOFIX_PRIVATE_KEY_PATH" ] || [ -n "$AUTOFIX_PRIVATE_KEY" ]; }; then
  echo "GitHub App credentials configured."
else
  echo "WARNING: GitHub App credentials incomplete."
  echo "Set AUTOFIX_APP_ID and AUTOFIX_PRIVATE_KEY_PATH (or AUTOFIX_PRIVATE_KEY)."
fi

echo "Starting Fixooly daemon..."
exec node dist/main.js
