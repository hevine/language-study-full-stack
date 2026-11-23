#!/usr/bin/env bash
# 取消开机自启并停止本地识别服务。
set -euo pipefail
LABEL="cn.waiyu.asr-local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "==> 已停止并移除开机自启（$PLIST）"
