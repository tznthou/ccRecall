# 在 macOS 用 LaunchAgent 跑 ccRecall

> [English](launchd.md)

ccRecall 是本機 HTTP 服務——Claude Code 的 hooks 和 MCP 工具都從 `127.0.0.1:7749` 跟它溝通。要讓它跨重開機都活著、當掉自動重啟，把它裝成 per-user LaunchAgent 就對了。

## 自動安裝（推薦）

全域裝完 ccRecall 後（`pnpm add -g @tznthou/ccrecall` 或同類命令）：

```bash
ccmem install-daemon
```

這會：

1. 寫 `~/Library/LaunchAgents/com.tznthou.ccrecall.plist`
2. 建 log 目錄 `~/Library/Logs/ccrecall/`
3. 跑 `launchctl load -w`，daemon 立刻啟動，之後每次登入也會跑

驗證：

```bash
launchctl list | grep ccrecall
curl http://127.0.0.1:7749/health
```

想先看 plist 長什麼樣再裝：

```bash
ccmem install-daemon --dry-run
```

要停掉自動啟動並移除 plist：

```bash
ccmem uninstall-daemon
```

## 手動安裝

如果你想自己編 plist（或環境裡 `ccmem` 沒在 `PATH` 上），把以下內容寫進 `~/Library/LaunchAgents/com.tznthou.ccrecall.plist`：

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

把 `node` 路徑（`which node` 查）和 script 路徑換成你實際裝的位置。如果你是從 npm 裝的，script 路徑長這樣：

```bash
echo "$(npm root -g)/@tznthou/ccrecall/dist/index.js"
# pnpm / yarn 改成 `pnpm root -g` 或 `$(yarn global dir)/node_modules`
```

接著：

```bash
mkdir -p ~/Library/Logs/ccrecall
launchctl load -w ~/Library/LaunchAgents/com.tznthou.ccrecall.plist
```

## 疑難排解

- **`launchctl list` 看得到 agent 但 `/health` 連不上**
  看 `~/Library/Logs/ccrecall/ccrecall.err.log`。最常見的原因是 7749 port 被別的 process 佔了——改 plist 裡的 `CCRECALL_PORT` 後重新 load。
- **Daemon 一直反覆重啟（flap）**
  同一個 log 檔。找 SQLite 或權限錯誤。`~/.ccrecall/ccrecall.db` 壞掉的話可以搬走，下次啟動會自動重建。
- **改完設定要 reload**
  ```bash
  launchctl unload ~/Library/LaunchAgents/com.tznthou.ccrecall.plist
  launchctl load -w ~/Library/LaunchAgents/com.tznthou.ccrecall.plist
  ```
- **Linux / Windows**
  `install-daemon` 只支援 macOS。Linux 使用者可以用 systemd 跑 ccRecall（unit file 範例會在 Phase 5），或想簡單測試就 `nohup ccmem &`。
