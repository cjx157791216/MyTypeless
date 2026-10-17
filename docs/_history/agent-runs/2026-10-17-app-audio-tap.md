# 2026-10-17 应用声音截取原型（B-007）

## 范围

用户问会议模式能否识别其他视频会议的声音。需求 D-015 只用麦克风，所以只做可行性原型：新原生助手 `mt-audiotap`（Core Audio process tap），验证截到的声音交给内置识别（FireRedASR2）后错字率是否变差。刻意没做：接入会议管线、Info.plist 授权文案、界面——等 B-007 裁决。

## 改动

- `native/audiotap-helper.swift` → `mt-audiotap`：`--list` 列出音频进程；按 bundleId 前缀 / pid 或全部系统声音截取，stdout 输出 16kHz 单声道 s16le；`scripts/build-native.sh` 加入编译。
- 契约、`native/AGENTS.md`、术语表、`open-questions.md`（B-007）、`STATUS.md`。

## 实测中发现的坑（已在代码里处理，写进 native/AGENTS.md 不变量）

1. 命令行启动时权限归属 Claude / 终端，没有「系统音频录制」授权，系统静默给全零。测试用一个带 `NSAudioCaptureUsageDescription` 的临时 app 包（`/tmp/mt-tap/TapTest.app`）启动。
2. tap 报 48kHz，但 MacBook 扬声器跑 44.1kHz，数据按设备实际采样率到来：按 tap 格式转换后声音短 8%、音调变高。改为读聚集设备的 `NominalSampleRate`，变化时重建。
3. IOProc 交给 dispatch queue 时每几秒跳过一个 512 帧的 IO 周期（设备时间戳不连续），声音短约 0.3%（一小时约 11 秒，与麦克风时间线会错位）。改为音频线程直接回调、只写预分配环形缓冲，20ms 泵出、自写重采样（加窗 sinc + 256 相位表）；时间戳仍跳时补静音。修正后 60 秒实测 15998.5 样本/秒，CPU 1.8%。

## 验证

WenetSpeech test_meeting 前 30 句（232 秒，句间 1.5 秒静音）拼成 WAV 播放并截取（`--mute`，不外放），按语音段投票对齐后切句，FireRedASR2 int8 识别（`/tmp/mt-asr/asr-bench`）：

| 来源 | 错字率 | 偏移漂移 | 音量比 |
| --- | --- | --- | --- |
| 原始音频 | 5.1% | — | — |
| afplay 播放 → 按 pid 截取 | 5.8% | 0 | 1.000 |
| Chrome 播放 → `--bundle com.google.Chrome` 截取 | 5.4% | 0 | 1.000 |

差异只在“嗯/呃”“他/它”这类字。从开始截取到拿到声音约 0.2～0.3 秒；截取本身延迟一个 IO 周期 + 20ms。

`npm run native`、`npm run typecheck`、`npm run test`、`npm run build`、`npm run docs:check` 结果见汇报。

## 遗留

- B-007：是否纳入会议模式及来源选择、双音轨、回声、系统版本、提示文案，待人工裁决。
- 腾讯会议 / 飞书真实通话未测（需要另一台设备入会）。
- 接入时：Electron 的 Info.plist 要加 `NSAudioCaptureUsageDescription`（`electron-builder.yml` 的 `extendInfo`），排除 MyTypeless 自己的进程（`com.mytypeless.desktop.helper` 在 `--list` 中显示正在发声），长时间纯静音时提示授权；换输出设备（插耳机）时聚集设备的主设备不会跟着换，需要重建。
