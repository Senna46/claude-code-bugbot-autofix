#!/bin/bash

# Claude Code Bugbot Autofix - Setup Configuration Script
# This script automates the configuration setup for the bugbot autofix daemon.

set -e  # Exit on any error

echo "=== Claude Code Bugbot Autofix Configuration Setup ==="

# Detect OS
OS_TYPE=""
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS_TYPE="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS_TYPE="macos"
else
    echo "Unsupported OS: $OSTYPE"
    exit 1
fi

echo "Detected OS: $OS_TYPE"

# Check if required tools are installed
echo "Checking for required tools..."
if ! command -v gh &> /dev/null; then
    echo "Error: gh CLI is not installed. Please install it from https://cli.github.com/"
    exit 1
fi

if ! command -v claude &> /dev/null; then
    echo "Error: claude CLI is not installed. Please install it from https://github.com/anthropics/claude-code"
    exit 1
fi

# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo "Creating .env file..."
    cp .env.example .env
    echo "Created .env from .env.example"
else
    echo ".env file already exists"
fi

# GitHub Authentication Setup
echo ""
echo "=== GitHub Authentication Setup ==="

if [ "$OS_TYPE" = "linux" ]; then
    echo "For Linux, running 'gh auth login' to authenticate with GitHub..."
    gh auth login
elif [ "$OS_TYPE" = "macos" ]; then
    echo "For macOS, running 'gh auth login' to authenticate with GitHub..."
    gh auth login
    
    # Check if GH_TOKEN is set in .env
    if grep -q "^GH_TOKEN=" .env 2>/dev/null; then
        echo "GH_TOKEN already configured in .env"
    else
        echo "Please enter your GitHub token (obtained via 'gh auth token'):"
        read -r GH_TOKEN
        if [ -n "$GH_TOKEN" ]; then
            echo "GH_TOKEN=$GH_TOKEN" >> .env
            echo "GH_TOKEN added to .env file"
        fi
    fi
fi

# Claude Code Authentication Setup
echo ""
echo "=== Claude Code Authentication Setup ==="

if [ "$OS_TYPE" = "linux" ]; then
    echo "For Linux, running 'claude login' to authenticate with Claude Code..."
    claude login
elif [ "$OS_TYPE" = "macos" ]; then
    echo "For macOS, running 'claude login' to authenticate with Claude Code..."
    claude login
    
    # Check if CLAUDE_CODE_OAUTH_TOKEN is set in .env
    if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" .env 2>/dev/null; then
        echo "CLAUDE_CODE_OAUTH_TOKEN already configured in .env"
    else
        echo "Please enter your Claude Code OAuth token (obtained via 'claude setup-token'):"
        read -r CLAUDE_TOKEN
        if [ -n "$CLAUDE_TOKEN" ]; then
            echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_TOKEN" >> .env
            echo "CLAUDE_CODE_OAUTH_TOKEN added to .env file"
        fi
    fi
fi

# Make the script executable
chmod +x setup-config.sh

echo ""
echo "=== Setup Complete ==="
echo "Configuration steps completed successfully!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your settings (AUTOFIX_GITHUB_ORGS or AUTOFIX_GITHUB_REPOS)"
echo "2. Run 'npm install' to install dependencies"
echo "3. Run 'npm run build' to compile the project"
echo "4. Run 'npm start' to start the daemon"
