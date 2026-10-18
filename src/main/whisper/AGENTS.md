# src/main/whisper — 内置本地识别（D-009、D-027）

## 结构

| 路径 | 职责 |
| --- | --- |
| `index.ts` | 对外入口 `createBuiltinAsr`：按语言选引擎，FireRedASR2 进程 `fireredEngine`（`FIRERED_THREADS`：macOS 4、Windows 1），识别后规整文字 |
| `catalog.ts` | 模型目录（Whisper 与 FireRedASR2）、按语言推荐、语言与繁简解析（纯函数） |
| `download.ts` | 断点续传、换源、校验（纯 Node） |
| `engine.ts` | `WhisperEngine`：管理 `mt-whisper`（whisper-server）进程、清理残留 `killOrphanEngines` |
| `models.ts` | `ModelManager`：模型下载、删除与状态 |

`catalog.ts`、`download.ts` 被 `test/whisper.test.ts` 导入：不能 import `electron`。

## 两个引擎

- 中文 / 英文默认 **FireRedASR2**（`mt-diarize --firered`，sherpa-onnx，CPU，每句 1～2.5 秒）；其他语言用 **Whisper**（`mt-whisper`，whisper.cpp，macOS 用 GPU、Windows 只用 CPU）。
- FireRedASR2 输出**不带标点、英文全大写、不支持热词**，静音时输出特殊标记 `<sil>`（标点模型会变成 `< sil >。`）：标点靠 `--punct` 标点模型，`<sil>` 由 `text.ts` 的 `stripAsrTokens` 去掉，大小写由 `fixAsrCase` 按词典恢复。
- 听写录音经 `asr` 命令的 base64 传入 FireRedASR2，不能写临时文件（D-002）。
- Windows 上 FireRedASR2 用 1 线程：实测多开线程不快，只多占 CPU，开会时抢走声纹、降噪与会议软件的时间。

## 不变量

- Whisper 每次识别约 0.9 秒且与音频长度无关（固定 30 秒窗口，几乎全在 GPU）：优化看“识别次数”而不是“音频长度”（实时转写见 `src/main/live.ts`）。
- `mt-whisper` 只在 127.0.0.1 监听；识别请求必须显式传 `language`（whisper-server 默认强制英文）。`language=auto` 会多跑一次编码器（耗时翻倍），默认按系统语言传 `zh` 等。
- 不要按请求改 `audio_ctx`（缩小会让 turbo 模型输出乱码）。
- 不要加“使用简体中文和中文标点”之类的风格提示词（实测会让英文语音被翻译、出现幻觉、耗时翻 4～20 倍），标点交给 `text.ts` 规整。
- `mt-whisper` 不随父进程退出：应用启动时 `killOrphanEngines` 清理父进程已是 launchd（Windows 见 `killOrphanEnginesWin`）的残留，每个残留约占 770MB 内存。
- 模型在 `userData/models/`（macOS `~/Library/Application Support/MyTypeless/models/`）。

## 换模型

换识别模型要用人工标注的公开数据（WenetSpeech test_meeting、AISHELL-1、ASCEND）在本机实测错字率，不要拿某个模型的输出当参考答案；由维护者决定。升级 whisper.cpp 需更新 A-007 并回归 `mt-whisper` 的 `/health` 与 `/inference`。

## 测试

`npm run test`（`test/whisper.test.ts`：模型目录、下载续传 / 换源 / 校验）；`npm run whisper`（macOS，需要 cmake）/ `npm run whisper:win` 编译引擎。

## 必读

[听写管线需求](../../../docs/requirements/pipeline.md) · [原生助手契约](../../../docs/contracts/native-helpers.md)
