# Dockerfile for Claude Code Bugbot Autofix
# Multi-stage build: installs dependencies, builds TypeScript, then
# runs the daemon with gh CLI, claude CLI, and git available.
# Requires mounting gh and claude auth configs as volumes.

# ============================================================
# Stage 1: Build
# ============================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/

RUN git config --global user.email "bugbot-autofix@claude-code.local" \
  && git config --global user.name "Claude Code Bugbot Autofix" \
  && git config --global credential.https://github.com.helper "!/usr/bin/gh auth git-credential"

RUN mkdir -p /data/repos /data/db

ENV AUTOFIX_WORK_DIR=/data/repos
ENV AUTOFIX_DB_PATH=/data/db/state.db

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
