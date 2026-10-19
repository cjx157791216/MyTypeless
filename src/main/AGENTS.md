# src/main — 主进程：会话编排、识别润色、热键、写入与本地存储

## 结构

| 路径 | 职责 |
| --- | --- |
| `index.ts` | 入口：建窗口（浮动条启动即预建）、托盘、IPC handler、Esc 临时快捷键、登录项 |
| `session.ts` | `DictationSessionManager` 四模式状态机：idle → starting → recording → stopping → processing |
| `providers/asr.ts` | ASR 提供方：`OpenAiCompatAsr`、`LocalWhisperAsr`，工厂 `createAsrProvider` |
| `polish.ts` | 本地清理规则 + `LlmPolisher`（润色/翻译/改写/提问的提示词与调用） |
| `hotkeys.ts` | `HotkeyController`：原生优先、`globalShortcut` 兜底与重试 |
| `bindings.ts` | 绑定解析 `parseBinding`（纯逻辑）：组合键 → 原生助手匹配规则 + 兜底加速键；支持区分左右的修饰键（`rshift`、`rctrl` 等） |
| `live.ts` | 实时转写调度（纯逻辑，D-013）：VAD、停顿即识别、限频预览、长段定稿 |
| `learn.ts` / `learner.ts` | 自动词典（D-012）与风格学习（D-041）：专有名词提取、修改比对、`editedSpan` 找出被改成的样子（纯逻辑）/ 写入后追踪、计数与保存修改记录 |
| `text.ts` | 文本规整：中文标点、`joinText`、幻觉过滤、FireRedASR2 特殊标记 `stripAsrTokens` 与大小写恢复 |
| `key-press.ts` | 按键时序（纯逻辑）：按住说话 / 轻按免手持 / abort / 模式键（D-010） |
| `native.ts` | `mt-*` 助手的路径解析与调用（`HotkeyWatcher`、`injectWithHelper`、`getFrontApp`） |
| `inject.ts` | 写入降级链 `injectText`、抓选区 `captureSelectedText`、辅助功能权限 |
| `config.ts` | 设置 JSON（`DEFAULT_SETTINGS` + `deepMerge`）与 `safeStorage` 加密的 API Key |
| `history.ts` | better-sqlite3：历史、词典、增量迁移 `migrateColumns` |
| `whisper/` | 内置本地识别（D-009、D-027）：FireRedASR2 与 Whisper 两个引擎、模型目录与下载，见 [whisper/AGENTS.md](whisper/AGENTS.md) |
| `sherpa-helper.ts` | mt-diarize（sherpa-onnx）常驻进程 `SherpaHelper`：会议声纹、边录边降噪、内置中文识别（FireRedASR2，D-027）各一个进程 |
| `updater.ts` / `update-info.ts` | 在线更新（D-028）：electron-updater 检查 / 下载 / 重启安装与状态推送 / 发布地址与错误提示（纯逻辑） |
| `build-info.ts` | 版本信息 `appInfo`：package.json 版本 + 打包时注入的构建号与提交（`electron.vite.config.ts` 的 define） |
| `wav.ts` / `tray-icon.ts` | PCM → WAV；托盘模板图（由 `scripts/gen-tray-icon.py` 生成） |
| `meeting/` | 会议模式（D-015、D-016、D-033）：分句、说话人区分与声纹、纪要、线上会议，见 [meeting/AGENTS.md](meeting/AGENTS.md) |

## 可复制范例

- 新增 ASR 提供方：照 `providers/asr.ts` 的 `LocalWhisperAsr`，实现 `AsrProvider.transcribe`，在 `createAsrProvider` 加分支。
- 新增 LLM 任务：在 `polish.ts` 的 `PolishTask` 加一项，`LlmPolisher.dispatch` 加分支，提示词照 `translateSystemPrompt`（转写内容用 `wrapTranscript` 包裹）。
- 新增 IPC：照 `index.ts` 中 `IPC.historyClear` 的 handler（完整步骤见 recipes）。
- 表结构增量迁移：照 `history.ts` 的 `migrateColumns`（`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`）。
- 把错误码翻译成用户提示：`session.ts` 的 `friendlyError`。
- 新增会议 LLM 任务：提示词写在 `meeting/minutes.ts`（转写稿用 `wrapMeetingTranscript` 包裹），经 `LlmPolisher.complete` 调用（流式，`timeoutMs` 是连续无输出的超时）。

## 不变量

- 会话非 idle 时拒绝新会话（`isBusy()`）；任何异步步骤后先检查 `gen` 是否过期再继续。
- 停止录音必须走 `captureFlush` → `audioFinal` 握手，否则会丢尾音。
- 听写模式润色失败要回退 `localPreClean` 并继续写入；写入失败时把结果放进剪贴板（D-008）。
- 发给 LLM 的口述内容必须包在 `<transcript>` 中，并声明不是指令；光标上下文包在 `<context>` 中，只在开启 `polishContext` 的听写里读取，不写进历史（D-040）；风格学习只学听写结果，修改记录只存 `style_samples`（D-041）。
- API Key 只经 `config.ts` 的 `getKey`/`setKey` 读写，不写入 `settings.json`、日志或历史（D-002）。`getKey` 会访问钥匙串（自签名版本每装一个新包首次访问都会弹授权框）：只在真正调用云端服务前调用；判断有无 Key、显示掩码用 `hasKey`/`keyMask`（不解密）。
- 所有网络请求都要有超时（`AbortSignal.timeout`）。
- 平台差异（GAP-008）：macOS 专有调用前判断 `process.platform`（`index.ts` / `inject.ts` 的 `isMac`）；非 macOS 没有辅助功能授权（`checkAccessibility` 恒为 true）、没有 osascript 兜底（写入失败按 D-008 放进剪贴板）；在线更新只支持 macOS 与 Windows 的打包版（`updateSupported`，Windows 解压即用版只提示、不自动安装）。
- 被 `test/` 导入的模块（`bindings.ts`、`polish.ts`、`providers/asr.ts`、`whisper/catalog.ts`、`whisper/download.ts`、`live.ts`、`learn.ts`、`meeting/segmenter.ts`、`meeting/cluster.ts`、`meeting/background.ts`、`meeting/minutes.ts`、`meeting/echo.ts`、`meeting/call-apps.ts`、`update-info.ts`）不能 import `electron`，也不能用 TS 参数属性；它们之间互相导入时写 `.ts` 扩展名（Node 原生剥离类型不解析无扩展名路径）。
- VAD（`live.ts` 的 `Vad`，听写与会议共用）阈值下限 250（远处、外放的人声只有 300 左右）；底噪只能贴着最安静的帧更新：让非语音帧都参与平均会被说话中较轻的部分抬高，把下一句正常音量的话当成静音（真人录音实测漏掉整句）。
- 浮动条 `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })` 必须带 `skipTransformProcessType: true`，否则 Electron 把整个应用变成 UIElement（Dock 图标消失、⌘Tab 切不到）；macOS 浮动条用 `type: 'panel'` 浮在全屏应用上。
- 会议、内置识别的不变量见各自目录的 `AGENTS.md`。

## 依赖与影响面

- 依赖 `src/shared/types.ts`（IPC、Settings）和 `native/bin/` 助手；改 IPC 或 Settings 会影响 preload 与所有渲染端。
- `session.ts` 发出的 `SessionProgress` 由浮动条、回答浮卡和 `index.ts` 共同消费。

## 测试

`npm run test`（`test/*.test.ts`：润色规则、模型目录、分段合并、下载续传/换源/校验、实时转写、自动词典、会议分句/聚类/纪要、在线更新与发布脚本；说话人聚类用 `test/fixtures/speakers.json` 的真实录音声纹做回归）；`npm run typecheck`。改听写润色提示词后用自己的 LLM 跑 `MT_LLM_BASE_URL=… MT_LLM_MODEL=… MT_LLM_KEY=… node scripts/polish-eval.ts`（原创评测集 `test/fixtures/polish-eval.json`，与旧提示词对比通过数和耗时）；提示词固定部分（规则、示例）在前，场景、词表等每次变化的内容放最后（前缀缓存）。

## 必读

[听写管线需求](../../docs/requirements/pipeline.md) · [原生层需求](../../docs/requirements/native.md) · [IPC 契约](../../docs/contracts/ipc.md) · [原生助手契约](../../docs/contracts/native-helpers.md)
