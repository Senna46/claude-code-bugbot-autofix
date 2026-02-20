#!/bin/bash
# Entrypoint for Bugbot Autofix Docker container.
# Verifies Claude CLI authentication and onboarding state
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

# Check GitHub auth
if [ -n "$GH_TOKEN" ]; then
  echo "GitHub authentication configured via GH_TOKEN."
elif gh auth status >/dev/null 2>&1; then
  echo "GitHub authentication configured via gh CLI."
else
  echo "WARNING: No GitHub authentication detected."
  echo "Set GH_TOKEN or mount ~/.config/gh with valid auth."
fi

echo "Starting Bugbot Autofix daemon..."
exec node dist/main.js
