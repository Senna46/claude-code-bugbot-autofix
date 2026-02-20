# CLAUDE.md

Instructions for Claude Code when working on this codebase.

## Project Overview

Bugbot Autofix is a TypeScript daemon that monitors GitHub PRs for Cursor Bugbot
review comments, parses bug reports, and auto-fixes them using Claude Code
(claude -p). Fixes are committed directly to the PR head branch.

## Tech Stack

- Language: TypeScript (ES2022, Node16 modules)
- Runtime: Node.js >= 18
- Package Manager: npm
- GitHub API: Octokit (via octokit package)
- State: SQLite (via better-sqlite3)
- Config: dotenv
- Fix generation: claude -p CLI with Read, Edit, Bash tools

## Project Structure

    src/
      main.ts              AutofixDaemon entry point, polling loop
      config.ts            AUTOFIX_* environment variable loader
      types.ts             Shared interfaces (Config, BugbotBug, FixResult, PullRequest)
      logger.ts            Structured logger with level support
      githubClient.ts      Octokit wrapper (PR list, review comments, issue comments)
      bugbotMonitor.ts     Discovers unprocessed cursor[bot] bugs across repos/orgs
      bugParser.ts         Parses Cursor Bugbot comment format into BugbotBug objects
      fixGenerator.ts      Clones repo, runs claude -p, commits and pushes fixes
      state.ts             SQLite state tracking (processed_bugs table)

## Build and Run Commands

    npm install          # Install dependencies
    npm run build        # Compile TypeScript to dist/
    npm start            # Run compiled daemon
    npm run dev          # Run with tsx (development)
    npm run typecheck    # Type check without emitting

## Coding Conventions

- ESM modules: all imports use .js extension (e.g. import { X } from "./foo.js")
- lowerCamelCase for variables, functions, properties, and methods
- Structured logging: logger.info("message", { key: value })
- Error messages include function context and relevant parameters
- Comments at file top describe purpose and limitations (in English)
- User-facing text (logs, PR comments) in English
- Git commit messages in English only

## Key Patterns

- Polling daemon: AutofixDaemon.run() loops with configurable sleep interval,
  interruptible via SIGINT/SIGTERM
- GitHub auth: GH_TOKEN env var takes priority, falls back to gh auth token CLI
- Bugbot comment parsing: Regex extraction of BUGBOT_BUG_ID, DESCRIPTION, and
  LOCATIONS markers from cursor[bot] review comments
- Fix generation: claude -p is spawned as a child process with prompt piped via
  stdin; allowed tools are Read, Edit, and limited Bash (git diff/status only)
- State: SQLite processed_bugs table with bug_id PRIMARY KEY prevents duplicates
- Repo cloning: Repos cloned to {workDir}/{owner}/{repo}/; reused with git fetch

## Important Notes

- The daemon processes PRs sequentially (single-threaded)
- Bug parser depends on Cursor Bugbot comment format which may change
- Fix generator has a 10-minute timeout for claude -p
- Git operations have a 2-minute timeout
- Fixes commit directly to the PR head branch (no separate fix branch)
