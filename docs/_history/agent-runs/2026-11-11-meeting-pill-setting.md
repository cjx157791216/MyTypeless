# 2026-11-11 会议进行中浮动条默认隐藏（D-049）

## 范围

- 项目负责人要求：开始会议后浮动条胶囊默认隐藏，可在设置中打开显示。登记 D-049。
- 刻意不做：不动整理中胶囊（D-048 已隐藏）；不动托盘与会议页的暂停 / 结束入口。

## 改动

- 设置 `showMeetingPill`（默认关）：`shared/types.ts`（Settings + `MeetingLive.showPill`）、`config.ts` 默认值。
- 主进程把设置算进 `MeetingLive.showPill` 下发（浮动条不读设置，沿用 D-023 的架构）；`settingsSet` handler 检测开关变化后调 `MeetingManager.refreshLive()` 立即重新广播，会议中途开 / 关即时生效。
- 浮动条 `renderMeeting` 按 `showPill` 显示；设置 → 「会议录音」分组改名「会议」，新增开关卡片（settings.ts 即时保存）。

## 验证

- `npm run typecheck` 通过；渲染端无自动测试，行为待真机（设置开关、中途切换、与 D-048 叠加）。

## 遗留

- 真机验证：会议中胶囊默认不出现；设置打开后立即出现、关闭后立即消失；关闭后会议页 / 托盘仍能结束会议。
