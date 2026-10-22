# src/main/meeting — 会议模式：录制、分句、说话人区分与声纹、纪要

## 结构

| 路径 | 职责 |
| --- | --- |
| `index.ts` | `MeetingManager` 编排：两路（`Track`：0 = 麦克风 / 现场，1 = 应用声音 / 线上）录音、分句、声纹、识别、整体归类、整理与纪要 |
| `segmenter.ts` | 按停顿分句 `UtteranceSegmenter`、两路对齐、句内换人切分、慢电脑降级判定 `denoiseLagging` / `overloaded`（纯逻辑） |
| `cluster.ts` | 说话人聚类（平均链接；按人数或自动人数 `regroup`）与声纹匹配 `printScore`（纯逻辑） |
| `background.ts` | 声纹认人用的背景声音 `SPEAKER_BACKGROUND`（随声纹模型固定的常量，D-042） |
| `minutes.ts` | 转写稿、纪要提示词、长会议纪要编排 `generateMinutesBody`（均分、并发、逐层合并、断点续做）（纯逻辑） |
| `echo.ts` / `enhance.ts` | 外放回声去除 / 识别前音量归一 `normalizeLoudness`（纯逻辑） |
| `call-apps.ts` | 线上会议可选应用分类：通话软件 / 浏览器 / 其他（D-039，纯逻辑） |
| `app-audio.ts` | 线上会议的应用声音：`mt-audiotap` 进程、应用列表、开会前授权 `prepareAppAudio`（D-033） |
| `diarizer.ts` | 声纹 / 分段 / 降噪模型下载与 `mt-diarize` 进程 |
| `recording.ts` | 保存会议录音（D-044）：临时录音按块混成一个 WAV `saveRecording`、文件名 `recordingFileName`（纯逻辑，只用 fs） |
| `store.ts` | 会议、说话人、句子、声纹的 sqlite 存储 |

纯逻辑模块被 `test/` 导入：不能 import `electron`、不能用 TS 参数属性，互相导入写 `.ts` 扩展名。

## 不变量

- 会议与听写共用浮动条的麦克风管线和内置引擎；会议进行中 `session.setBlocker` 拦下听写。
- 临时录音只写 `userData/meetings/`，整理完（`organize`）或删除会议时删除；用户开启保存会议录音时 `organize` 最先调 `keepRecording` 另存到用户的文件夹（`saved_audio_path`，删除会议时不删，D-044）；声纹只在用户勾选“记住这个声音”时保存；发给 LLM 的只有转写文字与说话人名字（D-016）。转写稿用 `wrapMeetingTranscript` 包裹。
- 两路的说话人不能互相合并或改归属；各路各自分句、区分说话人、算人数；麦克风那一路识别前先 `echoFree` 去掉外放回声。
- 用应用声音前必须先 `prepareAppAudio`：macOS 用户点「允许」录制系统音频后，系统会**退出并重新打开所有 MyTypeless 实例**（包括隔离测试实例），不能发生在会议中途；没授权时系统只给全零、不报错。
- 分句：停顿切句后，每句再用分段模型（带前 8 秒参考录音）找句内换人——真人对话常不停顿就接话；分段模型在几秒的短片段里分不清人，必须带参考录音。会议已区分出各人后改用 `splitByWindows`（1.5 秒窗口与各人比较，D-025）；按窗口切的段不要再 `mergeAdjacentParts`（同一声源下不同人也可能 ≥ 0.55，会把切开的又合回）；切点用 `snapCuts` 挪到 ±0.25 秒内最安静处（窗口间隔 0.5 秒，原切点常切在字中间）。
- “是不是同一个人”一律用平均链接（与某人每段的平均相似度；在线归入 0.57、达到参会人数后只归入最像的人），不要用“与归一化中心的余弦”：同一声源（一台麦克风、外放、同一房间）给所有人加上相同成分，中心比较会把不同的人并成一个。会议中每 20 秒整体重新归类一次。
- 整体归类（D-042）：细分组之间按“分不分得开”合并（组间相似度与较散一组的组内相似度之比），已知人数合并到 k 组、自动人数合并到两两分得开再复检小组。用户起过名的人是软约束：不被并掉，但组里混进的别人的句子照常挪走——不要把命名过的人的句子全部锁死（会中起名后，之后在线归进来的别人的句子也被锁住、越积越多：真实三人会议里一个人的 36 句全部并进了起过名的人）；只有软约束下有人分不到组时才退回全部锁死。手动改归属的句子才不动。不要回到固定相似度门槛判断人数（D-020 的 0.4：短句会议里不同人可到 0.4、同一人可低到 0.1，两头出错），也不要回到“取发言最多的 k 组”（说得少的人被并掉）。自动人数的难点在两头：只说两三句的人常被并掉，长会议里同一人的杂音小组会被多分出来——`MINOR_SHARE` / `MINOR_RATIO` 就是为后者加的。
- 声纹认人（D-022、D-042）用整组声音（至少 3 句）、两边减去背景声音 `SPEAKER_BACKGROUND` 后的余弦（`printScore`），不要用原始相似度比单句：同一房间的不同人原始相似度也很高（没到场的人约 7% 被认成库里的同事）。声纹自动认出的名字（`auto_named`）每次整体归类后复核，用户改过的名字不复核。
- 远场（D-024）：GTCRN 降噪后的声音只用于分句，**不要拿去识别**（弱的人声会被一起削掉，很远时错字翻倍）；识别用原始录音 + `normalizeLoudness`。上一句做提示词、简单谱减降噪实测没有稳定收益。
- 慢电脑（Windows 低压 4 核实测）：降噪（低优先级）落后超过 8 秒即停用、改用原始录音分句（`denoiseLagging`）；排队超过 3 句不做句内换人切分（`overloaded`）。
- `mt-audiotap`（macOS）：tap 报 48kHz，但数据按输出设备的实际采样率到来，要按聚集设备的 `NominalSampleRate` 重采样（详见 `native/AGENTS.md`）。

## 改动前必做的回归

- 改聚类：通过 `test/fixtures/speakers.json`（sr-data 真人完整段与 1～2.5 秒短句，原声 / 外放）的回归。真实会议多是 1～2 秒短句，同一人两句可低到 0.1～0.3，不要只用长句数据调门槛。
- 换声纹模型（D-026）：用 `scripts/gen-speaker-fixture.cjs` 重新生成 fixture，重算 `SPEAKER_BACKGROUND`（D-042 的数据集与做法），按真实会议录音重新标定 `SAME_SPEAKER` / `KNOWN_CUT` / `SEPARATE_*` / `MINOR_*` / `PRINT_MATCH`（保持不同人误并率不变），并改 `EMBED_MODEL`——不同模型的声纹维度可能相同但不可比较。
- 改自动人数或分组参数：除 fixture 外，用远场真实会议（AliMeeting）拆出的 1～4 人组合、“一方只说 2～10 句”、单人长会议对比人数判对数与每人归对率（`scripts/speaker-eval.ts`），两头（多分、漏分）都要看。
- 改分句或识别前处理：用远场模拟（音量小 18/26 dB + 混响 + 房间底噪）对比，不要只用近讲录音。
- 改外放回声门槛 `ECHO_CORR`：用 `scripts/echo-sim.ts`（真人录音 + 模拟外放）重新标定，同时看“只有回声被去掉多少”和“戴耳机 / 同时说话时现场的话保留多少”。
- 改识别、声纹、降噪管线：用低配机器或限制 CPU 实测，不要只在 M 系列 Mac 上测。

## 测试

`npm run test`（`test/meeting.test.ts`、`echo.test.ts`、`call-apps.test.ts`）；端到端用打包版隔离实例，`--user-data-dir` 必须带空格（见根 `AGENTS.md`）。

## 必读

[会议需求](../../../docs/requirements/meeting.md) · [会议决策](../../../docs/decisions/domains/meeting.md) · [原生助手契约](../../../docs/contracts/native-helpers.md)
