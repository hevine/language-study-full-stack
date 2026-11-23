#!/usr/bin/env bash
# 前台启动本地识别服务（Ctrl+C 停止）。想让它在后台常驻，用 agent-install.sh。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "还没有安装运行环境，请先执行：npm run asr:setup" >&2
  exit 1
fi
if [ ! -f "$HERE/models/SenseVoiceSmall/model.pt" ]; then
  echo "还没有下载模型，请先执行：npm run asr:setup" >&2
  exit 1
fi

exec "$PY" "$HERE/server.py"
