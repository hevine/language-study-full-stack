"""本地 Edge Neural TTS 桥接：stdin 收 JSON，stdout 输出 mp3 二进制。

由 server/src/services/edgeTts.ts 以 spawn 方式调用，不监听端口、不落临时文件。
只在 stdout 写音频，日志和异常一律走 stderr，方便上层判断成败。
"""
import asyncio
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
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            sys.stdout.buffer.write(chunk["data"])
    sys.stdout.buffer.flush()


def main() -> None:
    raw = sys.stdin.buffer.read()
    request = json.loads(raw.decode("utf-8"))
    asyncio.run(synthesize(request))


if __name__ == "__main__":
    # --probe 只做环境自检：打印版本后立刻退出，不联网、不读 stdin
    if "--probe" in sys.argv[1:]:
        print(getattr(edge_tts, "__version__", "unknown"))
        sys.exit(0)
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - 错误信息要完整回传给上层翻译
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
