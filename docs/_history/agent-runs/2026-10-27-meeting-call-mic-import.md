# 2026-10-27 通话中自动录入麦克风、导入录音

## 范围

GAP-028（D-045）、GAP-029（D-046）。起因：用户开线上会议（线下只有自己、线上 3 人）时选了“只用会议软件的声音（微信）”，82 分钟里自己说的话全部没录到——这个模式根本不开麦克风，保存的 WAV 里也只有对方，无法找回。用户要求：① 只用会议软件的声音时也检测麦克风，在用就把麦克风一起录进来、保存的录音也带上；② 能用本地保存的录音重新导入成会议。先问了三项：检测到后自动加入并提示（不先问）、只支持 WAV、保存的录音保持单声道混音（导入按一路处理）。

没做：mp3 / m4a 导入（Windows 要另写 Media Foundation 解码）；保存双声道以便导入还原现场 / 线上两组。

## 改动

- `mt-audiotap`（Swift 与 C++）：`--list` 加 `input`；截取时 stderr 报 `{"input":bool}`（就绪后一次、每 2 秒检查、变化时报）。macOS 用 `kAudioProcessPropertyIsRunningInput`，按与截取相同的 bundle 前缀 / pid 匹配；截取全部系统声音时只算普通应用及其辅助进程与 WebKit——实测「嘿 Siri」的 `com.apple.CoreSpeech` 一直在用麦克风。Windows 用所有输入设备上活动的音频会话，沿父进程链判断是否属于匹配的进程树（全部系统声音时为 MyTypeless 进程树以外、有可见窗口的应用）。
- 主进程：`AppAudioCapture` 转出 `mic` 事件；`MeetingManager.onCallMic` / `addMicTrack`：只用会议软件时第一次 `input:true` 加一路麦克风（`ftruncate` 补静音、`segmenter.startAt`），会议改为 `mixed`、现场 1 人，提示一次；`false` 时停录，暂停时把 `micInUse` 清掉、继续后等截取进程重新报告。
- 导入：`import-audio.ts`（WAV 头、8～32 位整数 / 32、64 位浮点、下混、加窗 sinc 重采样，16k 单声道 16 位原样拷贝）；`recording.ts` 的 `parseRecordingFileName`；`MeetingManager.importRecording` / `runImport` 复用开会的分句、降噪、句内换人、声纹、识别与定期重新归类，3 秒一块送入、积压超过 1 句就等，然后照常 `organize`；原文件记作 `saved_audio_path`（所以 `keepRecording` 不再另存一份）。IPC `meetingImport`；开始会议卡片「导入录音」。
- 顺带修复：暂停 / 结束时分句器把最后半帧补齐成整帧，句子比临时录音长一点，`echoFree` 按文件长度返回的整句与原句不一致，被当成“去掉了回声”，误报“检测到外放的回声”（麦克风 + 会议软件时，暂停或结束那一刻有人在说话就会出现）。

## 验证

- `npm run typecheck`、`npm run test`（新增 `test/meeting-import.test.ts` 6 项、`startAt`、`parseRecordingFileName`、`mt-audiotap --list` 协议）、`npm run build`、`npm run native`、`npm run docs:check` 通过。
- `mt-audiotap`：`--pid <ffmpeg>` 在 ffmpeg 录音时报 `input:true`、退出后 `false`；全部系统声音时不再因为 CoreSpeech 报 true。
- 隔离实例（开发构建，`/tmp/mt e2e/ud`，模型目录软链接、内置识别）：
  - 导入：`say` 合成的双人对话 56 秒，转成 48k 立体声 24 位、命名「2026-10-26 1500 测试导入.wav」；经主进程调试口替换文件选择框后调用 `meeting.importRecording`：约 25 秒完成，主题「测试导入」、开始时间 10-26 15:00，自动分出 2 人、10 句全部归对，识别 1 处错字；临时录音已删除，保存文件夹里没有多存一份；把 mp3 改名成 .wav 导入提示“不是 WAV 文件”，不建会议。
  - 自动录入麦克风：用脚本代替 `mt-audiotap`（输出静音，第 4～14 秒、20 秒以后报 `input:true`），浮动条的 `getUserMedia` 换成合成音源（不开真实麦克风）。第 4 秒会议改为 mixed、现场 1 人、提示并开麦，14 秒停、20 秒再开；24 秒暂停、26 秒继续后等截取进程报告才开（修复前会先开再关）；保存的 WAV（32 秒）里麦克风声音只在 4～14、20～24、28～32 秒，与时间线一致；修复后不再误报外放回声。
- C++ 部分本机无法编译，靠 CI `check-windows`。

## 遗留

- MEET-033 用真实微信 / 腾讯会议通话验证（包括挂断后停录、会议软件静音时是否仍报在用麦克风）；Windows 真机。
- MEET-034、MEET-035 真机导入用户保存的真实会议录音。
