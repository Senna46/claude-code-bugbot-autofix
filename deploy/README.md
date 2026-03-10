# Fixooly Daemon (launchd)

Run Fixooly as a native macOS LaunchAgent so it starts on login and restarts on failure.

## Prerequisites

- `.env` configured (copy from `.env.example` and set `AUTOFIX_APP_ID`, `AUTOFIX_PRIVATE_KEY_PATH`, etc.)
- `npm run build` completed
- `claude` CLI installed and on PATH (`~/.local/bin` is included by default)

## Install

From the project root:

```bash
chmod +x deploy/install-daemon.sh
./deploy/install-daemon.sh
```

The script copies the LaunchAgent plist to `~/Library/LaunchAgents/` (with paths substituted), creates `~/.fixooly/logs/`, and loads the job. If the old `com.senna.bugbot-autofix` daemon is present, it will be automatically unloaded and removed.

## Commands

| Action | Command |
|--------|---------|
| Check status | `launchctl list | grep fixooly` |
| Stop | `launchctl stop com.senna.fixooly` |
| Start | `launchctl start com.senna.fixooly` |
| Unload (disable) | `launchctl unload ~/Library/LaunchAgents/com.senna.fixooly.plist` |
| View stdout | `tail -f ~/.fixooly/logs/stdout.log` |
| View stderr | `tail -f ~/.fixooly/logs/stderr.log` |

## Update after code changes

1. `npm run build`
2. `launchctl stop com.senna.fixooly && launchctl start com.senna.fixooly`

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.senna.fixooly.plist
rm ~/Library/LaunchAgents/com.senna.fixooly.plist
```
