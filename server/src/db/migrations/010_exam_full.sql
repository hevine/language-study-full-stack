-- 升级自测升级为「完整分项卷」：听力 / 词汇 / 语法 / 阅读 / 写作
--
-- 目的：
--   exam_papers 标明卷子性质（真卷 / 仿真卷 / 模型生成），并记录分项顺序与分项时长；
--   exam_items 支持写作题（自由作答 + 参考范文）与听力题（朗读稿 / 音频地址）；
--   exam_attempts 单独存写作作答文本，选择作答仍走 answers 数组。

ALTER TABLE exam_papers ADD COLUMN paper_type TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE exam_papers ADD COLUMN sections_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE exam_papers ADD COLUMN origin_url TEXT NOT NULL DEFAULT '';

ALTER TABLE exam_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'choice';
-- section 存细分题型名（如「漢字読み」），section_key 存分项键（listening / vocab / …）用于统计
ALTER TABLE exam_items ADD COLUMN section_key TEXT NOT NULL DEFAULT '';
-- 听力题的朗读稿：作答时只播放不显示，交卷后作为原文出现在解析里
ALTER TABLE exam_items ADD COLUMN audio_text TEXT NOT NULL DEFAULT '';
-- 若已备好音频文件（本地导入的真卷），这里放可访问的地址
ALTER TABLE exam_items ADD COLUMN audio_url TEXT NOT NULL DEFAULT '';
-- 写作题：参考范文与最少字数
ALTER TABLE exam_items ADD COLUMN sample_answer TEXT NOT NULL DEFAULT '';
ALTER TABLE exam_items ADD COLUMN min_words INTEGER NOT NULL DEFAULT 0;

ALTER TABLE exam_attempts ADD COLUMN writing TEXT NOT NULL DEFAULT '{}';
