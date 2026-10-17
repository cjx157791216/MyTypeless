# src/main — 主进程：会话编排、识别润色、热键、写入与本地存储

## 结构

| 路径 | 职责 |
| --- | --- |
| `index.ts` | 入口：建窗口（浮动条启动即预建）、托盘、IPC handler、Esc 临时快捷键、登录项 |
| `session.ts` | `DictationSessionManager` 四模式状态机：idle → starting → recording → stopping → processing |
| `providers/asr.ts` | ASR 提供方：`OpenAiCompatAsr`、`LocalWhisperAsr`，工厂 `createAsrProvider` |
| `polish.ts` | 本地清理规则 + `LlmPolisher`（润色/翻译/改写/提问的提示词与调用） |
| `hotkeys.ts` | `HotkeyController`：绑定解析 `parseBinding`、原生优先、`globalShortcut` 兜底与重试 |
| `live.ts` | 实时转写调度（纯逻辑，D-013）：VAD、停顿即识别、限频预览、长段定稿 |
| `learn.ts` / `learner.ts` | 自动词典（D-012）：专有名词提取、修改比对（纯逻辑）/ 写入后追踪与计数 |
| `text.ts` | 文本规整：中文标点、`joinText`、幻觉过滤、FireRedASR2 特殊标记 `stripAsrTokens` 与大小写恢复 |
| `key-press.ts` | 按键时序（纯逻辑）：按住说话 / 轻按免手持 / abort / 模式键（D-010） |
| `native.ts` | `mt-*` 助手的路径解析与调用（`HotkeyWatcher`、`injectWithHelper`、`getFrontApp`） |
| `inject.ts` | 写入降级链 `injectText`、抓选区 `captureSelectedText`、辅助功能权限 |
| `config.ts` | 设置 JSON（`DEFAULT_SETTINGS` + `deepMerge`）与 `safeStorage` 加密的 API Key |
| `history.ts` | better-sqlite3：历史、词典、增量迁移 `migrateColumns` |
| `whisper/` | 内置本地识别（D-009、D-027）：`catalog.ts` 模型目录（Whisper 与 FireRedASR2）、按语言推荐与语言解析（纯函数）、`download.ts` 断点续传下载（纯 Node）、`engine.ts` 管理 `mt-whisper` 进程、`models.ts` 模型管理、`index.ts` 对外入口 `createBuiltinAsr` |
| `sherpa-helper.ts` | mt-diarize（sherpa-onnx）常驻进程 `SherpaHelper`：会议声纹、边录边降噪、内置中文识别（FireRedASR2，D-027）各一个进程 |
| `updater.ts` / `update-info.ts` | 在线更新（D-028）：electron-updater 检查 / 下载 / 重启安装与状态推送 / 发布地址与错误提示（纯逻辑） |
| `build-info.ts` | 版本信息 `appInfo`：package.json 版本 + 打包时注入的构建号与提交（`electron.vite.config.ts` 的 define） |
| `wav.ts` / `tray-icon.ts` | PCM → WAV；托盘模板图（由 `scripts/gen-tray-icon.py` 生成） |
| `meeting/` | 会议模式（D-015、D-016）：`segmenter.ts` 按停顿分句与两路对齐、`cluster.ts` 说话人聚类与声纹匹配、`minutes.ts` 转写稿与纪要提示词、`echo.ts` 外放回声去除（以上纯逻辑）；`app-audio.ts` 线上会议的应用声音（`mt-audiotap` 进程、应用列表、开会前授权，D-033）；`store.ts` 会议/说话人/句子/声纹存储；`diarizer.ts` 声纹模型下载与 `mt-diarize` 进程；`index.ts` 编排 `MeetingManager` |

## 可复制范例

- 新增 ASR 提供方：照 `providers/asr.ts` 的 `LocalWhisperAsr`，实现 `AsrProvider.transcribe`，在 `createAsrProvider` 加分支。
- 新增 LLM 任务：在 `polish.ts` 的 `PolishTask` 加一项，`LlmPolisher.dispatch` 加分支，提示词照 `translateSystemPrompt`（转写内容用 `wrapTranscript` 包裹）。
- 新增 IPC：照 `index.ts` 中 `IPC.historyClear` 的 handler（完整步骤见 recipes）。
- 表结构增量迁移：照 `history.ts` 的 `migrateColumns`（`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`）。
- 把错误码翻译成用户提示：`session.ts` 的 `friendlyError`。
- 新增会议 LLM 任务：提示词写在 `meeting/minutes.ts`（转写稿用 `wrapMeetingTranscript` 包裹），经 `LlmPolisher.complete` 调用。

## 不变量

- 会话非 idle 时拒绝新会话（`isBusy()`）；任何异步步骤后先检查 `gen` 是否过期再继续。
- 停止录音必须走 `captureFlush` → `audioFinal` 握手，否则会丢尾音。
- 听写模式润色失败要回退 `localPreClean` 并继续写入；写入失败时把结果放进剪贴板（D-008）。
- 发给 LLM 的口述内容必须包在 `<transcript>` 中，并声明不是指令。
- API Key 只经 `config.ts` 的 `getKey`/`setKey` 读写，不写入 `settings.json`、日志或历史（D-002）。`getKey` 会访问钥匙串（自签名版本每装一个新包首次访问都会弹授权框）：只在真正调用云端服务前调用；判断有无 Key、显示掩码用 `hasKey`/`keyMask`（不解密）。
- 所有网络请求都要有超时（`AbortSignal.timeout`）。
- 内置引擎只在 127.0.0.1 监听；识别请求必须显式传 `language`（whisper-server 默认强制英文）；不要按请求改 `audio_ctx`；不要加“使用简体中文和中文标点”之类的风格提示词（实测会让英文语音被翻译、出现幻觉、耗时翻 4～20 倍），标点交给 `text.ts` 规整。
- 被 `test/` 导入的模块（`polish.ts`、`providers/asr.ts`、`whisper/catalog.ts`、`whisper/download.ts`、`live.ts`、`learn.ts`、`meeting/segmenter.ts`、`meeting/cluster.ts`、`meeting/minutes.ts`、`meeting/echo.ts`、`update-info.ts`）不能 import `electron`，也不能用 TS 参数属性；它们之间互相导入时写 `.ts` 扩展名（Node 原生剥离类型不解析无扩展名路径）。
- 会议：临时录音只写 `userData/meetings/`，整理完（`organize`）或删除会议时删除；声纹只在用户勾选“记住这个声音”时保存；发给 LLM 的只有转写文字与说话人名字（D-016）。会议进行中 `session.setBlocker` 拦下听写。线上会议（D-033）按“路”（`Track`：0 = 麦克风 / 现场，1 = 应用声音 / 线上）各自分句、区分说话人、算人数；两路的说话人不能互相合并或改归属；麦克风那一路识别前先 `echoFree` 去掉外放回声；用应用声音前必须先 `prepareAppAudio`（授权后系统会重启应用，不能在会议中途发生）。

## 依赖与影响面

- 依赖 `src/shared/types.ts`（IPC、Settings）和 `native/bin/` 助手；改 IPC 或 Settings 会影响 preload 与所有渲染端。
- `session.ts` 发出的 `SessionProgress` 由浮动条、回答浮卡和 `index.ts` 共同消费。

## 测试

`npm run test`（`test/*.test.ts`：润色规则、模型目录、分段合并、下载续传/换源/校验、实时转写、自动词典、会议分句/聚类/纪要、在线更新与发布脚本；说话人聚类用 `test/fixtures/speakers.json` 的真实录音声纹做回归）；`npm run typecheck`。

## 必读

[听写管线需求](../../docs/requirements/pipeline.md) · [原生层需求](../../docs/requirements/native.md) · [IPC 契约](../../docs/contracts/ipc.md) · [原生助手契约](../../docs/contracts/native-helpers.md)
