#!/usr/bin/env python3
"""
本地语音识别服务（SenseVoiceSmall + FunASR）
============================================================
给【外语考证宝典】的 ASR 号池提供一条「断网/额度用尽也能用」的兜底线路。

对外只暴露一个 OpenAI 兼容接口，因此号池把它当成普通线路即可：

    POST /v1/audio/transcriptions   (multipart)
        file=@recording.webm  model=SenseVoiceSmall
        language=ja|ko|en     prompt=...   temperature=0
    ->  {"text": "..."}

设计取舍：
- 只监听 127.0.0.1，不对外网开放；
- 音频先经 ffmpeg 统一转 16k 单声道 wav，避免 webm/opus/m4a 解码兼容问题；
- 模型默认按需加载、空闲 10 分钟释放（ASR_PRELOAD=1 可改为常驻），
  这台 8GB 机器上常驻 1.5GB 会把系统挤到换页；
- /health 除了探活，还回传「是否驻留 / 上次识别耗时」，供设置页展示实时状态；
- FunASR 的 generate 不是线程安全的，用一把锁串行化；
- 请求里的 prompt / temperature 只为兼容号池请求体，本地不吃这两个参数。
"""
from __future__ import annotations

import gc
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("asr-local")

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("ASR_LOCAL_PORT", "8108"))
DEVICE = os.environ.get("ASR_DEVICE", "cpu")
MODEL_DIR = Path(os.environ.get("ASR_MODEL_DIR") or (HERE / "models" / "SenseVoiceSmall"))
VAD_DIR = Path(os.environ.get("ASR_VAD_DIR") or (HERE / "models" / "fsmn-vad"))
MAX_SECONDS = int(os.environ.get("ASR_MAX_SECONDS", "600"))

# SenseVoice 的语言参数：只接受这几个值，未知一律交给 auto 自动判别
LANG_MAP = {"zh": "zh", "en": "en", "ja": "ja", "ko": "ko", "yue": "yue", "auto": "auto"}

TAG_RE = re.compile(r"<\|[^|]*\|>")

app = FastAPI(title="SenseVoiceSmall 本地兜底 ASR", docs_url=None, redoc_url=None)

_model = None
_model_error: Optional[str] = None
_lock = threading.Lock()
_loader = threading.Lock()
_last_used = time.time()
_loading = False
STARTED_AT = time.time()

# 给设置页看的运行统计：最近一次识别耗时、累计次数都从这里读
_stats: dict = {
    "total": 0,
    "failed": 0,
    "lastAtMs": None,
    "lastMs": None,
    "lastLanguage": None,
    "lastChars": None,
    "lastBytes": None,
    "lastColdStart": None,
    "loadMs": None,
}

# 模型常驻要占 1.5GB 左右，8GB 内存的机器上会把系统挤到换页（推理慢十倍）。
# 默认「用到才加载、空闲 10 分钟释放」，只有真正需要兜底时才占内存。
IDLE_UNLOAD_SEC = int(os.environ.get("ASR_IDLE_UNLOAD_SEC", "600"))
PRELOAD = os.environ.get("ASR_PRELOAD", "0") == "1"


def _ffmpeg() -> str:
    found = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    if not Path(found).exists():
        raise RuntimeError("找不到 ffmpeg，无法解码音频（brew install ffmpeg）")
    return found


def _to_wav(src: Path, dst: Path) -> None:
    """任何格式 -> 16kHz 单声道 wav。转码失败直接报错，不做静默降级。"""
    cmd = [
        _ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src), "-ac", "1", "-ar", "16000", "-vn", "-f", "wav", str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0 or not dst.exists() or dst.stat().st_size <= 1024:
        raise ValueError(f"音频解码失败：{(proc.stderr or '').strip()[:200]}")


def _clean(text: str) -> str:
    """去掉 SenseVoice 的 <|ja|><|NEUTRAL|><|Speech|><|woitn|> 这类标签。

    官方 rich_transcription_postprocess 会把情绪标签换成 emoji，用于转写文本
    反而是噪声（学生要的是自己说的句子），所以这里只剥离标签。
    """
    text = TAG_RE.sub("", text or "")
    text = text.replace("<unk>", "")
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def load_model() -> None:
    global _model, _model_error, _loading
    if _model is not None or _model_error:
        return
    _loading = True
    started = time.time()
    try:
        if not MODEL_DIR.exists():
            raise RuntimeError(
                f"模型目录不存在：{MODEL_DIR}\n请先执行 npm run asr:setup 下载模型"
            )
        from funasr import AutoModel  # 延迟导入：装依赖失败时服务仍能返回可读错误

        # 8GB 内存的机器上 torch 默认按核数开线程，推理时内存和 CPU 都会顶满，
        # 连带把同机的 node 服务挤掉。限制线程数换取稳定。
        import torch

        threads = int(os.environ.get("ASR_THREADS", "2"))
        torch.set_num_threads(max(1, threads))
        LOG.info("torch 线程数：%d", torch.get_num_threads())

        kwargs = {
            "model": str(MODEL_DIR),
            "trust_remote_code": True,
            "device": DEVICE,
            "disable_update": True,
        }
        if VAD_DIR.exists():
            # VAD 负责切掉长录音里的静音段，短录音也能防止静音被“脑补”出文字
            kwargs["vad_model"] = str(VAD_DIR)
            kwargs["vad_kwargs"] = {"max_single_segment_time": 30000}
        _model = AutoModel(**kwargs)
        _stats["loadMs"] = int((time.time() - started) * 1000)
        LOG.info("模型加载完成：%s（%s，耗时 %.1fs）", MODEL_DIR.name, DEVICE, time.time() - started)
    except Exception as err:  # noqa: BLE001 - 任何加载失败都要变成可读的 503
        _model_error = f"{type(err).__name__}: {err}"
        LOG.error("模型加载失败：%s", _model_error)
    finally:
        _loading = False


def ensure_loaded() -> None:
    """按需加载：并发请求共享一次加载过程。"""
    if _model is not None:
        return
    with _loader:
        if _model is None:
            load_model()


def _idle_reaper() -> None:
    """空闲一段时间后把模型放掉，把内存还给系统。"""
    while True:
        time.sleep(30)
        if _model is None or IDLE_UNLOAD_SEC <= 0:
            continue
        idle = time.time() - _last_used
        if idle < IDLE_UNLOAD_SEC:
            continue
        with _lock:  # 等当前推理跑完再卸载
            if _model is not None and time.time() - _last_used >= IDLE_UNLOAD_SEC:
                globals()["_model"] = None
                gc.collect()
                LOG.info("空闲 %d 秒，已释放模型内存（下次识别会重新加载）", int(idle))


def _transcribe(wav: Path, language: str) -> str:
    assert _model is not None
    result = _model.generate(
        input=str(wav),
        cache={},
        language=language,
        use_itn=True,
        batch_size_s=60,
        merge_vad=True,
        merge_length_s=15,
    )
    if not result:
        return ""
    first = result[0]
    text = first.get("text", "") if isinstance(first, dict) else str(first)
    return _clean(text)


@app.get("/health")
def health() -> JSONResponse:
    """服务活着就算 ok（模型可能已按需释放），loaded 表示此刻是否驻留内存。

    idleSec / last / total 给设置页展示实时状态用，缺省值为 None 表示还没有记录。
    """
    now = time.time()
    return JSONResponse(
        status_code=200,
        content={
            "status": "ok",
            "loaded": _model is not None,
            "loading": _loading,
            "model": MODEL_DIR.name,
            "device": DEVICE,
            "idleUnloadSec": IDLE_UNLOAD_SEC,
            "idleSec": int(now - _last_used) if _model is not None else None,
            "uptimeSec": int(now - STARTED_AT),
            "loadMs": _stats["loadMs"],
            "total": _stats["total"],
            "failed": _stats["failed"],
            "last": (
                {
                    "atMs": _stats["lastAtMs"],
                    "elapsedMs": _stats["lastMs"],
                    "language": _stats["lastLanguage"],
                    "chars": _stats["lastChars"],
                    "bytes": _stats["lastBytes"],
                    "coldStart": _stats["lastColdStart"],
                }
                if _stats["lastAtMs"] is not None
                else None
            ),
            "error": _model_error,
        },
    )


@app.get("/v1/models")
def models() -> JSONResponse:
    return JSONResponse(
        {"object": "list", "data": [{"id": MODEL_DIR.name, "object": "model", "owned_by": "local"}]}
    )


@app.post("/v1/audio/transcriptions")
@app.post("/audio/transcriptions")
def transcriptions(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),  # noqa: A002 - 与 OpenAI 字段同名
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),  # 号池会带上，本地忽略
    response_format: Optional[str] = Form("json"),
    temperature: Optional[str] = Form(None),
) -> Response:
    global _last_used
    _last_used = time.time()
    # 这一次请求会不会顺带触发模型加载（设置页据此区分「首次识别慢」和「真的变慢了」）
    cold_start = _model is None
    ensure_loaded()
    if _model is None:
        _stats["failed"] += 1
        raise HTTPException(503, detail=f"本地模型不可用：{_model_error or '尚未加载'}")

    lang = LANG_MAP.get((language or "auto").strip().lower(), "auto")
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"

    with tempfile.TemporaryDirectory(prefix="asr-local-") as tmp:
        src = Path(tmp) / f"in{suffix}"
        with src.open("wb") as fh:
            shutil.copyfileobj(file.file, fh, length=1024 * 1024)
        src_bytes = src.stat().st_size
        if src_bytes == 0:
            raise HTTPException(400, detail="音频为空")

        # 输出故意不叫 in.wav：输入本身是 wav 时同名会让 ffmpeg 直接报错退出
        wav = Path(tmp) / "decoded.wav"
        try:
            _to_wav(src, wav)
        except Exception as err:  # noqa: BLE001
            raise HTTPException(400, detail=str(err)) from err

        started = time.time()
        try:
            with _lock:
                text = _transcribe(wav, lang)
        except Exception as err:  # noqa: BLE001
            _stats["failed"] += 1
            LOG.exception("识别失败")
            raise HTTPException(500, detail=f"本地识别失败：{err}") from err
        elapsed = time.time() - started
        _last_used = time.time()
        _stats["total"] += 1
        _stats["lastAtMs"] = int(_last_used * 1000)
        _stats["lastMs"] = int(elapsed * 1000)
        _stats["lastLanguage"] = lang
        _stats["lastChars"] = len(text)
        _stats["lastBytes"] = src_bytes
        _stats["lastColdStart"] = cold_start

    LOG.info("transcribed lang=%s bytes=%d chars=%d %.2fs", lang, src_bytes, len(text), elapsed)
    if (response_format or "").lower() == "text":
        return PlainTextResponse(text)
    return JSONResponse({"text": text})


def _warmup() -> None:
    """空跑一次：首帧推理要建图、分配内存，冷启动能到 10 秒级，
    预先跑掉之后用户的第一次录音就是 1-2 秒。"""
    if _model is None:
        return
    import wave

    started = time.time()
    with tempfile.TemporaryDirectory(prefix="asr-warm-") as tmp:
        path = Path(tmp) / "silence.wav"
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00" * 8000)  # 0.5 秒静音
        try:
            with _lock:
                _transcribe(path, "auto")
            LOG.info("预热完成（%.1fs）", time.time() - started)
        except Exception as err:  # noqa: BLE001 - 预热失败不影响服务
            LOG.warning("预热失败（不影响使用）：%s", err)


def main() -> None:
    # 默认不预加载：进程常驻只占几十 MB，等真正要兜底时再吃那 1.5GB
    if PRELOAD:
        ensure_loaded()
        _warmup()
        if _model is None:
            LOG.error("预加载失败，服务以降级模式启动：/v1/audio/transcriptions 会返回 503")
    else:
        LOG.info("模型按需加载（首次识别会慢一些，可用 ASR_PRELOAD=1 改为启动即加载）")
    threading.Thread(target=_idle_reaper, daemon=True).start()

    import uvicorn

    LOG.info("本地 ASR 监听 http://127.0.0.1:%d/v1/audio/transcriptions", PORT)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
