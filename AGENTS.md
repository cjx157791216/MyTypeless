# AI 开发规则

MyTypeless：macOS 上的 AI 语音听写工具（Electron + TypeScript + Swift 原生助手），按住快捷键说话、松开后润色好的文字写入光标处；个人开源项目（MIT），自带 API Key（BYOK），数据只存本地。

本文件对所有 AI 编码工具通用（Claude Code 通过同目录 `CLAUDE.md` 导入本文件；Codex、DeepSeek Harness 等直接读取）。开始任何任务前：

1. 阅读本文件和 [docs/STATUS.md](docs/STATUS.md)（项目当前状态的唯一来源）。
2. 运行任务路由读取最小文档集（见“任务流程”）。
3. 修改某个目录的代码前，阅读该目录及其上级目录中的 `AGENTS.md`（模块说明）。部分工具只自动加载当前目录以上的 `AGENTS.md`，因此这一步不能省略。

## 工作语言

- 项目沟通和业务文档使用中文；代码、配置、接口、数据库对象和提交信息使用英文（已有提交信息为中文，可沿用）。
- 术语与命名以 [docs/glossary.md](docs/glossary.md) 为准；新建代码标识前先查，没有则先登记。
- 不得自行补全产品规则。文档未给出且会影响用户可见结果时，按[需求未定义时](docs/development/recipes.md#需求未定义时)登记为未决事项。

## 开发原则

1. **全部原创**：不得复制、改写或引入其他产品的代码、提示词、资源、文案、商标；不接入其服务端（D-001）。
2. **隐私红线**：键盘监听只匹配已注册快捷键、不做按键记录；音频处理完即弃、不落盘；屏幕文字/URL 不采集；历史只存本地；API Key 只经 `safeStorage`（Keychain）加密存放（D-002）。
3. **BYOK、无中心服务**：所有云能力走用户自配的 OpenAI 兼容端点或本地 whisper.cpp（D-003）。
4. **听写不丢字**：润色、写入任一环节失败都要有降级（本地清理 / 剪贴板），不能让用户的话凭空消失（D-008）。
5. **原生能力走 Swift CLI 子进程**（`native/` → `mt-*`），主进程通过 `src/main/native.ts` 调用，协议见 [原生助手契约](docs/contracts/native-helpers.md)（A-002）。
6. **IPC 只走白名单**：通道名只在 `src/shared/types.ts` 的 `IPC` 中定义，渲染端只能用 preload 暴露的 API（[IPC 契约](docs/contracts/ipc.md)）。

## 事实优先级

出现冲突时按以下顺序裁决：

1. 已确认的需求和验收标准。
2. 决策登记中已确认的决策与 `accepted` 状态的 ADR。
3. `docs/requirements/` 中已确认的规则。
4. 接口契约与自动化测试表达的已实现契约。
5. 实施计划、历史资料和过程记录（`docs/_history/`）。

文档描述的目录结构或命令与代码不一致时，以代码为准，并回改文档。

## 代码地图

| 路径 | 内容 | 模块说明 |
| --- | --- | --- |
| `src/main/` | 主进程：会话状态机、ASR/LLM、热键、注入、设置、历史 | [AGENTS.md](src/main/AGENTS.md) |
| `src/preload/` | contextBridge 白名单 API（与 `src/shared/api.ts` 同步） | [IPC 契约](docs/contracts/ipc.md) |
| `src/renderer/` | 三个窗口：浮动条（录音采集）、主窗口、回答浮卡 | [AGENTS.md](src/renderer/AGENTS.md) |
| `src/shared/` | 主进程与渲染端共用的类型和 IPC 通道名 | [IPC 契约](docs/contracts/ipc.md) |
| `native/` | 原生助手源码（macOS Swift、`win/` 下 Windows C++）与编译产物 `native/bin/` | [AGENTS.md](native/AGENTS.md) |
| `test/` | Node 原生测试（`*.test.ts`，只测不依赖 Electron 的纯逻辑） | — |
| `scripts/` | 原生编译、图标生成、文档脚本 `doc-kit/` | — |
| `build/` | 打包资源：应用图标、entitlements | — |
| `docs/` | 需求、决策、契约、验收与治理 | [AGENTS.md](docs/AGENTS.md) |
| `.github/` | CI（`workflows/ci.yml`：macOS 上 typecheck / test / build / docs:check / native；Windows 上 diarize:win / whisper:win / typecheck / test / build）、Issue 与 PR 模板 | [CONTRIBUTING.md](CONTRIBUTING.md) |

常见改动的完整步骤见 [docs/development/recipes.md](docs/development/recipes.md)。

## 常用命令

```bash
npm install            # postinstall 按 Electron ABI 重编译 better-sqlite3
npm run setup:win      # Windows 代替 npm install（scripts/setup-win.cjs，原因见已知陷阱）
npm run native         # 编译 Swift 助手到 native/bin/（改了 native/*.swift 必须重跑）
npm run native:win     # Windows：编译 native/win/*.cpp 到 native/bin/mt-*.exe（需要 VS 2022 生成工具）
npm run diarize:win    # Windows：另外编译 mt-diarize.exe（首次下载 sherpa-onnx 静态库到 .vendor/sherpa-onnx-win/）
npm run whisper:win    # Windows：编译 mt-whisper.exe（whisper.cpp 源码，只用 CPU；同版本已编译则跳过）
npm run whisper        # 编译内置识别引擎 mt-whisper（whisper.cpp 源码，需要 brew install cmake；同版本已编译则跳过）
npm run diarize        # 编译会议声纹助手 mt-diarize（首次下载 sherpa-onnx 预编译静态库到 .vendor/）
npm run dev            # 开发运行；shell 里有 ELECTRON_RUN_AS_NODE=1 时先 unset
npm run typecheck
npm run test
npm run build
npm run dist           # 编译 + 原生助手 + 签名证书 + 打包到 release/MyTypeless-<版本>-<构建号>-arm64.dmg（scripts/dist.cjs）
npm run release        # 发布为本仓库的 GitHub Release（在线更新，D-028、D-032）：GH_TOKEN=$(gh auth token) 且加 --yes，人工门禁
npm run docs:context -- --task <id> --mode <analysis|implementation|review>
npm run docs:check
```

执行前必须先确认的命令：删除 `~/Library/Application Support/MyTypeless/`（历史库、设置、加密的 API Key）；`tccutil reset`（清除系统权限授权）；任何使用 Developer ID 签名、公证或上传发布产物的命令。

## 已知陷阱

- `npm install` 时 electron-builder 自带的旧 node-gyp 需要 Python 的 distutils（3.12 起移除）：用 Python 3.11 或装 setuptools（CI 固定 3.11）。
- `better-sqlite3` 必须按 Electron ABI 编译：保持 v11.x（v13 需 NAPI 10 / Node 22，会段错误），`electron-builder.yml` 的 `npmRebuild: false` 不要去掉。
- 浮动条 CSP 必须允许 `script-src blob:`，否则 AudioWorklet 加载失败、录音无声。
- `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })` 必须带 `skipTransformProcessType: true`，否则 Electron 把整个应用变成 UIElement（Dock 图标消失、⌘Tab 切不到）；浮动条用 `type: 'panel'` 浮在全屏应用上。
- 系统默认输入可能是虚拟设备（如变声器 Screaming Bee），只出纯静音；采集必须走“自动选麦克风 + 纯零兜底”（`floating-bar/main.ts` 的 `pickDeviceId` / `switchFromSilentDevice`）。开发实例的麦克风授权属于终端，测采集请用打包版。
- 内置引擎每次识别约 0.9 秒且与音频长度无关（固定 30 秒窗口，几乎全在 GPU）：优化看“识别次数”而不是“音频长度”；实时转写见 `src/main/live.ts`。
- 会议模式（D-015）：会议与听写共用浮动条的麦克风管线和内置引擎；会议进行中听写被 `session.setBlocker` 拦下。说话人区分：停顿切句后，每句再用分段模型（带前 8 秒参考录音）找句内换人位置并切开——真人对话常常不停顿就接话，只按停顿切会把两人并成一句；分段模型在几秒的短片段里分不清人，所以必须带参考录音。判断“是不是同一个人”一律用平均链接（与某人每段的平均相似度；在线归入 0.57、达到参会人数后只归入最像的人；整体归类只按参会人数——D-021 去掉了自动判断人数：一台麦克风的短句会议里不同人可到 0.4、同一人可低到 0.1，任何门槛都两头出错，不要再加回来），不要用“与归一化中心的余弦”：同一个声源（一台麦克风、外放、同一房间）会给所有人加上相同成分，中心比较会把不同的人并成一个；会议中每 20 秒整体重新归类一次。句内换人：会议已区分出各人后用 `splitByWindows`（1.5 秒窗口与各人比较，D-025），比分段模型自己在短片段里猜几个人可靠；按窗口切的段不要再 `mergeAdjacentParts`（同一声源下不同人也可能 ≥ 0.55，会把切开的又合回）。声纹认人（D-022）用整组声音的匹配分（÷ 声纹自身一致度，`printScore`），不要用固定相似度门槛比单句：有的人自己各句之间平均只有 0.5，固定 0.55 连保存声纹的那场都认不出。改聚类必须通过 `test/fixtures/speakers.json`（sr-data 真人完整段与 1～2.5 秒短句，原声 / 外放）的回归（`src/main/meeting/cluster.ts`）；换声纹模型（D-026）要用 `scripts/gen-speaker-fixture.cjs` 重新生成它、按真实会议录音重新标定 `SAME_SPEAKER` / `KNOWN_CUT` / `PRINT_MATCH`（保持不同人误并率不变），并改 `EMBED_MODEL`——不同模型的声纹维度可能相同但不可比较。真实会议多是 1～2 秒短句，同一人两句可低到 0.1～0.3，不要只用长句数据调门槛。
- 会议远场（D-024）：GTCRN 降噪后的声音只用于分句，**不要拿去识别**——弱的人声会被一起削掉，很远时错字翻倍；识别用原始录音 + `normalizeLoudness`。上一句做提示词、简单谱减降噪实测没有稳定收益。改分句或识别前处理要用远场模拟（音量小 18/26 dB + 混响 + 房间底噪）对比，不要只用近讲录音。
- Electron / Chromium 应用（Claude、VS Code、Slack…）默认不公开辅助功能树：问系统焦点元素返回 -25204，读不到输入框文字（自动词典追踪修改、选中即改写都会失效）。`mt-focus` 的 `focusedElement` 会改问应用自己的焦点并打开 `AXManualAccessibility`；新增读文字的原生功能要复用它，并用 Electron 应用实测。
- 打包版隔离实例测试的 `--user-data-dir` 必须带空格（如 `/tmp/mt smoke/ud`）：真实数据目录 `~/Library/Application Support/` 含空格，给子进程的按行命令里路径必须放在行尾（曾因路径被空格截断，真实会议的声纹全部失败而测试全过）。
- 识别引擎 `mt-whisper`（whisper-server）不随父进程退出：应用启动时 `killOrphanEngines` 清理父进程已是 launchd 的残留。
- VAD（`live.ts` 的 `Vad`，听写与会议共用）阈值下限 250（远处、外放的人声只有 300 左右）；底噪只能贴着最安静的帧更新：让非语音帧都参与平均会被说话中较轻的部分抬高，把下一句正常音量的话当成静音（真人录音实测漏掉整句）。
- 内置识别有两个引擎（D-027）：中文/英文默认 FireRedASR2（mt-diarize `--firered`，CPU，每句 1～2.5 秒），其他语言用 Whisper（mt-whisper）。FireRedASR2 输出**不带标点、英文全大写、不支持热词**，静音时输出特殊标记 `<sil>`（标点模型会变成 `< sil >。`，由 `text.ts` 的 `stripAsrTokens` 去掉）：标点靠 `--punct` 标点模型，大小写靠 `text.ts` 的 `fixAsrCase`（按词典恢复）；换识别模型要用人工标注的公开数据（WenetSpeech test_meeting、AISHELL-1、ASCEND）在本机实测错字率，不要拿某个模型的输出当参考答案。听写录音经 `asr` 命令的 base64 传入，不能写临时文件（D-002）。
- Whisper 引擎：`language=auto` 会多跑一次编码器（耗时翻倍），默认按系统语言传 `zh` 等；缩小 `audio_ctx` 会让 turbo 模型输出乱码。模型在 `~/Library/Application Support/MyTypeless/models/`。
- `electron-builder.yml` 的 `identity: null` 会让 electron-builder 完全跳过签名，由 `afterPack: scripts/sign-app.cjs` 补签：有本地证书（`scripts/setup-signing.sh`，存于 `.vendor/signing/`，`predist` 自动生成）就用证书签名，重新打包后系统授权仍有效；没有才退回 adhoc（每次打包都要重新授权）。不要删 `.vendor/signing/`，删了证书会变、所有授权失效。
- 在线更新（D-028）按**版本号**判断新旧，不看构建号：发布前必须升级 `package.json` 的 `version`（`npm run release` 会拒绝不更大的版本）。自动安装要求新旧版本同一证书签名；应用不在「应用程序」文件夹（如直接从 DMG 运行）时 Squirrel 无法替换。开发运行不检查更新；测试用打包版 + `MT_UPDATE_URL=http://127.0.0.1:<端口>/latest` 指向本机临时服务器。
- 从 adhoc 版本换到证书签名版本时，系统里旧的授权记录无效但开关显示为开：主窗口「重置授权」按钮会清除本应用的旧记录。
- 线上会议截取应用声音（D-033，`mt-audiotap`）：用户在授权框点「允许」录制系统音频后，**macOS 会退出并重新打开所有 MyTypeless 实例**（包括隔离测试实例），所以授权必须在开会前完成（`prepareAppAudio` / `--probe`）；没授权时系统只给全零、不报错。Process tap 的 IOProc 不能交给 dispatch queue（会跳过 IO 周期，声音短约 0.3%，与麦克风时间线错位）；tap 报的格式是 48kHz，但数据按输出设备的实际采样率到来（MacBook 扬声器 44.1kHz），要按聚集设备的 `NominalSampleRate` 重采样。外放回声门槛 `ECHO_CORR` 用 `scripts/echo-sim.ts`（真人录音 + 模拟外放）重新标定，同时看“只有回声被去掉多少”和“戴耳机 / 同时说话时现场的话保留多少”。
- 开发模式下辅助功能/麦克风权限归属于启动 `npm run dev` 的终端应用（iTerm、终端、VS Code…），给 MyTypeless 授权无效；主窗口状态面板会指出是哪个应用。
- Windows 移植（GAP-008）：调用 macOS 专有能力（`systemPreferences.isTrustedAccessibilityClient` / `askForMediaAccess`、`tccutil`、`defaults`、`ps`、`osascript`、`x-apple.systempreferences:`、模板图、`titleBarStyle: 'hiddenInset'`、`type: 'panel'`）前先判断 `process.platform`——这些在 Windows 上要么不存在（直接抛错，整个启动流程中断），要么行为不同。界面上的键名、系统设置路径、默认快捷键（Windows 主键右 Ctrl）用 `src/shared/platform.ts`，只属于 macOS 的元素加 `mac-only` 类、只属于其他平台的加 `non-mac`。
- Windows 读选区 / 光标上下文（`mt-focus`，D-012）：Chromium / Electron 应用要先唤醒辅助功能，且唤醒前已获得焦点的输入框要等光标动一次才可读（真实流程里听写开始时的选区检查负责唤醒，写入后自动词典就能读到）；WinForms 文本框经系统代理“支持”文本模式却读出空串，要退到 `EM_GETSEL` / `WM_GETTEXT`；端到端测试只能对自建窗口操作（脚本发按键前核对前台进程与窗口标题），不能用记事本等真实应用（Windows 11 记事本会恢复用户未关闭的标签页）。
- Windows 上不能直接 `npm install`：better-sqlite3 没有 Node 24 的 Windows 预编译包（现场编译要 VS 的 ClangCL 组件），Electron 33 的安装脚本在 Node 24 下只解压出第一个文件却报告成功；用 `npm run setup:win`（跳过安装脚本、按 Electron ABI 下载预编译包、解压不完整时用系统 tar）。CI 的 Windows job 只跑 typecheck / test / build，用 `npm ci --ignore-scripts` 即可。Windows 上开发服务器固定监听 127.0.0.1（`localhost` 可能只解析到 `::1`，Electron 连接被拒，窗口白屏）。

## 任务流程

1. 阅读 [docs/STATUS.md](docs/STATUS.md)，运行 `npm run docs:context -- --list` 查找任务 ID。
2. 运行 `npm run docs:context -- --task <id> --mode <mode> [--impact <ids>]`，阅读输出的文档和模块说明。
3. 检查 [docs/open-questions.md](docs/open-questions.md) 是否有影响本任务的未决事项。
4. 先写测试，再实现最小完整能力。
5. 运行任务路由给出的验证命令。
6. 按[任务收尾](docs/governance/playbooks/task-closeout.md)同步文档并写过程记录，最后运行 `npm run docs:check`。

默认只搜索路由输出的目录。需要跨域时先说明原因并增加对应 `--impact`。不要读取 `docs/_history/`，除非任务明确需要追溯历史。

## 代码协作（GitHub）

- 仓库 `cjx157791216/MyTypeless`（公开，D-031）。`main` 受保护：只能经 PR 合并、CI（`.github/workflows/ci.yml` 的 `check`）必须通过、不能强推；合并方式只有 squash。
- 每项改动从最新 `main` 开分支（`feat/…`、`fix/…`、`docs/…`、`ci/…`），只提交本任务的文件（工作区里可能有其他任务未提交的改动），推送后开 PR，CI 通过再合并；PR 描述写改了什么、为什么、怎么验证、关联的 D/GAP 编号。
- 外部贡献者从 fork 提 PR；涉及隐私、合规、数据兼容的改动先开 Issue（见 [CONTRIBUTING.md](CONTRIBUTING.md)）。
- 远端 `gitlab` 是迁移前的私有存档（含开源前的完整历史），只读，不再推送。

## 模块说明约定

- 每个代码目录的 `AGENTS.md` 只写该目录的结构、入口、可复制范例、不变量、测试命令和必读文档，控制在 80 行以内；不写项目状态，不复制需求正文。
- 同目录必须有内容为 `@AGENTS.md` 的 `CLAUDE.md`（`npm run docs:check` 校验）。
- 新增顶层代码目录或改变模块约定时，同步该目录 `AGENTS.md` 与上方代码地图。

## 人工门禁

AI 可以自主完成设计细化、编码、测试和文档同步。以下事项必须暂停并请求人工确认：

- 未确认规则存在两个以上会改变用户可见结果的合理解释。
- 引入任何可能来自其他产品的代码、提示词、资源或文案（合规红线，D-001）。
- 改变隐私行为：新增数据外发、采集屏幕/选区以外的上下文、音频落盘、扩大键盘监听范围（D-002）。
- 破坏用户数据兼容：`settings.json`、`keys.bin`、sqlite 表结构的不兼容变更（只允许向前兼容的增量迁移）。
- 使用 Developer ID 签名、公证或对外分发产物（包括 `npm run release -- --yes` 上传新版本）。
- 需要真实 API Key 等生产凭据；执行不可逆的数据删除。
- 重新编号已有的 D/B/GAP 编号。

## 完成标准

功能“完成”需要以下自动检查全部通过：`npm run typecheck`、`npm run test`、`npm run build`、`npm run docs:check`。改了 `native/*.swift` 时还需 `npm run native` 编译通过。真机验证（快捷键、写入其他应用）不是完成条件，但未验证的项要在 [缺口账本](docs/implementation/gap-ledger.md) 中标为 `DONE_PENDING_REVIEW`。
