-- 真题导入：记录「这份卷子是从哪个文件、用什么方式解析进来的」
--
--   import_file  原始文件名（空字符串表示内置/脚本导入，不是从设置页上传的）
--   import_meta  解析元信息 JSON：{ ocr, pages, chars, model, warnings, importedAt }
--
-- 设置页的「真题导入」列表按 import_file <> '' 过滤，删除时走同一张表。

ALTER TABLE exam_papers ADD COLUMN import_file TEXT NOT NULL DEFAULT '';
ALTER TABLE exam_papers ADD COLUMN import_meta TEXT NOT NULL DEFAULT '{}';
