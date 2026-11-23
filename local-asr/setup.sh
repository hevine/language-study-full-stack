#!/usr/bin/env bash
# 一次性安装：建 venv → 装 torch/FunASR → 下载 SenseVoiceSmall 与 VAD 模型
# 可重复执行，已装好的部分会跳过。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"
PY="$VENV/bin/python"
MIRROR="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"

echo "==> 项目目录：$HERE"

if [ ! -x "$PY" ]; then
  echo "==> 创建虚拟环境 $VENV"
  python3 -m venv "$VENV" || python3 -m venv --without-pip "$VENV"
fi

if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "==> venv 内没有 pip，尝试引导"
  "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  # 某些 Python 发行版的 ensurepip 会失败，借用系统 pip 往 venv 里装一份
  python3 -m pip --python "$PY" install -q -U pip || {
    echo "!! 无法在 venv 里安装 pip，请先修好 python3-pip 再重跑" >&2
    exit 1
  }
fi
echo "==> $( "$PY" -m pip --version )"

echo "==> 安装依赖（首次约 300-600MB，请耐心等待）"
"$PY" -m pip install --upgrade -i "$MIRROR" \
  "torch>=2.6" torchaudio funasr modelscope fastapi "uvicorn[standard]" python-multipart

echo "==> 下载模型到 $HERE/models"
"$PY" "$HERE/fetch_models.py"

echo
echo "全部完成。启动本地识别服务：npm run asr:start"
echo "设置开机自启（推荐，兜底才靠得住）：bash local-asr/agent-install.sh"
