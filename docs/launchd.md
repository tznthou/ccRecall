# Running ccRecall as a macOS LaunchAgent

ccRecall runs as a local HTTP service — Claude Code hooks and the MCP tools
talk to it on `127.0.0.1:7749`. To keep it running across reboots and to
auto-restart on crash, install it as a per-user LaunchAgent.

## Automatic install (recommended)

After installing ccRecall globally (`pnpm add -g @tznthou/ccrecall` or equivalent):

```bash
ccmem install-daemon
```

This will:

1. Write `~/Library/LaunchAgents/com.tznthou.ccrecall.plist`
2. Create the log directory `~/Library/Logs/ccrecall/`
3. Run `launchctl load -w` so the daemon starts immediately and at every login

Verify:

```bash
launchctl list | grep ccrecall
curl http://127.0.0.1:7749/health
```

To preview the plist before installing:

```bash
ccmem install-daemon --dry-run
```

To stop auto-start and remove the plist:

```bash
ccmem uninstall-daemon
```

## Manual install

If you prefer to edit the plist by hand (or you're on a system where the
`ccmem` bin isn't on `PATH`), write the following to
`~/Library/LaunchAgents/com.tznthou.ccrecall.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tznthou.ccrecall</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/absolute/path/to/ccrecall/dist/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/ccrecall/ccrecall.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/ccrecall/ccrecall.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CCRECALL_PORT</key>
    <string>7749</string>
  </dict>
</dict>
</plist>
```

Replace the `node` path (`which node`) and the script path with your install
location. If you installed from npm, the script path is:

```bash
echo "$(npm root -g)/@tznthou/ccrecall/dist/index.js"
# pnpm / yarn: swap to `pnpm root -g` or `$(yarn global dir)/node_modules`
```

Then:

```bash
mkdir -p ~/Library/Logs/ccrecall
launchctl load -w ~/Library/LaunchAgents/com.tznthou.ccrecall.plist
```

## Troubleshooting

- **`launchctl list` shows the agent but `/health` is unreachable**
  Check `~/Library/Logs/ccrecall/ccrecall.err.log`. The most common cause is
  another process holding port 7749 — change `CCRECALL_PORT` in the plist and
  reload.
- **Daemon flaps (keeps restarting)**
  Same log file. Look for SQLite or permission errors. A corrupted DB at
  `~/.ccrecall/ccrecall.db` can be moved aside and will be rebuilt on next boot.
- **Reload after config changes**
  ```bash
  launchctl unload ~/Library/LaunchAgents/com.tznthou.ccrecall.plist
  launchctl load -w ~/Library/LaunchAgents/com.tznthou.ccrecall.plist
  ```
- **Linux / Windows**
  `install-daemon` is macOS only. Linux users can run ccRecall under systemd
  (example unit files in Phase 5), or just `nohup ccmem &` for a quick local
  setup.
