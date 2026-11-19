import { useMemo, useState } from 'react';
import { api } from '../api';
import { LoopIcon, MedalCheck, StarIcon, TargetIcon } from './ui';
import type { TaskWord } from '../types';
import { useVoicePlayer } from '../hooks/useVoicePlayer';

const TIER_LABEL: Record<string, string> = {
  basic: '过渡词',
  core: '托福核心',
  advanced: '冲 100 拉分',
};

const LEVEL_LABEL: Record<string, string> = {
  n3: 'N3 核心',
  n2: 'N2 高频',
  n1: 'N1 拉分',
};

function shuffle<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed || 1;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export default function WordDeck({
  words,
  onFinish,
}: {
  words: TaskWord[];
  onFinish: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState(false);
  const [known, setKnown] = useState<string[]>([]);
  const [again, setAgain] = useState<string[]>([]);
  const [stage, setStage] = useState<'study' | 'quiz' | 'done'>('study');
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const wordVoice = useVoicePlayer('word');

  const quiz = useMemo(() => {
    if (words.length < 4) return [];
    return shuffle(words, words.length * 7).slice(0, 4).map((word, qi) => {
      const distractors = shuffle(
        words.filter((item) => item.term !== word.term),
        qi + 11,
      ).slice(0, 3);
      const options = shuffle([word, ...distractors], qi + 3).map((item) => item.cn);
      return { word, options, answer: options.indexOf(word.cn) };
    });
  }, [words]);

  const current = words[index];
  const progress = words.length === 0 ? 0 : (index / words.length) * 100;

  const grade = async (word: TaskWord, remembered: boolean) => {
    if (word.id) {
      api.review(word.id, remembered ? 3 : 0).catch(() => undefined);
    }
    if (remembered) setKnown((prev) => [...prev, word.term]);
    else setAgain((prev) => [...prev, word.term]);
  };

  const next = () => {
    if (index + 1 >= words.length) {
      setStage(quiz.length > 0 ? 'quiz' : 'done');
      return;
    }
    setIndex(index + 1);
    setRevealed(false);
    setGraded(false);
  };

  if (words.length === 0) {
    return (
      <div className="card card-pad center">
        <div className="hint">今天的词表还没准备好，先去做精读吧。</div>
      </div>
    );
  }

  if (stage === 'done') {
    const answered = Object.keys(answers).length;
    const correct = quiz.filter((item, qi) => answers[qi] === item.answer).length;
    return (
      <div className="card card-pad center word-finish">
        <div className="finish-hero">
          <span className="finish-burst" aria-hidden />
          <span className="finish-burst late" aria-hidden />
          <span className="finish-spark fs1"><StarIcon size={15} /></span>
          <span className="finish-spark fs2"><StarIcon size={10} /></span>
          <span className="finish-spark fs3"><StarIcon size={12} /></span>
          <span className="finish-dot d1" aria-hidden />
          <span className="finish-dot d2" aria-hidden />
          <span className="finish-dot d3" aria-hidden />
          <div className="finish-medal">
            <MedalCheck />
          </div>
        </div>
        <h2 className="finish-title">今天的词过完了</h2>
        <div className="finish-stats">
          <span className="finish-stat ok">
            <StarIcon size={13} />
            记住 {known.length} 个
          </span>
          <span className="finish-stat warn">
            <LoopIcon size={13} />
            需重看 {again.length} 个
          </span>
          {quiz.length > 0 ? (
            <span className="finish-stat teal">
              <TargetIcon size={13} />
              快测 {correct}/{answered || quiz.length} 正确
            </span>
          ) : null}
        </div>
        <div className="finish-summary">
          {known.slice(0, 6).map((term) => (
            <span key={term} className="chip chip-ok">
              {term}
            </span>
          ))}
          {again.slice(0, 6).map((term) => (
            <span key={term} className="chip chip-warn">
              {term}
            </span>
          ))}
        </div>
        <div className="hint finish-note">
          这些词已按记忆曲线进入词汇本，明天会自动出现在到期复习里。
        </div>
        <button className="btn btn-primary btn-finish" onClick={onFinish}>
          完成并返回首页
        </button>
      </div>
    );
  }

  if (stage === 'quiz') {
    const answered = Object.keys(answers).length;
    const correct = quiz.filter((item, qi) => answers[qi] === item.answer).length;
    return (
      <div className="stack">
        <div className="card card-pad">
          <div className="section-title" style={{ marginBottom: 6 }}>
            <h2 style={{ fontSize: 17 }}>快测：4 个词，看中文选英文</h2>
            <span className="hint">
              {answered}/{quiz.length} 已答
            </span>
          </div>
          <div className="hint">答错不扣分，只是提醒你明天复习时要重点看这几个。</div>
          <div className="quiz-list">
            {quiz.map((item, qi) => {
              const picked = answers[qi];
              return (
                <div key={item.word.term} className="quiz">
                  <div className="quiz-prompt">{item.word.term}</div>
                  {item.options.map((option, oi) => (
                    <button
                      key={option}
                      className={`option${picked === oi ? (oi === item.answer ? ' correct' : ' wrong') : ''}`}
                      onClick={() => setAnswers((prev) => ({ ...prev, [qi]: oi }))}
                      disabled={picked !== undefined}
                    >
                      <span className="option-key">{String.fromCharCode(65 + oi)}</span>
                      {option}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <span className="hint">答完 {quiz.length} 题就结束</span>
            <span className="spacer" />
            <button
              className="btn btn-primary"
              disabled={answered < quiz.length}
              onClick={() => setStage('done')}
            >
              看结果（{correct}/{quiz.length}）
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="deck-head">
        <div className="deck-progress">
          <span style={{ width: `${progress}%` }} />
        </div>
        <span className="hint">
          {index + 1} / {words.length}
        </span>
      </div>

      <div className="card word-card">
        <div className="word-card-top">
          <span className="chip chip-accent">{current.theme}</span>
          {current.level ? (
            <span className="chip">{current.levelName ?? LEVEL_LABEL[current.level] ?? current.level}</span>
          ) : current.tier ? (
            <span className="chip">{TIER_LABEL[current.tier] ?? current.tier}</span>
          ) : null}
          {current.stretch ? <span className="chip chip-gold">进阶</span> : null}
          <span className="spacer" />
          <span className="hint">
            已记 {known.length} · 待回看 {again.length}
          </span>
        </div>

        <div className="word-term-big">{current.term}</div>
        <div className="word-sub">
          {current.ipa ? <span className="word-ipa">{current.ipa}</span> : null}
          {current.reading ? <span className="word-ipa">{current.reading}</span> : null}
          {current.pos ? <span className="hint">{current.pos}</span> : null}
        </div>

        <div className="row voice-inline" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-sm btn-ghost"
            disabled={!wordVoice.supported}
            onClick={() => wordVoice.speak(current.term, `word-${index}`)}
          >
            ▶ 朗读单词
          </button>
          {current.example ? (
            <button
              className="btn btn-sm btn-ghost"
              disabled={!wordVoice.supported}
              onClick={() => wordVoice.speak(current.example as string, `example-${index}`)}
            >
              ▶ 朗读例句
            </button>
          ) : null}
          <span className="hint">{wordVoice.currentVoice?.name ?? '到设置里挑选音色'}</span>
          {wordVoice.error ? <span className="hint voice-error">{wordVoice.error}</span> : null}
        </div>

        {revealed ? (
          <div className="word-reveal">
            <div className="word-cn">{current.cn}</div>
            {current.syn.length > 0 ? (
              <div className="row" style={{ marginTop: 8 }}>
                <span className="hint">同义替换</span>
                {current.syn.map((item) => (
                  <span key={item} className="chip chip-teal">
                    {item}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mnemonic">
              <span className="mnemonic-label">记忆法</span>
              {current.mnemonic}
            </div>
            {current.example ? (
              <div className="example-box">
                <div>{current.example}</div>
                {current.exampleCn ? <div className="hint">{current.exampleCn}</div> : null}
              </div>
            ) : null}
          </div>
        ) : (
          <button className="reveal-btn" onClick={() => setRevealed(true)}>
            想一下它的意思，然后点这里看释义
          </button>
        )}

        <div className="word-actions">
          <button
            className="btn btn-sm"
            onClick={() => {
              if (!graded) {
                void grade(current, false);
                setGraded(true);
              }
              setRevealed(true);
            }}
          >
            没想起来，看答案
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              if (!graded) {
                void grade(current, true);
                setGraded(true);
              }
              next();
            }}
          >
            {graded ? '下一个' : '记住了，下一个'}
          </button>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={next}>
            跳过
          </button>
        </div>
      </div>

      <div className="hint">
        先看词自己回忆，再点开释义：这一步叫"主动回忆"，比反复看单词表记得牢得多。
      </div>
    </div>
  );
}
