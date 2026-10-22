# 功能缺口账本

状态：`active`。本文登记从“需求”到“验收通过”之间的每个缺口，是任务队列和验收证据的入口。每行保持简短：缺口一句话、证据和验收用链接指向独立文件；单元格不写过程流水账（过程写入 `docs/_history/`）。

## 状态

| 值 | 含义 |
| --- | --- |
| `CONFIRMED_GAP` | 已确认缺失，进入开发队列 |
| `IMPLEMENTATION_PENDING` | 规则与接口已定义，实现未闭环 |
| `INPUT_BLOCKED` | 需要人工输入（关联 B 项），AI 不得猜测 |
| `DEFERRED` | 已确认后置 |
| `DONE_PENDING_REVIEW` | 已交付，等待人工验收 |
| `DONE` | 通过代码、契约、数据、权限和验收门禁 |

优先级：`P0` 阻塞当前主链路或会造成数据/契约错误；`P1` 阻塞完整上线；`P2` 体验、性能或增强。

## 当前账本

| ID | 优先级/状态 | 缺口 | 规则来源 | 验收证据 |
| --- | --- | --- | --- | --- |
| GAP-001 | P0 / `DONE_PENDING_REVIEW` | 稳定性修复（快捷键、录音采集、尾音、润色降级、写入、回答浮卡等）未经授权真机验证 | [听写管线需求](../requirements/pipeline.md)、[原生层需求](../requirements/native.md) | [运行记录](../_history/agent-runs/2026-10-14-stability-fixes.md)；待 PIPE-001、NATI-001～004 真机通过 |
| GAP-002 | P1 / `CONFIRMED_GAP` | 自动化测试只覆盖 `polish.ts`；会话状态机、绑定解析、错误映射依赖 `electron`，没有测试 | A-006 | — |
| GAP-003 | P2 / `CONFIRMED_GAP` | 更多云端 ASR 提供方（Deepgram、Qwen/阿里云）未实现 | D-004 | — |
| GAP-004 | P2 / `CONFIRMED_GAP` | 非 OpenAI 兼容的 LLM 提供方（如 Anthropic 原生接口）未实现 | D-003 | — |
| GAP-005 | P2 / `CONFIRMED_GAP` | 写入降级链缺少“辅助功能 API 直接设值”一级 | [原生层需求](../requirements/native.md) | — |
| GAP-006 | P1 / `DONE_PENDING_REVIEW` | 词典自动学习（写入后追踪修改 + 常用专有名词） | D-012 | 单测 `test/learn.test.ts`；Electron / Chromium 应用（Claude 等）读不到光标附近文字已修复（见[运行记录](../_history/agent-runs/2026-10-15-learn-electron.md)）；待 PIPE-012 真机通过 |
| GAP-007 | P2 / `DONE_PENDING_REVIEW` | 光标上下文辅助润色 | D-040 | 单测 `test/polish.test.ts`；评测集 `ctx-*` 用例；[运行记录](../_history/agent-runs/2026-10-18-context-style.md)；待 PIPE-017 真机通过 |
| GAP-008 | P2 / `IMPLEMENTATION_PENDING` | Windows / Linux 移植：Windows 平台层已完成（应用可启动，界面与权限按平台区分，`npm run setup:win`，CI `check-windows`）；Windows 助手已有 `mt-text`、`mt-focus`（前台应用、激活、选区与光标上下文）、`mt-inject`（键入、粘贴、抓选区）、`mt-hotkey`（默认右 Ctrl，D-035）、`mt-diarize`（中英文内置识别、会议声纹）、`mt-whisper`（多语种识别，只用 CPU）、`mt-audiotap`（线上会议截取应用声音，Windows 11）；Windows 安装包与在线更新（D-036：NSIS 一键安装到当前用户、发布时由 GitHub Actions 打 Windows 包）已随 v0.3.2 发布（x64 安装包与解压即用版），本机更新端到端通过，待 Windows 真机验证 | D-006、D-035、D-036、D-037 | 单测 `test/platform.test.ts`、`test/bindings.test.ts`、`test/native-helpers.test.ts`、`test/native-win.test.ts`；运行记录：[平台层](../_history/agent-runs/2026-10-17-windows-platform-layer.md)、[mt-text / mt-focus](../_history/agent-runs/2026-10-17-windows-text-focus.md)、[mt-inject](../_history/agent-runs/2026-10-17-windows-inject.md)、[mt-hotkey](../_history/agent-runs/2026-10-17-windows-hotkey.md)、[mt-diarize](../_history/agent-runs/2026-10-17-windows-diarize.md)、[选区读取](../_history/agent-runs/2026-10-17-windows-uia.md)、[Whisper 暂不支持（已被取代）](../_history/agent-runs/2026-10-17-windows-whisper-unsupported.md)、[mt-whisper](../_history/agent-runs/2026-10-17-windows-whisper.md)、[mt-audiotap](../_history/agent-runs/2026-10-17-windows-audiotap.md)、[审查建议](../_history/agent-runs/2026-10-17-windows-review-fixes.md)、[安装包与在线更新](../_history/agent-runs/2026-10-17-windows-installer.md)、[解压即用版](../_history/agent-runs/2026-10-17-windows-zip.md)、[协议对齐](../_history/agent-runs/2026-10-18-cross-platform-checks.md) |
| GAP-009 | P1 / `DEFERRED` | Developer ID 签名与公证（对外分发前必需；人工门禁）。注意：`identity: null` 会让 README 中设置 `CSC_NAME` 的做法失效，届时需改配置并开启 hardenedRuntime | [打包发布需求](../requirements/release.md) | — |
| GAP-010 | P1 / `DONE_PENDING_REVIEW` | 边说边识别（实时文字、停顿即识别、长段定稿） | D-013 | 单测 `test/live.test.ts`；真实引擎实时回放基准见[运行记录](../_history/agent-runs/2026-10-15-live-learn.md)；待 PIPE-011 真机通过 |
| GAP-011 | P0 / `DONE_PENDING_REVIEW` | 内置本地识别（引擎随包、首次下载模型、进程管理、繁简转换）：自动检查与隔离实例端到端已通过，待真机按快捷键验证 | D-009 | [运行记录](../_history/agent-runs/2026-10-14-builtin-whisper.md)；待 PIPE-008、PIPE-009、UI-005 真机通过 |
| GAP-012 | P0 / `DONE_PENDING_REVIEW` | 按住 Fn 说话的交互（Fn 按住/轻按免手持、选中即改写、Fn 组合、底部胶囊）：时序单测与胶囊状态已验证，待真机按 Fn 验证 | D-010 | [运行记录](../_history/agent-runs/2026-10-14-fn-interaction.md)；待 NATI-001/002/005～008、UI-006/007 真机通过 |
| GAP-013 | P1 / `DONE_PENDING_REVIEW` | 识别准确度：中文/英文改用 FireRedASR2 + 标点模型（D-027），公开人工标注数据实测错字率会议 18.3% → 5.3%、朗读 7.5% → 1.1%、中英混说 29.2% → 11.7%；已评估 Qwen3-ASR、Fun-ASR-Nano、FireRedASR2-CTC、SenseVoice（均不如）；待真机听写延迟与准确度体验 | D-009、D-027 | [运行记录](../_history/agent-runs/2026-10-15-model-upgrade.md)、[早期评估](../_history/agent-runs/2026-10-15-accuracy-signing.md) |
| GAP-014 | P2 / `DEFERRED` | 省 GPU 模式：编码器放到神经网络引擎（Core ML，CPU+ANE），实测每次约 1.2 秒（GPU 版约 0.9 秒）、需额外下载 1.2GB | D-013 | [运行记录](../_history/agent-runs/2026-10-15-live-learn.md) |
| GAP-015 | P1 / `DONE_PENDING_REVIEW` | 长录音（默认 20 分钟、最后 1 分钟倒计时、分段识别、润色超时随长度增加） | D-014 | 单测 `test/live.test.ts`、`test/polish.test.ts`；待 PIPE-013 真机通过 |
| GAP-016 | P1 / `DONE_PENDING_REVIEW` | 主窗口改版：左侧导航、首页概览、设置分组、模式切换 | D-017 | 打包版隔离实例截图检查（首页、设置、会议列表/详情/纪要）；待 UI-009～011 真机通过 |
| GAP-017 | P1 / `DONE_PENDING_REVIEW` | 会议录制与转写：按句转写、定稿落库、暂停/继续、异常恢复、会议中暂停 Fn、4 小时上限 | D-015、D-016 | 单测 `test/meeting.test.ts`；打包版端到端（合成语音经真实采集管线）与强杀恢复见[运行记录](../_history/agent-runs/2026-10-15-meeting-mode.md)；待 MEET-002～004、010、012 真机通过 |
| GAP-018 | P1 / `DONE_PENDING_REVIEW` | 说话人区分：本地声纹模型、按参会人数实时标注与结束时重新归类、改名/改归属/合并、声纹库 | D-015、D-016 | 单测；合成语音 3 人 7 句全部归对、第二场会议按声纹自动认出；真人 4 人公开录音（原声与模拟电脑外放）经真实采集管线全部归对（含不停顿接话），单人不被拆开；数据目录含空格时的声纹失败已修复并以带空格目录复测；短句会议过度拆分已修复，可随时改人数（见[运行记录](../_history/agent-runs/2026-10-15-meeting-speakers.md)）；说得少的一方被并掉已修复——改为只按参会人数区分（D-021，见[运行记录](../_history/agent-runs/2026-10-15-speaker-count.md)）；保存的声纹下次认不出已修复——按整组声音与声纹自身一致度认人（D-022，见[运行记录](../_history/agent-runs/2026-10-15-voiceprint-match.md)）；远处说话漏句、识别不准已改进——边录边降噪分句、识别前音量归一（D-024，见[运行记录](../_history/agent-runs/2026-10-15-far-field.md)）；两人间隔很短被记成一个人已改进——按窗口与各人比较找换人位置（D-025，见[运行记录](../_history/agent-runs/2026-10-15-quick-turns.md)）；声纹模型换成 ERes2NetV2 并重标定（D-026，见[运行记录](../_history/agent-runs/2026-10-15-model-upgrade.md)）；待 MEET-005～007、MEET-016～019 真机通过 |
| GAP-019 | P1 / `DONE_PENDING_REVIEW` | 每人发言总结与会议纪要：生成、编辑、导出 Markdown、重新生成 | D-015 | 单测（转写稿、分段、头部、导出、Markdown 展示）；未配 LLM 的路径已验证；真实 LLM 生成未测（测试环境无 Key），待 MEET-008、009、011 |
| GAP-020 | P1 / `DONE_PENDING_REVIEW` | 在线更新：检查新版本、确认后应用内下载、重启更新、发布脚本；v0.2.1 已发布（旧发布仓库与代码仓库）；版本改发到代码仓库（D-032），v0.3.0 已发布到代码仓库并同步旧发布仓库，待从 0.2.1 经旧发布仓库在线更新到 0.3.0 | D-028、D-029、D-032 | 单测 `test/update.test.ts`；打包版本机端到端见[运行记录](../_history/agent-runs/2026-10-17-online-update.md)；待 RELE-004～007 用真实发布地址通过 |
| GAP-021 | P1 / `DONE_PENDING_REVIEW` | 开源：清理逆向资料与他人产品引用、补 LICENSE / README（中英）/ CONTRIBUTING / SECURITY / 行为准则 / Issue 与 PR 模板 / CI，在 GitHub 以清理后的快照建仓库；待负责人审阅后设为公开 | D-030 | [运行记录](../_history/agent-runs/2026-10-17-open-source.md) |
| GAP-022 | P1 / `DONE_PENDING_REVIEW` | 线上会议：声音来源三选一、截取会议软件的声音（mt-audiotap）、现场 / 线上两路各自区分说话人、外放回声去除、开会前授权 | D-033 | 单测 `test/echo.test.ts`、`test/meeting.test.ts`；打包版真机外放端到端（Chrome + 系统朗读）见[运行记录](../_history/agent-runs/2026-10-17-meeting-app-audio.md)；待 MEET-020～025 用真实会议软件通话通过 |
| GAP-023 | P1 / `DONE` | 听写润色提示词改版（书面格式规则、原创示例、前缀缓存友好）与原创评测集 | D-038 | 单测 `test/polish.test.ts`；真实模型评测 新 37/37、旧 34/37，耗时 +3%（见[运行记录](../_history/agent-runs/2026-10-18-polish-prompt.md)）；PIPE-016 打包版真机通过（2026-10-18） |
| GAP-024 | P1 / `DONE_PENDING_REVIEW` | 风格学习（修改记录作润色示例、个人风格说明） | D-041 | 单测 `test/learn.test.ts`（`editedSpan`）、`test/polish.test.ts`；评测集 `style-*` 用例；[运行记录](../_history/agent-runs/2026-10-18-context-style.md)；待 PIPE-018 真机通过 |
| GAP-025 | P1 / `DONE_PENDING_REVIEW` | 参会人数“自动”、按“分不分得开”区分说话人、声纹认人减去背景声音与自动名字复核 | D-042 | 单测 `test/meeting.test.ts`（sr-data 1～4 人自动人数全部判对、两句不单算一人、命名过的人保留、声纹不到 3 句不认）；283 个场景的离线评测见[运行记录](../_history/agent-runs/2026-10-19-meeting-auto-speakers.md)；待 MEET-028～030 真人真机通过 |
| GAP-027 | P1 / `DONE_PENDING_REVIEW` | 保存会议录音（设置里选文件夹，整理时另存 WAV，两路混成一个） | D-044 | 单测 `test/meeting-recording.test.ts`（文件名、序号、混音、分块写入、失败不留半个文件）；隔离实例端到端（异常中断会议的继续整理：只用麦克风、两路混音逐点一致、文件夹不可写时改存应用数据目录）见[运行记录](../_history/agent-runs/2026-10-22-meeting-save-audio.md)；待 MEET-032 真机通过 |
