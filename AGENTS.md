# AGENTS.md

Guidelines for AI agents working on this codebase.

## Repository Purpose

This is **Claude Code Bugbot Autofix**, a daemon that automatically fixes bugs reported by
Cursor Bugbot on GitHub PRs using Claude Code. It does NOT detect bugs itself;
it only reads Cursor Bugbot review comments and generates fixes.

## Before Making Changes

1. Run `npm run typecheck` to verify the codebase compiles
2. Read the relevant source files before editing
3. Understand the polling daemon architecture (main.ts -> bugbotMonitor -> bugParser -> fixGenerator)

## Code Style Rules

- TypeScript with strict mode enabled
- ESM modules with `.js` import extensions
- lowerCamelCase for all identifiers (variables, functions, properties, methods)
- Every source file starts with a comment block describing purpose and limitations
- All user-facing text (logs, GitHub comments) must be in English
- Git commit messages must be in English only
- Use structured logging: `logger.info("message", { contextKey: contextValue })`
- Error handling must include detailed context (function name, relevant parameters)
- Prefer readability over efficiency

## Module Dependency Graph

    main.ts
      -> config.ts
      -> logger.ts
      -> githubClient.ts
      -> state.ts
      -> bugbotMonitor.ts
           -> bugParser.ts
           -> githubClient.ts
           -> state.ts
      -> fixGenerator.ts
      -> types.ts (shared by all)

## Key Interfaces

- Config: All AUTOFIX_* settings from environment
- BugbotBug: Parsed bug report from Cursor Bugbot comment
- PrBugReport: A PR with its list of unprocessed bugs
- FixResult: Commit SHA and list of fixed bugs after claude -p
- PullRequest: GitHub PR metadata (owner, repo, number, headRef, etc.)
- ReviewComment: Raw review comment data from GitHub API

## Testing Changes

After any code change:

    npm run typecheck    # Must pass with zero errors
    npm run build        # Must produce dist/ without errors

## Environment Variables

All config uses the AUTOFIX_ prefix. At minimum, set one of:
- AUTOFIX_GITHUB_ORGS (e.g. cauchye)
- AUTOFIX_GITHUB_REPOS (e.g. cauchye/ai-talent-mapping)

## Common Tasks

### Adding a new config option
1. Add field to Config interface in types.ts
2. Parse it in config.ts loadConfig()
3. Add to .env.example with documentation comment

### Modifying bug parsing
- Edit regex patterns in bugParser.ts
- The Cursor Bugbot comment format uses HTML comment markers:
  <!-- BUGBOT_BUG_ID: uuid -->, <!-- DESCRIPTION START/END -->,
  <!-- LOCATIONS START/END -->

### Changing fix generation behavior
- Edit fixGenerator.ts, specifically runClaudeFix() for the prompt
  and commitAndPush() for commit message format
- The claude -p allowed tools are: Read, Edit, Bash(git diff *), Bash(git status *)
