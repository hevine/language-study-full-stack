-- 升级自测：按原卷大题（問題1 / Part 2 …）组织与顺序自测
--
-- 背景：N3 这类卷子里「問題1」会出现三次（文字・語彙 / 文法 / 聴解），
-- 只记 section_key（vocab/grammar/...）无法还原原卷的题型顺序，
-- 前端也就只能把所有 vocab 题排在一起，测出来跟真实考场完全不同。
-- 所以补两列：
--   question_no   原卷大题号（問題N），配合 section 文案即可定位一块大题
--   answer_source 答案来源：key=原卷答案 / explain=据解析推导 / solve=模型作答
-- 答案来源要落库，结果页才能逐题标注「这题答案是推出来的」，不误导用户。

ALTER TABLE exam_items ADD COLUMN question_no INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exam_items ADD COLUMN answer_source TEXT NOT NULL DEFAULT 'key';

CREATE INDEX IF NOT EXISTS idx_exam_items_paper_no ON exam_items(paper_id, question_no, idx);
