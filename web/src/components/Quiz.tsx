import { useState } from 'react';
import type { Question } from '../types';

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

export default function Quiz({ questions }: { questions: Question[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({});

  if (questions.length === 0) {
    return <div className="hint">本篇为泛读/听力材料，未附理解题。</div>;
  }

  const solved = Object.keys(picked).length;
  const correct = questions.reduce(
    (sum, question, index) => (picked[index] === question.answer ? sum + 1 : sum),
    0,
  );

  return (
    <div>
      {questions.map((question, index) => {
        const choice = picked[index];
        const answered = choice !== undefined;
        return (
          <div key={index} className="quiz">
            <div className="quiz-prompt">
              {index + 1}. {question.prompt}
            </div>
            {question.options.map((option, optionIndex) => {
              const isAnswer = optionIndex === question.answer;
              const isPicked = choice === optionIndex;
              const cls = answered && isAnswer ? 'correct' : answered && isPicked ? 'wrong' : '';
              return (
                <button
                  key={optionIndex}
                  className={`option ${cls}`}
                  onClick={() => setPicked((prev) => ({ ...prev, [index]: optionIndex }))}
                >
                  <span className="option-key">{KEYS[optionIndex]}</span>
                  <span>{option}</span>
                </button>
              );
            })}
            {answered && question.explain ? <div className="explain">{question.explain}</div> : null}
          </div>
        );
      })}

      <div className="row" style={{ marginTop: 12 }}>
        <span className="chip chip-teal">
          已作答 {solved}/{questions.length}
        </span>
        {solved === questions.length ? (
          <span className={`chip ${correct === questions.length ? 'chip-ok' : 'chip-warn'}`}>
            正确 {correct} 题
          </span>
        ) : null}
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setPicked({})}>
          重做
        </button>
      </div>
    </div>
  );
}
