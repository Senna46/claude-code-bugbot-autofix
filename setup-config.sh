#!/bin/bash

# Fixooly - Setup Configuration Script
# This script automates the configuration setup for the Fixooly daemon.

set -e  # Exit on any error

echo "=== Fixooly Configuration Setup ==="

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

# GitHub App Credentials Setup
echo ""
echo "=== GitHub App Credentials Setup ==="
echo "You need a GitHub App with the required permissions."
echo "See: https://docs.github.com/en/apps/creating-github-apps"

# Check if AUTOFIX_APP_ID is already set
if grep -q "^AUTOFIX_APP_ID=.\+" .env 2>/dev/null; then
    echo "AUTOFIX_APP_ID already configured in .env"
else
    echo "Please enter your GitHub App ID:"
    read -r APP_ID
    if [ -n "$APP_ID" ]; then
        SAFE_APP_ID="$(printf '%s\n' "$APP_ID" | sed -e 's/[&\\/]/\\&/g')"
        sed -i.bak "s/^AUTOFIX_APP_ID=.*/AUTOFIX_APP_ID=$SAFE_APP_ID/" .env
        rm -f .env.bak
        echo "AUTOFIX_APP_ID set in .env"
    fi
fi

# Check if AUTOFIX_PRIVATE_KEY_PATH is already set
if grep -q "^AUTOFIX_PRIVATE_KEY_PATH=.\+" .env 2>/dev/null; then
    echo "AUTOFIX_PRIVATE_KEY_PATH already configured in .env"
else
    echo "Please enter the path to your GitHub App private key (.pem file):"
    read -r KEY_PATH
    if [ -n "$KEY_PATH" ]; then
        SAFE_KEY_PATH="$(printf '%s\n' "$KEY_PATH" | sed -e 's/[&\\/|]/\\&/g')"
        sed -i.bak "s|^AUTOFIX_PRIVATE_KEY_PATH=.*|AUTOFIX_PRIVATE_KEY_PATH=$SAFE_KEY_PATH|" .env
        rm -f .env.bak
        echo "AUTOFIX_PRIVATE_KEY_PATH set in .env"
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

echo ""
echo "=== Setup Complete ==="
echo "Configuration steps completed successfully!"
echo ""
echo "Next steps:"
echo "1. Install the GitHub App on your target organizations/user accounts"
echo "2. Run 'npm install' to install dependencies"
echo "3. Run 'npm run build' to compile the project"
echo "4. Run 'npm start' to start the daemon"
