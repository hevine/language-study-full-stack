#!/usr/bin/env python3
"""下载本地 ASR 需要的模型权重到 local-asr/models/，已存在则跳过。"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"

TARGETS = [
    # 主模型：多语言（中/英/日/韩/粤）语音识别，约 900MB
    ("iic/SenseVoiceSmall", MODELS / "SenseVoiceSmall", "model.pt"),
    # 语音端点检测：切掉长录音里的静音段，约 4MB
    ("iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", MODELS / "fsmn-vad", "model.pt"),
]


def main() -> int:
    from modelscope import snapshot_download

    for repo, target, marker in TARGETS:
        if (target / marker).exists() and (target / "config.yaml").exists():
            print(f"==> 已存在，跳过：{target.name}")
            continue
        print(f"==> 下载 {repo} -> {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        snapshot_download(repo, local_dir=str(target))
        if not (target / marker).exists():
            print(f"!! 下载后仍缺少 {marker}，请检查网络或模型仓库", file=sys.stderr)
            return 1
    total = sum(f.stat().st_size for f in MODELS.rglob("*") if f.is_file())
    print(f"==> 模型就绪，合计 {total / 1024 / 1024:.0f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
