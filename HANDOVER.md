# 交接文档：外语考证宝典 · 升级自测「删除导入卷」功能

> 写于 2026-11-10。给接手的新任务用：现状、改了什么、怎么验的、哪些坑不能踩、还剩什么没做。
> 项目根目录：`/Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian`（**不是**当前会话的 workspace 目录，两者不同，别搞混）

---

## 1. 一句话现状

「升级自测」的试卷卡上已经加好**删除按钮**，只对自己导入的卷子出现；后端 `DELETE /api/exams/:id` 连带清掉题目与作答记录，内置题库拒删。代码、构建、接口、视觉四处都已验证通过，**没有进行中的半成品**。剩下的都是小尾巴（README 接口表未补、双入口未合并、窄屏未验），见第 6 节。

服务在 `:4399` 跑的是生产模式，当前进程 PID `47232`（另一个 `72965` 是 npm/tee 包装），HTTP 200。

---

## 2. 怎么跑起来

```bash
cd /Users/zhua/WorkBuddy/2026-11-04-12-41-53/waiyu-baodian

npm start                 # 生产模式：tsx 直跑 TS + 托管 dist/web，端口 4399
npm run dev               # 开发模式：api 4399 + vite 5173
npm run build             # 前端产物 → dist/web（改了 web/ 必须重新 build，start 不会自己编译）
npm run typecheck         # tsc --noEmit
```

**重启才生效**：改了 `server/src/**` 必须重启（`kill $(lsof -ti :4399)` 后 `npm start`），`tsx watch` 只在 dev 模式有。

**启动要等约 50 秒**：`bootstrap()` 里 `ensureExamBank()` 会逐份刷新内置题库（82 套 / 843 题），这段时间端口还没起来，别以为挂了。日志最后一行出现 `server started` 才算好。

---

## 3. 这次做完的事：删除导入卷

### 3.1 为什么要做

之前库里躺着一份早前解析失败的残缺卷 `imp-ja-2026-fc8e6e4f`（只有 5 道文字・語彙题）。项目**没有任何删除入口**，只能手工开库 `DELETE`。那份卷已按「先备份再删」清掉（备份见 4.3），随后补上了这个能力。

### 3.2 改动清单（5 个文件）

| 文件 | 位置 | 改了什么 |
| --- | --- | --- |
| `server/src/repositories/exams.ts` | `deleteImportedPaper()` 第 580 行 | 改成事务：守卫 `import_file <> ''` → 删 `exam_attempts` → 删 `exam_items` → 删 `exam_papers`。不再依赖外键级联，命令行直连库也不会留孤儿行 |
| `server/src/routes/exams.ts` | 第 80–96 行 | 新增 `DELETE /api/exams/:id`：不存在 → 404；`importFile` 为空 → 400「内置题库不能删除」；成功 → `{ok:true,id}` |
| `web/src/api.ts` | 第 399 行 | 新增 `api.examDelete(id)`，`retries=0`（删除不做自动重试，避免二次删除） |
| `web/src/pages/ExamHub.tsx` | 51/54/75/197/277 行 | 抽出 `load()` 用 `useCallback` 复用；`removePaper()` 先 `window.confirm`（文案带作答次数）再删；卡片底部按钮组，`paper.importFile` 才渲染删除；删除中显示「删除中…」；结果用 `.paper-notice` 条提示，不整页 Banner 打断选卷 |
| `web/src/styles.css` | 第 5995–6040 行 | `.paper-foot-actions` / `.paper-del` / `.paper-notice` / `.paper-notice-close`：删除按钮平时灰色，hover 转红 |

内置卷的 id 形如 `ja-2024-full`，导入卷形如 `imp-ja-2026-dfbbb792`；**判定依据是 `import_file` 是否为空**，不是 id 前缀。

### 3.3 接口实测（三种情况都对）

| 场景 | 结果 |
| --- | --- |
| 删临时导入卷 `test-del-paper`（2 题 + 1 条作答） | `200 {"ok":true,"id":"test-del-paper"}`；三张表残留 `0|0|0` |
| 删内置卷 `ja-2026-full` | `400 VALIDATION_FAILED`「内置题库不能删除，只能删自己导入的卷子」；该卷 10 题完好 |
| 删不存在的 `nope-xxx` | `404 NOT_FOUND`「这份卷子不存在」 |

测试用的临时卷与作答已全部清理，库内 `exam_attempts` 只剩 3 条（`ko-2009-full` active、`ko-2026-full` done、`imp-ja-2026-dfbbb792` active 未交卷）。

### 3.4 视觉确认

无头 Chrome 截的 `/tmp/examhub.png`（1440×1600，`#/exams`）已人工核对：

- 「2026年7月 N3 全题型真题」那张卡底部是「未测　删除　开始自测」，删除为浅灰次要按钮；
- 其余 27 张内置卡只有「开始自测」，确认 `importFile` 判断生效；
- 卡片没有错位、文字没有溢出或换行。

复现命令（Chrome 需要 `--no-sandbox`，并且这个命令在沙箱里跑不了，要开 `dangerouslyDisableSandbox`）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
  --disable-gpu --hide-scrollbars --window-size=1440,1600 --virtual-time-budget=6000 \
  --screenshot=/tmp/examhub.png "http://127.0.0.1:4399/#/exams"
```

---

## 4. 数据与备份

### 4.1 现状

| 项 | 值 |
| --- | --- |
| 试卷 | 82 套：英文 27 + 韩文 27 + 日文 28（日文里 27 套内置 + 1 套导入 N3） |
| 题量 | 843 道 |
| 导入卷 | `imp-ja-2026-dfbbb792`「2026年7月 N3 全题型真题」——**101 题 / 17 个大题 / 141 分钟**，聴解 28 题全部有朗读稿 |
| 已删 | `imp-ja-2026-fc8e6e4f`（5 题残缺卷，2026-11-09 20:49 删） |

### 4.2 数据库

SQLite 单文件 `.data/app.db`（WAL）。考试相关三张表：

- `exam_papers`：`import_file`（空=内置）、`paper_type`（real/mock/ai）、`sections_json`（科目+大题计划）、`import_meta`（coverage / lastTopUp / lastAudioFill / lastSpeechBuild）
- `exam_items`：`question_no`（原卷問題N）、`answer_source`（key/explain/solve/none）、`audio_text`（听力朗读稿）、`passage`（阅读材料）
- `exam_attempts`：`answers` 存选项下标数组，`writing` 存写作文本；`status` = active / done

外键 `ON DELETE CASCADE` 是开的（`db/index.ts` 里 `pragma foreign_keys=ON`），但新代码仍显式删子表。

### 4.3 备份文件（出问题可直接回灌）

| 文件 | 内容 |
| --- | --- |
| `.data/delete-backup-imp-ja-2026-fc8e6e4f-2026-11-09T12-49-06.json` | 已删残缺卷：paper 1 + items 5 + attempts 2 |
| `.data/topup-backup-imp-ja-2026-dfbbb792-2026-11-09T05-45-22-817Z.json` | N3 补抽前 99 题 |
| `.data/speech-backup-imp-ja-2026-dfbbb792-2026-11-09T05-56-07-294Z.json` | 重建問題4 前 101 题 |

---

## 5. 环境坑（每条都真踩过）

1. **工作区源码会回滚**：新会话有时把 `server/src`、`web/src` 退回旧版本，`.data/app.db` 保留。改之前先 `grep` 一下确认改动还在（本次已确认 5 个文件都在，mtime 11-09 22:50–22:52）。真丢了，从 `~/.workbuddy/projects/<session>/*.jsonl` 的 `function_call` 回放。
2. **`grep` 的 `\|` 在这台机器的 BSD grep 上不生效**：`grep "a\|b"` 会返回空并 exit 1，看着像「文件里没有」。一律用 `grep -E "a|b"`。本次排查就因此误判过一次「改动丢了」。
3. **`curl` 会走代理**：本机 HTTP 请求一律加 `--noproxy '*'`，否则 4399 打不通。
4. **`vite build` 在沙箱里会被拦（unlink 权限）**：必须 `dangerouslyDisableSandbox` 才能 build。
5. **导入任务轮询路径**是 `/api/exam-imports/jobs/{id}`，不是 `/api/exam-imports/{id}`。
6. **模型线路不稳**：11 月 9 日那轮连续 90s 超时 / 429 / 空 JSON，整卷重导会覆盖已导好的题。所以补题一律用第 7 节的定点脚本，且脚本规则是「新题数更多才替换」。
7. **`dist/web/assets` 里堆了 120 个 hash 包**（历次 build 残留）。`index.html` 只引用最新那份，不影响运行，但别被 `grep` 到的旧包误导。
8. `package.json` 里 `ps` 被沙箱禁（`operation not permitted`），看进程用 `lsof -ti :4399`。

---

## 6. 没做完 / 待决策

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| 中 | README「主要接口」表缺考试类接口 | 现在表里只有 catalog/plans/paths/days/practice/vocab/stats/settings，`/api/exams*`、`/api/exam-imports*` 一条都没有；新增的 `DELETE /api/exams/:id` 也没写。README 第 138 行「升级自测」章节写得很细，但没提删除 |
| 中 | 两个删除入口并存 | `DELETE /api/exams/:id`（新，试卷资源语义）与 `DELETE /api/exam-imports/:id`（旧，`server/src/routes/examImports.ts`）都调同一个 `deleteImportedPaper`。前端目前只有设置页的 `ExamImportCard` 用旧的、ExamHub 用新的。建议收敛成一个 |
| 低 | 窄屏未验 | 卡片最小 258px，`paper-foot` 里塞了「最好 12/101 · 11%」+ 两个按钮。桌面 3 列截图正常，手机宽度（≤ 420px）没看过，可能需要 `flex-wrap` |
| 低 | 删除交互只做了 `window.confirm` | 与设置页导入卡一致；如果要去掉原生弹窗，得先给 `ui.tsx` 加 Modal（目前没有） |
| 低 | 内置卷为什么不能删 | 产品决策已定（种子会在启动时重新写回，删了会误导），文案已写明；若以后允许「隐藏内置卷」，应改 `exam_papers` 加 `hidden` 字段而不是物理删 |
| 低 | `.data/delete-backup-*fc8e6e4f*.json` 可删 | 确认不需要回滚后就能清掉 |

---

## 7. 可复用脚本（都在 `scripts/`，都先备份再动，`--dry` 只报告）

```bash
npm run topup:exam  -- --paper <id> --file <pdf> [--expect 7=2] [--context 7=ocr.txt] [--passage 7=ocr.txt] [--only 1,2,4] [--dry]
npm run fill:audio  -- --paper <id> --file <pdf> [--from-backup .data/topup-backup-*.json] [--only 79,80|--redo]
npm run build:speech -- --paper <id> --file <pdf> --block 4 --answers 1,2,0,1
```

- `topup:exam`：只补「原卷小题数 > 库内题数」的大题，带题数提示重抽，新结果更多才替换
- `fill:audio`：听力朗读稿补齐（同卷旧题选项一致则连答案/解析/题干一起接；否则按问句去答案区【听力原文】定位）
- `build:speech`：発話表現（题面全图）按答案区重建，答案人工给下标
- `scripts/ocrPdf.swift`：本机 Vision OCR，`swift scripts/ocrPdf.swift <pdf> <out.txt> <from> <to>`

---

## 8. 建议的下一步

1. 补 README 接口表（含 `DELETE /api/exams/:id` 与被删卷的行为说明），顺手把两个删除入口合并到 `/exams/:id`；
2. 420px 宽度跑一次截图，确认两按钮不挤；
3. 若要「打不开就删」更顺，可在设置页导入卡的失败结果里直接给「删掉这份」，复用 `api.examDelete`；
4. 历史会话细节见 `/Users/zhua/WorkBuddy/2026-11-06-10-54-08/.workbuddy/memory/2026-11-09.md`（补抽全过程）与本文件。
