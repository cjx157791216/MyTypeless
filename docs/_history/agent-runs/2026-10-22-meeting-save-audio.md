# 2026-10-22 保存会议录音

## 任务

GAP-027（D-044）。用户：“设置增加保存会议录音项，勾选设置保存路径，会议的录音文件会保存到指定路径。”这是对 D-002“音频不落盘”与 D-016“临时录音整理完删除”的放宽，用户的请求即人工确认；格式、两路怎么存、删除会议时删不删录音三项先问了用户：WAV、混成一个文件、不删。

## 范围

- 设置 → 会议录音：「保存会议录音」（默认关）；勾选时弹出文件夹选择框，取消就不开启；之后可「更改…」「打开」。设置字段 `meetingSaveAudio`、`meetingAudioDir`。
- 整理（`organize`）最先调 `keepRecording`：临时录音按 10 秒一块混成一个 16kHz 单声道 WAV（先写 `.part`，写完改名；失败删掉），文件名「年-月-日 时分 主题.wav」，同名加序号；文件夹不可写时改存 `userData/saved-recordings` 并提示。异常中断后「继续整理」同样保存。
- `meetings.saved_audio_path`（增量迁移）；会议详情「显示录音」（`shell.showItemInFolder`）；删除会议不删这个文件，确认框写明；开始会议卡片的说明在开启时写明存到哪。
- 新 IPC：`meetingAudioDir`（pick / open）、`meetingRevealAudio`。

没做：m4a 等压缩格式（Windows 没有现成编码器）；应用内回放（需求“不包含：录音回放”不变）。

## 验证

- 单测 `test/meeting-recording.test.ts`：文件名（非法字符、默认标题、结尾的点和空格、长度）、同名加序号、混音削顶与补齐、一路与两路写出（分块边界）、写不进去时报错且不留 `.part`。
- 隔离实例（`/tmp/mt e2e/ud`，开发构建，不开麦克风：在库里造 3 场“异常中断”的会议，临时录音为合成正弦波，经 CDP 调 `meeting.finish`）：
  - 只用麦克风：存为「2026-10-24 0800 周会_Q4_计划.wav」；临时录音已删除；`revealAudio` 为 true。
  - 麦克风 + 会议软件（2 秒 + 3 秒）：48000 个采样，与两路逐点相加的期望值完全一致；默认标题存为「… 会议.wav」。
  - 文件夹设成一个普通文件（不可写）：存到 `saved-recordings`，提示文字正确；开始会议卡片说明随设置变化。
  - 设置页取消勾选：设置写回 false，文件夹那一行隐藏。
- `npm run typecheck`、`npm run test`、`npm run build`、`npm run docs:check` 通过。

## 遗留

- MEET-032 真机验证（真实会议、访达 / 资源管理器里定位、Windows）。
