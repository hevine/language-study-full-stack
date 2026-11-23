#!/usr/bin/env bash
# 等本地识别服务就绪（最多 90 秒），并打印健康信息。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${ASR_LOCAL_PORT:-8108}"
URL="http://127.0.0.1:$PORT/health"

for i in $(seq 1 45); do
  body="$(curl -s -m 2 "$URL" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"status":"ok"'; then
    echo "本地识别服务就绪：$body"
    exit 0
  fi
  sleep 2
done

echo "本地识别服务未就绪（$URL）。日志：$HERE/logs/asr-local.err.log" >&2
tail -20 "$HERE/logs/asr-local.err.log" 2>/dev/null >&2 || true
exit 1
