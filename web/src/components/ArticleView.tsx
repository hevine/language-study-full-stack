import { useMemo, useState, type ReactNode } from 'react';
import type { Article, VocabEntry } from '../types';
import { useVoicePlayer } from '../hooks/useVoicePlayer';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(
  text: string,
  vocab: VocabEntry[],
  isEnglish: boolean,
  active: string | null,
  onPick: (entry: VocabEntry) => void,
): ReactNode[] {
  const terms = vocab
    .map((entry) => entry.term)
    .filter((term) => term && term.length > 1)
    .sort((a, b) => b.length - a.length);

  if (terms.length === 0) return [text];

  const pattern = terms.map(escapeRegExp).join('|');
  const regex = new RegExp(
    isEnglish ? `(?<![A-Za-z])(${pattern})(?![A-Za-z])` : `(${pattern})`,
    isEnglish ? 'gi' : 'g',
  );

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const matchedText = match[0];
    const entry = vocab.find((item) =>
      isEnglish ? item.term.toLowerCase() === matchedText.toLowerCase() : item.term === matchedText,
    );
    parts.push(
      <span
        key={`w-${key++}`}
        className={`word${active && entry && active === entry.term ? ' active' : ''}`}
        onClick={() => entry && onPick(entry)}
      >
        {matchedText}
      </span>,
    );
    lastIndex = match.index + matchedText.length;
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export default function ArticleView({
  article,
  language,
  compact = false,
}: {
  article: Article;
  language: 'en' | 'ja' | 'ko';
  compact?: boolean;
}) {
  const [showTranslation, setShowTranslation] = useState(false);
  const [selected, setSelected] = useState<VocabEntry | null>(null);
  const articleVoice = useVoicePlayer('article');

  const paragraphs = useMemo(
    () => article.body.split(/\n{2,}/).filter((part) => part.trim().length > 0),
    [article.body],
  );

  return (
    <div>
      <div className="article-head">
        <div>
          <div className="article-title">{article.title}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className={`chip ${article.source === 'llm' ? 'chip-teal' : 'chip-gold'}`}>
              {article.source === 'llm' ? `大模型生成 · ${article.model ?? 'LLM'}` : '内置题库'}
            </span>
            <span className="chip">约 {article.estMinutes} 分钟</span>
            <span className="chip">{article.vocab.length} 个重点词</span>
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button
            className="btn btn-sm btn-primary"
            disabled={!articleVoice.supported}
            onClick={() =>
              articleVoice.play(paragraphs.map((paragraph, index) => ({ text: paragraph, id: `para-${index}` })))
            }
            title="按「精读材料朗读」场景绑定的音色连读全文"
          >
            ▶ 朗读全文
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={!articleVoice.supported || !articleVoice.playing}
            onClick={articleVoice.stop}
          >
            停止
          </button>
          <button className="btn btn-sm" onClick={() => setShowTranslation((value) => !value)}>
            {showTranslation ? '隐藏译文' : '显示译文'}
          </button>
        </div>
      </div>

      <div className="row voice-inline" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="hint">
          {articleVoice.currentVoice
            ? `音色「${articleVoice.currentVoice.name}」· 到「设置 → 音色库」可更换`
            : '到「设置 → 音色库」挑选音色'}
        </span>
        {articleVoice.error ? <span className="hint voice-error">{articleVoice.error}</span> : null}
      </div>

      <div className={`article-body${language === 'ja' ? ' jp' : ''}`}>
        {paragraphs.map((paragraph, index) => (
          <p key={index}>{highlight(paragraph, article.vocab, language === 'en', selected?.term ?? null, setSelected)}</p>
        ))}
      </div>

      {selected ? (
        <div className="tooltip-card">
          <strong>{selected.term}</strong>
          {selected.reading ? <span style={{ opacity: 0.8 }}>{selected.reading}</span> : null}
          {selected.pos ? <span className="pos">{selected.pos}</span> : null}
          <span style={{ flex: 1 }}>{selected.meaning}</span>
          <button
            className="btn btn-sm btn-ghost"
            style={{ color: 'rgba(242,246,255,0.7)' }}
            onClick={() => setSelected(null)}
          >
            收起
          </button>
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 10 }}>
          文中带虚线的词可以点开看释义与词性。
        </div>
      )}

      {showTranslation ? (
        <div className="translation">
          {article.translation.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      ) : null}

      {!compact && article.vocab.length > 0 ? (
        <>
          <hr className="divider" />
          <div className="section-title">
            <h2 style={{ fontSize: 16 }}>重点词表</h2>
            <span className="hint">会按记忆曲线进入词汇本</span>
          </div>
          <div className="grid grid-2">
            {article.vocab.map((entry) => (
              <div key={entry.term} className="word-item">
                <div>
                  <div className="word-term">
                    {entry.term}
                    {entry.reading ? (
                      <span className="hint" style={{ marginLeft: 8 }}>
                        {entry.reading}
                      </span>
                    ) : null}
                  </div>
                  <div className="small muted">{entry.meaning}</div>
                  {entry.example ? (
                    <div className="hint" style={{ marginTop: 3 }}>
                      {entry.example}
                    </div>
                  ) : null}
                </div>
                {entry.pos ? <span className="chip">{entry.pos}</span> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
