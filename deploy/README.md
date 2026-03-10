# Bugbot Autofix Daemon (launchd)

Run the Autofix daemon as a native macOS LaunchAgent so it starts on login and restarts on failure.

## Prerequisites

- `.env` configured (copy from `.env.example` and set `AUTOFIX_GITHUB_ORGS` or `AUTOFIX_GITHUB_REPOS`, tokens, etc.)
- `npm run build` completed
- `claude` CLI installed and on PATH (`~/.local/bin` is included by default)

## Install

From the project root:

```bash
chmod +x deploy/install-daemon.sh
./deploy/install-daemon.sh
```

The script copies the LaunchAgent plist to `~/Library/LaunchAgents/` (with paths substituted), creates `~/.bugbot-autofix/logs/`, and loads the job.

## Commands

| Action | Command |
|--------|---------|
| Check status | `launchctl list | grep bugbot` |
| Stop | `launchctl stop com.senna.bugbot-autofix` |
| Start | `launchctl start com.senna.bugbot-autofix` |
| Unload (disable) | `launchctl unload ~/Library/LaunchAgents/com.senna.bugbot-autofix.plist` |
| View stdout | `tail -f ~/.bugbot-autofix/logs/stdout.log` |
| View stderr | `tail -f ~/.bugbot-autofix/logs/stderr.log` |

## Update after code changes

1. `npm run build`
2. `launchctl stop com.senna.bugbot-autofix && launchctl start com.senna.bugbot-autofix`

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.senna.bugbot-autofix.plist
rm ~/Library/LaunchAgents/com.senna.bugbot-autofix.plist
```
