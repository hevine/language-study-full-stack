/**
 * 媒体播放器演示页 —— 一套 UI 播放 H265 视频与纯音频。
 *
 * 与现有 TTS 朗读链路（useVoicePlayer / useSpeech / useVoiceSystem）完全独立：
 * 本页播放的是"真实媒体文件"，现有朗读合成的是"文字发音"，两者互不替代、互不耦合。
 *
 * 同屏并排两个实例（视频 + 音频），通过 mediaCoordinator 保证任一时刻只有
 * 一个在出声（对应 HANDOVER-PLAYER.md 的 P0-1 全局单例诉求）。
 */
import MediaPane from '../player/MediaPane';

export default function MediaPlayerDemo() {
  return (
    <div className="card card-pad" style={{ maxWidth: 1120 }}>
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>媒体播放器（H265 视频 / 纯音频）</h2>
      <p className="small muted" style={{ marginTop: 0, marginBottom: 16 }}>
        本页播放真实媒体文件，与"文字朗读 / TTS"链路完全独立。同屏两个实例，播放其中一个会立即停掉另一个，不会串台。
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <section className="card card-pad">
          <div className="section-title">🎬 H265 视频</div>
          <p className="small muted" style={{ marginTop: -4, marginBottom: 10 }}>HEVC 编码 MP4 · WASM 软解出画面</p>
          <MediaPane id="demo-video" src="/media/demo-hevc.mp4" mediaType="video" sourceKind="mp4" />
        </section>
        <section className="card card-pad">
          <div className="section-title">🎵 纯音频</div>
          <p className="small muted" style={{ marginTop: -4, marginBottom: 10 }}>原生播放 + 频谱柱 + 呼吸光晕</p>
          <MediaPane id="demo-audio" src="/media/demo-audio.wav" mediaType="audio" sourceKind="url" />
        </section>
      </div>
    </div>
  );
}
