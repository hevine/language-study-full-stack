/**
 * Standalone MediaPort：TTS 与讲解视频均为 stub。
 *
 * 独立端首版不做视频生成流水线；TTS 返回空引用。
 * 未来可接本地 TTS（如 macOS say 命令）。
 */
import type { MediaPort } from '../ports';

export function createStubMediaPort(): MediaPort {
  return {
    async tts() {
      return { audioRef: '', ms: 0, cached: false };
    },
    explainVideo: {
      async start() {
        return { reused: false, ms: 0 };
      },
      async poll() {
        return {
          state: 'error' as const,
          progress: 0,
          detail: 'standalone 模式不支持讲解视频',
          error: 'not_available',
        };
      },
    },
  };
}
