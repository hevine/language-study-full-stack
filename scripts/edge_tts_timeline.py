"""带句级时间轴的 Edge Neural TTS 桥接：stdin 收 JSON，stdout 输出一行 JSON。

与 edge_tts_synth.py 并行存在、互不替换：
  - synth.py   只写 mp3 二进制，供 edgeTts.ts 的朗读链路使用（不能改坏）；
  - timeline.py 输出 {audioBase64, boundaries, durationMs}，供解题答疑视频分镜配音使用。

edge_tts.Communicate.stream() 同时吐 audio 分片与 SentenceBoundary 事件，
offset/duration 单位是 100ns（除以 10000 得毫秒），与音频严格同源、不会漂移。
"""
import asyncio
import base64
import json
import sys

try:
    import edge_tts
except ImportError as exc:
    print(f"ModuleNotFoundError: edge_tts is not installed ({exc})", file=sys.stderr)
    sys.exit(2)


async def synthesize(request: dict) -> None:
    text = request["input"]
    voice = request["voice"]
    rate = request.get("rate", "+0%")
    boundary = request.get("boundary", "SentenceBoundary")
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary=boundary)
    audio = bytearray()
    boundaries = []
    async for chunk in communicate.stream():
        kind = chunk.get("type")
        if kind == "audio":
            audio.extend(chunk["data"])
        elif kind in ("SentenceBoundary", "WordBoundary"):
            boundaries.append({
                "text": chunk.get("text", ""),
                "offsetMs": round(chunk.get("offset", 0) / 10000),
                "durationMs": round(chunk.get("duration", 0) / 10000),
            })
    print(json.dumps({
        "audioBase64": base64.b64encode(bytes(audio)).decode("ascii"),
        "boundaries": boundaries,
        "durationMs": sum(b["durationMs"] for b in boundaries) if boundaries else 0,
    }, ensure_ascii=False))


def main() -> None:
    raw = sys.stdin.buffer.read()
    request = json.loads(raw.decode("utf-8"))
    asyncio.run(synthesize(request))


if __name__ == "__main__":
    if "--probe" in sys.argv[1:]:
        print(getattr(edge_tts, "__version__", "unknown"))
        sys.exit(0)
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
