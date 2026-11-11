# 2026-11-11 会议模式：去掉录音与整理提示、纪要图表（D-048）

## 范围

- 项目负责人三项要求：① 去掉开始会议的「请告知参会者正在录音转写」提示；② 去掉浮动条胶囊在整理中的步骤文字（「正在转写录音（n%）」「正在生成会议纪要…」等，进度只在会议详情页显示）；③ 纪要生成后做内容分析，提炼出流程 / 架构等 Mermaid 图表，在与「纪要」同级的「图表」标签里展示（没有可画内容则不出该标签）。
- 刻意不做：图表的导出 / 编辑 / 手动重生成（随「重新生成」纪要一并重新生成）；m4a 等导入格式（见同日导入 MP3 记录）。

## 改动

- 提示收敛：`hub/meeting.ts` 删掉开始会议 toast；`floating-bar/main.ts` 的 `renderMeeting` 在整理中不再显示会议胶囊（回空闲样式），删 `meeting-processing` 样式。
- 图表（D-048）：`shared/types.ts` 新 `MeetingDiagram`、`MeetingDetail.diagrams`；`history.ts` meetings 表加 `diagrams` 列（建表 + `migrateColumns` 增量迁移）；`store.ts` 读写与 `parseDiagramsJson`；`minutes.ts` 新提示词（原创，D-001）、`parseDiagrams`（解析 `### 标题 + ```mermaid 围栏，按首行图类型过滤，最多 3 张）与 `generateDiagrams`；`meeting/index.ts` 的 `generateMinutes` 在纪要保存后追加一次 LLM 内容分析（失败只影响图表、不影响纪要）；详情页「图表」标签（无图隐藏）+ `hub/meeting.ts` 的 `renderCharts`（mermaid 动态 import 按需加载，`securityLevel: 'strict'`，渲染失败显示原文，主题跟随系统深浅色）。
- 新依赖 `mermaid`（渲染端，MIT）。

## 验证

- `test/meeting.test.ts` 新增 2 个测试（parseDiagrams 的标题 / 围栏 / 兜底 / 上限 / NONE；generateDiagrams 假模型）；`npm run typecheck`、`npm run test`（172 通过 + 12 todo）、`npm run build` 通过。
- 未跑真实 LLM 的图表质量验证（需要真实 Key 与会议数据）：登记 GAP-030 待真机（MEET-038）。

## 遗留

- MEET-038 真机验证：真实会议的图表质量、None 情形不出标签、胶囊整理中回空闲样式。
- mermaid 首次打开「图表」标签时才加载（约 1MB chunk），弱机器首开略慢；暂可接受。
