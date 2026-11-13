# 2026-11-13 会议记录可管理可分类（文件夹 + 回收站）

## 范围

GAP-032、D-050。参考用户提供的 PLAUD 布局图，会议页改版：左侧文件夹面板（全部 / 未分类 / 自建文件夹带计数 / 新建 / 回收站）+ 右侧列表（标题搜索、按创建时间切最新/最早优先）。形态经 AskUserQuestion 确认：自建文件夹（互斥归属）、回收站（彻底删除才清录音与声纹）。契约先行（D-050、MEET-039~042、ipc.md 七通道），随后 store → IPC → UI 三层。

## 改动

- `store.ts` 去 electron 化：`SqlConn` 注入（`initMeetingStore`，`index.ts` whenReady 开头接线；`history.ts` open() 调 `ensureFolderSchema`）——store 变纯逻辑模块，可被 test/ 导入；顺带 `../live.ts` / `./cluster.ts` 补扩展名。
- `ensureFolderSchema`：meeting_folders 表 + meetings 补 `folder_id`（NULL=未分类，旧行自动回填）/`deleted_at`（软删除时间戳），幂等。
- 新函数：listFolders / createFolder（空名不建）/ renameFolder / deleteFolder（单事务会议回落未分类）/ moveMeetingToFolder（回收站中拒绝）/ trashMeeting（recording/paused/processing 拒绝，folder_id 保留——恢复回原文件夹）/ restoreMeeting。彻底删除复用 `deleteMeeting` 语义零改动。
- IPC 七通道（folder-*、meeting-move-to-folder、meeting-trash、meeting-restore），preload 新 `folders` 组；彻底删除复用 `meeting-delete`。`MeetingManager.trash/restore`（guard 同 delete）。
- UI：meeting-shell（folder-panel 172px + meeting-main）；计数从同一份 MeetingSummary[] 派生；行 hover「⋯」菜单移动/进回收站；回收站行不可点、提供恢复/彻底删除；详情页删除按钮改移入回收站；`loadDetail` 对 deletedAt 非空回列表（防 stale hash）。
- 排序 tiebreaker 用 `rowid`（randomUUID 同毫秒不稳定，测试抓到后改）。

## 验证

- `test/meeting-folders.test.ts`：node:sqlite `DatabaseSync(':memory:')` + 20 行 SqlConn 适配器；fixture 手写老形状四表 → ensureFolderSchema 补列（老库升级为被测行为）；8 组场景全绿，全套 181 过 0 挂。
- `typecheck` / `build` / `docs:check` 通过。
- 打包版隔离实例端到端（合成数据）：建/重命名/删除文件夹、移动会议、软删/恢复/彻底删、搜索排序（见下方补充或 PR 描述）。

## 遗留

- MEET-039~042 真机验证（GAP-032 保持 DONE_PENDING_REVIEW）。
- 回收站自动清理未做（自动删用户数据属未定义规则，需要时走 B 项）。
