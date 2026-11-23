#!/usr/bin/env bash
# 注册成 macOS LaunchAgent：登录即启动、进程挂了自动拉起，兜底才真的“总在”。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/bin/python"
LABEL="cn.waiyu.asr-local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${ASR_LOCAL_PORT:-8108}"

if [ ! -x "$PY" ] || [ ! -f "$HERE/models/SenseVoiceSmall/model.pt" ]; then
  echo "请先执行 npm run asr:setup 完成安装与模型下载" >&2
  exit 1
fi

mkdir -p "$HERE/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$HERE/server.py</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ASR_LOCAL_PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HERE/logs/asr-local.log</string>
  <key>StandardErrorPath</key><string>$HERE/logs/asr-local.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "==> 已注册开机自启：$PLIST"
bash "$HERE/health.sh"
