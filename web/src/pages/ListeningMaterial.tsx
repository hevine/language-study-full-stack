/**
 * 听力库 —— 服务端按账号隔离的整段音频资料库。
 *
 * 上传走与教材库一致的 raw body 通道：元数据入 listening_materials 表，
 * 音频本体落 DATA_DIR/listening/<user>/。列表只取元数据，点选某条时才
 * 带鉴权取回文件字节、生成临时 blob URL 交给播放器——鉴权只认 Authorization
 * 头，<audio> 无法自带，因此不能直接把 /api/... 地址塞给播放器。
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { api } from '../api';
import { Field } from '@waiyubaodian/ui-kit';
import type { MediaPaneHandle } from '../player/MediaPane';
import { useApp } from '../store';
import type { ListeningMaterial } from '../types';

const MediaPane = lazy(() => import('../player/MediaPane'));

const ACCEPT = '.mp3,.m4a,.aac,.wav,.ogg,.flac,audio/*';
const AUDIO_NAME = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;

type Tone = 'teal' | 'gold' | 'danger';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 上传前从本地文件读一次时长，避免服务端再做解析 */
function readDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    const done = (value: number) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.onloadedmetadata = () =>
      done(Number.isFinite(audio.duration) ? Math.round(audio.duration) : 0);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

export default function ListeningMaterial() {
  const { language } = useApp();
  const [items, setItems] = useState<ListeningMaterial[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'loading'>('idle');
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const [active, setActive] = useState<{ item: ListeningMaterial; url: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<MediaPaneHandle>(null);
  const urlRef = useRef<string | null>(null);
  const loadSeqRef = useRef(0);

  const releaseActive = useCallback(() => {
    paneRef.current?.stop();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setActive(null);
  }, []);

  useEffect(() => {
    return () => {
      paneRef.current?.stop();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await api.listeningMaterials(language);
      setItems(response.materials);
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    }
  }, [language]);

  useEffect(() => {
    setFile(null);
    setTitle('');
    setMessage(null);
    releaseActive();
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    if (!picked.type.startsWith('audio/') && !AUDIO_NAME.test(picked.name)) {
      setMessage({ tone: 'danger', text: '请选择音频文件（MP3 / M4A / WAV / AAC 等）' });
      return;
    }
    setFile(picked);
    setTitle((prev) => prev || picked.name.replace(AUDIO_NAME, ''));
    setMessage(null);
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    pickFile(e.target.files?.[0]);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files?.[0]);
  };

  const upload = async () => {
    if (!file) {
      inputRef.current?.click();
      return;
    }
    setBusy('uploading');
    setMessage(null);
    try {
      const durationSec = await readDuration(file);
      await api.uploadListeningMaterial(file, language, { title: title.trim(), durationSec });
      setFile(null);
      setTitle('');
      setMessage({ tone: 'teal', text: `「${file.name}」已加入听力库` });
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy('idle');
    }
  };

  const playItem = async (item: ListeningMaterial) => {
    if (active?.item.id === item.id) return;
    const seq = ++loadSeqRef.current;
    setBusy('loading');
    setMessage(null);
    try {
      const blob = await api.downloadListeningMaterial(item.id);
      if (seq !== loadSeqRef.current) return; // 期间又点了别的条目，丢弃过期结果
      paneRef.current?.stop();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setActive({ item, url });
    } catch (err) {
      if (seq === loadSeqRef.current) setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      if (seq === loadSeqRef.current) setBusy('idle');
    }
  };

  const remove = async (item: ListeningMaterial) => {
    if (!window.confirm(`确定从听力库移除「${item.title}」？服务端文件会一并删除。`)) return;
    try {
      await api.deleteListeningMaterial(item.id);
      if (active?.item.id === item.id) releaseActive();
      setMessage({ tone: 'teal', text: '已从听力库移除' });
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    }
  };

  const saveRename = async (item: ListeningMaterial) => {
    const value = editTitle.trim();
    if (!value) return;
    try {
      await api.renameListeningMaterial(item.id, value);
      setEditingId(null);
      if (active?.item.id === item.id) setActive({ ...active, item: { ...item, title: value } });
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    }
  };

  return (
    <div className="card card-pad" style={{ maxWidth: 1000 }}>
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>听力库</h2>
      <p className="small muted" style={{ marginTop: 0, marginBottom: 14 }}>
        上传自己的整段听力录音，永久保留在账号下；下次进来从列表点一下就能继续精听。支持进度拖动、0.75×～2× 倍速与音量调节。
      </p>

      <div className="banner banner-teal" style={{ marginBottom: 16 }}>
        <span>
          文件保存在服务端并按账号隔离，不会随应用分发。请只上传你有权使用的音频；自购资料仅供个人学习。
        </span>
      </div>

      <section style={{ marginBottom: 20 }}>
        <div className="section-title">添加音频</div>
        <div
          className={`listen-drop${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="listen-drop-icon" aria-hidden="true">♫</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {file ? file.name : '把音频文件拖到这里，或点击选择'}
          </div>
          <p className="small muted" style={{ marginTop: 0, marginBottom: 12 }}>
            {file ? formatBytes(file.size) : '支持 MP3 / M4A / AAC / WAV / OGG / FLAC，单份最大 300 MB'}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              选择文件
              <input ref={inputRef} type="file" accept={ACCEPT} onChange={onInput} hidden />
            </label>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => void upload()} disabled={busy !== 'idle'}>
              {busy === 'uploading' ? '上传中…' : '加入听力库'}
            </button>
          </div>
          <div className="listen-title-row">
            <Field
              value={title}
              onChange={setTitle}
              placeholder="留空则用文件名"
              aria-label="资料名称"
              block
              style={{ flex: 1 }}
            />
          </div>
        </div>
      </section>

      <section>
        <div className="section-title">我的听力资料·{items.length}</div>
        {items.length === 0 ? (
          <p className="small muted" style={{ marginTop: -4 }}>还没有资料，先在上面添加一份吧。</p>
        ) : (
          <div className="listen-lib-list">
            {items.map((item) => {
              const isActive = active?.item.id === item.id;
              return (
                <div key={item.id} className={`listen-lib-item${isActive ? ' active' : ''}`}>
                  <div className="listen-lib-main">
                    {editingId === item.id ? (
                      <div className="listen-lib-edit">
                        <Field
                          value={editTitle}
                          onChange={setEditTitle}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveRename(item);
                          }}
                          autoFocus
                          aria-label="新名称"
                          size="sm"
                          block
                          style={{ flex: 1, minWidth: 140 }}
                        />
                        <button className="btn btn-primary btn-sm" type="button" onClick={() => void saveRename(item)}>保存</button>
                        <button className="btn btn-sm" type="button" onClick={() => setEditingId(null)}>取消</button>
                      </div>
                    ) : (
                      <div className="listen-lib-name">{item.title}</div>
                    )}
                    <div className="small muted">
                      {item.fileName} · {formatBytes(item.fileSize)} · {formatDuration(item.durationSec)} · {item.createdAt.slice(0, 10)}
                    </div>
                  </div>
                  <div className="listen-lib-actions">
                    <button
                      className={`btn btn-sm${isActive ? ' btn-primary' : ''}`}
                      type="button"
                      onClick={() => void playItem(item)}
                      disabled={busy === 'loading' || busy === 'uploading'}
                    >
                      {busy === 'loading' && !active ? '读取中…' : isActive ? '播放中' : '播放'}
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => {
                        setEditingId(item.id);
                        setEditTitle(item.title);
                      }}
                    >
                      重命名
                    </button>
                    <button className="btn btn-sm" type="button" onClick={() => void remove(item)}>删除</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {active ? (
        <section style={{ marginTop: 20 }}>
          <div className="section-title">正在播放 · {active.item.title}</div>
          <Suspense fallback={<p className="small muted">正在加载播放器…</p>}>
            <MediaPane
              key={active.url}
              ref={paneRef}
              id={`listening-${active.item.id}`}
              src={active.url}
              mediaType="audio"
              sourceKind="url"
              canvasStyle={{ width: '100%', height: 200, borderRadius: 10 }}
            />
          </Suspense>
          <button className="btn btn-sm" type="button" onClick={releaseActive} style={{ marginTop: 10 }}>
            关闭播放器
          </button>
        </section>
      ) : null}

      {message ? (
        <p className="small" role="alert" style={{ marginTop: 14, color: message.tone === 'danger' ? '#c0392b' : 'var(--teal)' }}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
