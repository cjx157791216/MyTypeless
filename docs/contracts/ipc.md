# IPC 契约（主进程 ↔ 渲染端）

通道名只在 `src/shared/types.ts` 的 `IPC` 常量中定义（前缀 `mt:`）；渲染端只能通过 preload 暴露的 `window.mytypeless`（类型 `MyTypelessBridge`，`src/shared/api.ts`）调用。新增通道须四处同步：`IPC` 常量 → `src/preload/index.ts` → `src/shared/api.ts` → `src/main/index.ts` 的 handler。

`window.mytypeless.platform` 是常量（`process.platform`，不走 IPC）：界面据此按平台显示快捷键名与系统设置路径（`src/shared/platform.ts`），主窗口把它写到 `body[data-platform]`，`.mac-only` 元素只在 macOS 上显示。

## 渲染端 → 主进程（`invoke`，有返回值）

| 通道 | Bridge 方法 | 参数 → 返回 |
| --- | --- | --- |
| `sessionStart` | `session.start(mode?)` | `FeatureMode`（默认 `dictation`）；程序化开始一律按免手持处理；会话进行中时忽略 |
| `sessionStop` | `session.stop()` | 结束录音并进入处理 |
| `sessionCancel` | `session.cancel()` | 写入前任意阶段取消 |
| `sessionGetState` | `session.getState()` | → 最近一次 `SessionProgress` |
| `sessionAudioChunk` | `session.pushAudio(buf)` | `ArrayBuffer`：16kHz 单声道 Int16 PCM，约 100ms 一片（会话开始时可能先补预录分片）；仅录音/冲刷阶段接收 |
| `sessionAudioFinal` | `session.audioFinal()` | 回应 `captureFlush`：尾音已全部送达 |
| `settingsGet` | `settings.get()` | → `Settings`（含计算字段 `hasApiKey`、`apiKeyMasked`（`••••末4位`），Key 明文永不下发；**不解密**，打开主窗口不访问钥匙串） |
| `settingsSet` | `settings.set(patch)` | `Partial<Settings>` 深合并 → 新 `Settings`；同时重注册快捷键、更新登录项 |
| `settingsSetKey` | `settings.setKey(which, key)` | `'asr' \| 'llm'`、Key（空串表示删除）→ `{ ok, masked }` |
| `asrHealth` | `settings.asrHealth(baseUrl?)` | → `{ ok, detail? }`（请求 `<baseUrl>/health`） |
| `llmTest` | `settings.llmTest(cfg)` | `{ baseUrl, model, apiKey? }`（设置页当前填写的值；`apiKey` 为空时用已保存的 Key，会访问钥匙串）→ `{ ok, ms?, error? }`：`ms` 为到第一段输出的耗时，`error` 为给用户看的原因（`describeLlmError`，含服务端原话） |
| `modelList` | `models.list()` | → `ModelInfo[]`（含是否已安装） |
| `modelDownload` / `modelCancel` | `models.download(id)` / `models.cancel(id)` | 开始 / 取消下载；进度经 `modelProgress` 推送；取消保留已下载部分 |
| `modelRemove` | `models.remove(id)` | 删除模型（正在使用时先停引擎）→ 最新 `ModelInfo[]` |
| `historyList` | `history.list(limit?, offset?)` | → `HistoryRecord[]`，按时间倒序 |
| `historyDelete` / `historyClear` | `history.remove(id)` / `history.clear()` | 删除单条 / 全部 |
| `historyCopy` | `history.copy(id)` | 把结果（无则原话）写入剪贴板 → `boolean` |
| `dictList` / `dictAdd` / `dictRemove` | `dict.list/add/remove` | → 最新词条列表 `{ word, source }[]` |
| `appInfo` | `system.appInfo()` | → `AppInfo { version, build, commit }`（开发运行时 build/commit 为 dev） |
| `updateGetState` / `updateCheck` | `update.getState()` / `update.check()` | → `UpdateState`；检查中、下载中或已下载时不重复检查（D-028） |
| `updateDownload` / `updateCancel` | `update.download()` / `update.cancel()` | 有新版本（或下载失败）时开始下载 / 取消下载 → `UpdateState`；进度经 `updateState` 推送 |
| `updateInstall` | `update.install()` | → `{ ok, error? }`：已下载时重启并安装；录音、会议或整理中拒绝 |
| `updateOpenDownload` | `update.openDownload()` | 用浏览器打开新版本 DMG 地址（自动安装失败时手动安装） |
| `historyStats` | `history.stats()` | → `HistoryStats { count, totalDurationMs, totalChars, weekCount, todayChars }`（首页概览；提问不计字数） |
| `meetingStart` | `meeting.start(opts?)` | `MeetingStartOptions { title?, expectedSpeakers?, source?, appBundleId?, appName?, expectedRemote? }` → `{ ok, error?, meetingId? }`；`source` 为 `mic`（默认，只用麦克风）/ `mixed`（麦克风 + 应用声音）/ `app`（只用应用声音），`appBundleId` 空 = 全部系统声音，`expectedSpeakers` / `expectedRemote` 为现场 / 线上人数；未给的项用上次的设置；听写进行中、已有会议或上一场还在整理时拒绝（D-015）；用应用声音但系统低于 14.2、或「录制系统音频」授权框还没回应时拒绝（D-033） |
| `meetingPause` / `meetingResume` / `meetingStop` | `meeting.pause/resume/stop(opts?)` | 暂停（关闭麦克风）/ 继续 / 结束并整理（重新归类说话人 →（`opts.minutes !== false` 时）生成纪要 → 删除临时录音）（D-019） |
| `meetingRequestStop` | `meeting.requestStop()` | 浮动条用：主进程弹系统对话框「生成纪要 / 只保存记录 / 继续开会」 |
| `meetingGetLive` | `meeting.getLive()` | → 当前 `MeetingLive` |
| `meetingAudioChunk` | `meeting.pushAudio(buf)` | 浮动条 → 主进程：会议麦克风录音分片（16kHz 单声道 Int16，约 100ms）；暂停时、只用应用声音时忽略 |
| `meetingList` / `meetingGet` | `meeting.list()` / `meeting.get(id)` | → `MeetingSummary[]`（按开始时间倒序）/ `MeetingDetail \| null` |
| `meetingDelete` | `meeting.remove(id)` | 删除会议的文字、说话人与残留的临时录音 → `boolean`（进行中或整理中返回 false） |
| `meetingSetTitle` | `meeting.setTitle(id, title)` | 改会议主题 |
| `meetingRenameSpeaker` | `meeting.renameSpeaker(id, speakerId, name, remember)` | 改名；`remember` 时保存/更新声纹（D-016）→ `{ remembered }`（没有声音特征时为 false） |
| `meetingAssignSegment` | `meeting.assignSegment(id, segmentId, speakerId \| 'new')` | 把一句话改归某人或新说话人（标记为手动，整理时不再改动） |
| `meetingMergeSpeakers` | `meeting.mergeSpeakers(id, from, into)` | 合并两个说话人 |
| `meetingSaveMinutes` / `meetingRegenerate` | `meeting.saveMinutes(id, md)` / `meeting.regenerate(id)` | 保存编辑后的纪要 / 重新生成 → `{ ok, error? }` |
| `meetingSetExpected` | `meeting.setExpected(id, n, track?)` | 改某一路（`track` 0 = 现场 / 麦克风，默认；1 = 线上 / 应用声音）的人数（1～10）并立即按新人数重新区分这一路的说话人，同时记为下次开会的默认人数 → `{ ok, error? }`（较早没有逐句声纹的会议返回 false）（D-020、D-021、D-033） |
| `meetingAudioApps` | `meeting.audioApps()` | → `{ supported, apps: AudioApp[] }`：可截取声音的正在运行的应用（`{ bundleId, name, audio, output, kind }`，`kind` 为 `call`（通话软件）/ `browser`（网页会议）/ `other`；按通话软件 → 浏览器 → 其他排序，不含 MyTypeless；分类见 `meeting/call-apps.ts`，D-039）；`supported = false` 表示系统低于 macOS 14.2（D-033） |
| `meetingPrepareAppAudio` | `meeting.prepareAppAudio()` | 开会前先完成「录制系统音频」授权 → `'ready' \| 'waiting' \| 'unsupported'`；`waiting` = 系统授权框还没回应（用户允许后 macOS 会退出并重新打开 MyTypeless，所以必须在开会前）（D-033） |
| `meetingFinish` | `meeting.finish(id, opts?)` | 整理异常中断的会议：补转写临时录音尾部后照常整理 → `{ ok, error? }` |
| `meetingExport` | `meeting.exportMarkdown(id)` | 保存对话框，写出纪要 + 完整记录的 Markdown → `boolean` |
| `speakerModelAction` | `voiceprints.model(action)` | `'download' \| 'cancel' \| 'remove'` → `{ ok, error? }`；进度与状态经 `meetingLive.speakerModel` / `speakerModelProgress` 推送；会议进行或整理中不能删除 |
| `voiceprintList` / `voiceprintRename` / `voiceprintDelete` | `voiceprints.list/rename/remove` | → 最新 `Voiceprint[]`；改名同步到关联的说话人，删除立即生效（D-016） |
| `styleSampleList` / `styleSampleDelete` / `styleSampleClear` | `styleSamples.list/remove/clear` | → 最新 `StyleSample[]`（从新到旧）；删除、清空立即生效（D-041） |
| `answerInsert` | `system.answerInsert(text)` | 隐藏浮卡 → 激活提问时的前台应用 → 粘贴 → `boolean` |
| `checkPermissions` | `system.checkPermissions()` | → `PermissionStatus { accessibility, microphone, nativeHotkey, permissionHost?, fnKeyConflict }`（开发模式下 `permissionHost` 为实际持有权限的终端应用；`fnKeyConflict` 表示快捷键用到 Fn 但系统 🌐 键不是「无操作」）；非 macOS：`accessibility` 恒为 true，`permissionHost` 为空，`fnKeyConflict` 为 false |
| `openPermissionSettings` | `system.openPermissionSettings()` | 弹系统授权提示并打开辅助功能设置 |
| `resetAccessibility` | `system.resetAccessibility()` | `tccutil reset Accessibility com.mytypeless.desktop`（只清本应用）→ 弹系统授权提示并打开设置 → `boolean`（非 macOS 不做事，返回 false） |
| `openKeyboardSettings` | `system.openKeyboardSettings()` | 打开系统键盘设置（把「按下 🌐 键时」改为「无操作」；仅 macOS） |
| `barInteractive`（`send`） | `system.setBarInteractive(on)` | 鼠标进入/离开胶囊时切换浮动条是否接收鼠标（其余透明区域点击穿透） |
| `windowClose`（`send`） | `system.closeWindow()` | 隐藏发送方窗口 |

## 主进程 → 渲染端（`send`）

| 通道 | 订阅方法 | 载荷 / 说明 |
| --- | --- | --- |
| `stateChanged` | `session.onStateChanged` | `SessionProgress`，广播到所有窗口 |
| `captureFlush` | `session.onFlush` | 无载荷；浮动条必须冲刷 worklet 后调用 `audioFinal`（主进程最多等 700ms） |
| `answerCardUpdate` | `session.onAnswer` | `AnswerPayload { question, answer, pending?, error? }`，只发给回答浮卡，且在页面加载完成后发送 |
| `navigate` | `system.onNavigate` | 页面锚点：`#home`、`#history`、`#dict`、`#settings`、`#settings/about`（滚动到「关于」）、`#meeting`、`#meeting/<id>`（D-017） |
| `meetingLive` | `meeting.onLive` | `MeetingLive { state: idle/recording/paused/processing, meetingId?, title?, elapsedMs?, running?, stage?, notice?, speakerModel?, speakerModelProgress? }`，广播到所有窗口；会议进行或整理中浮动条保持显示 |
| `meetingChanged` | `meeting.onChanged` | 某场会议的内容有变化（`meetingId`），主窗口重新读取 |
| `meetingCapture` | `meeting.onCapture` | 发给浮动条：`{ on, micDeviceId }`，开/关会议录音（与听写共用麦克风管线，会议结束立即释放麦克风） |
| `dictChanged` | `dict.onChanged` | 自动学习收录了新词（`string[]`），主窗口刷新词典 |
| `updateState` | `update.onState` | `UpdateState { state: idle/checking/latest/available/downloading/downloaded/error/unsupported, version?, build?, notes?, dmgUrl?, percent?, bytesPerSec?, error?, checkedAt? }`，广播到所有窗口（D-028）；开发版与非 macOS 平台为 `unsupported` |
| `modelProgress` | `models.onProgress` | `ModelProgress { id, state: downloading/verifying/done/error/cancelled, receivedBytes, totalBytes, bytesPerSec?, error? }`，约每 200ms 一次 |

## SessionProgress

`state`：`idle | recording | transcribing | polishing | injecting | done | error`；`mode`：`dictation | translate | rewrite | ask`。

- `recording`（以及 `transcribing`）可携带 `liveText`：实时转写的文字（D-013）。`recording` 还携带 `maxRecordingMs`（最长录音时长，浮动条据此在最后 1 分钟倒计时，D-014）、`keepMicWarm` 与 `micDeviceId`（空 = 自动选麦克风），由浮动条据此开麦；`recording` 携带 `handsFree`（按住说话为 false；轻按主键或提问/翻译为 true，会再发一次 recording）与 `autoStopMs`（静音自动停止阈值，只在免手持时可能非 0）；选中即改写时会再发一次 `mode: 'rewrite'` 的 recording。
- `error` 携带面向用户的 `error` 文案；需要界面配合的错误带 `errorCode`（`LOCAL_MODEL_MISSING` 时主进程打开主窗口）；`done`/`error` 可携带非致命提示 `notice`。
- `done`/`error` 之后主进程会在 1.2～3 秒内再发一次 `idle`；渲染端不得自行推断回到 idle。
