# AI 开发规则

MyTypeless：macOS 与 Windows 上的 AI 语音听写工具（Electron + TypeScript；原生助手 macOS 用 Swift、Windows 用 C++），按住快捷键说话、松开后润色好的文字写入光标处；个人开源项目（MIT），自带 API Key（BYOK），数据只存本地。

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
2. **隐私红线**：键盘监听只匹配已注册快捷键、不做按键记录；音频处理完即弃、不落盘；屏幕文字/URL 不采集；历史只存本地；API Key 只经 `safeStorage` 加密存放（macOS 钥匙串 / Windows DPAPI，D-002）。
3. **BYOK、无中心服务**：所有云能力走用户自配的 OpenAI 兼容端点或本地 whisper.cpp（D-003）。
4. **听写不丢字**：润色、写入任一环节失败都要有降级（本地清理 / 剪贴板），不能让用户的话凭空消失（D-008）。
5. **原生能力走 CLI 子进程**（`native/` → `mt-*`，macOS 为 Swift、Windows 为 C++，两边协议相同），主进程通过 `src/main/native.ts` 调用，协议见 [原生助手契约](docs/contracts/native-helpers.md)（A-002）。
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
| `src/main/` | 主进程：会话状态机、ASR/LLM、热键、注入、设置、历史；`meeting/` 会议模式、`whisper/` 内置识别 | [AGENTS.md](src/main/AGENTS.md)（另见 [meeting](src/main/meeting/AGENTS.md)、[whisper](src/main/whisper/AGENTS.md)） |
| `src/preload/` | contextBridge 白名单 API（与 `src/shared/api.ts` 同步） | [IPC 契约](docs/contracts/ipc.md) |
| `src/renderer/` | 三个窗口：浮动条（录音采集）、主窗口、回答浮卡 | [AGENTS.md](src/renderer/AGENTS.md) |
| `src/shared/` | 主进程与渲染端共用的类型和 IPC 通道名 | [IPC 契约](docs/contracts/ipc.md) |
| `native/` | 原生助手源码（macOS Swift、`win/` 下 Windows C++）与编译产物 `native/bin/` | [AGENTS.md](native/AGENTS.md) |
| `test/` | Node 原生测试（`*.test.ts`，只测不依赖 Electron 的纯逻辑） | — |
| `scripts/` | 原生助手编译、打包、签名、发布、评测与文档脚本 `doc-kit/` | [AGENTS.md](scripts/AGENTS.md) |
| `build/` | 打包资源：应用图标、entitlements | — |
| `docs/` | 需求、决策、契约、验收与治理 | [AGENTS.md](docs/AGENTS.md) |
| `.github/` | CI（`workflows/ci.yml`：macOS 上 native / typecheck / test / build / docs:check；Windows 上 diarize:win / whisper:win / typecheck / test / build，两个 job 都是合并前必须通过的检查；`release-windows.yml`：发布时打 Windows 安装包，D-036）、Issue 与 PR 模板 | [CONTRIBUTING.md](CONTRIBUTING.md) |

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
npm run dist           # 编译 + 原生助手 + 签名证书 + 打包到 release/MyTypeless-<版本>-<构建号>-arm64.dmg（scripts/dist.cjs）；Windows 上打包为 -x64.exe（D-036）
npm run release        # 发布为本仓库的 GitHub Release（在线更新，D-028、D-032）：GH_TOKEN=$(gh auth token) 且加 --yes，人工门禁；同时由 Actions 打 Windows 包（D-036）
npm run docs:context -- --task <id> --mode <analysis|implementation|review>
npm run docs:check
```

执行前必须先确认的命令：删除 `~/Library/Application Support/MyTypeless/`（历史库、设置、加密的 API Key）；`tccutil reset`（清除系统权限授权）；任何使用 Developer ID 签名、公证或上传发布产物的命令。

## 已知陷阱

这里只列跨模块、每次开发都可能踩到的。模块相关的陷阱写在各目录的 `AGENTS.md`，改那里的代码前必读：会议 → [src/main/meeting/](src/main/meeting/AGENTS.md)，内置识别 → [src/main/whisper/](src/main/whisper/AGENTS.md)，原生助手与读输入框文字 → [native/](native/AGENTS.md)，浮动条与界面 → [src/renderer/](src/renderer/AGENTS.md)，打包、签名、在线更新、Windows 安装包 → [scripts/](scripts/AGENTS.md)。

- `npm install` 时 electron-builder 自带的旧 node-gyp 需要 Python 的 distutils（3.12 起移除）：用 Python 3.11 或装 setuptools（CI 固定 3.11）。
- `better-sqlite3` 必须按 Electron ABI 编译：保持 v11.x（v13 需 NAPI 10 / Node 22，会段错误），`electron-builder.yml` 的 `npmRebuild: false` 不要去掉。
- Windows 上不能直接 `npm install`，用 `npm run setup:win`（原因见 `scripts/AGENTS.md`）；Windows 开发服务器固定监听 127.0.0.1（`localhost` 可能只解析到 `::1`，窗口白屏）。
- 开发模式下辅助功能 / 麦克风权限归属于启动 `npm run dev` 的终端应用（iTerm、终端、VS Code…），给 MyTypeless 授权无效（主窗口状态面板会指出是哪个应用）：测采集、快捷键、写入用打包版。
- 打包版隔离实例测试的 `--user-data-dir` 必须带空格（如 `/tmp/mt smoke/ud`）：真实数据目录 `~/Library/Application Support/` 含空格，给子进程的按行命令里路径必须放在行尾（曾因路径被空格截断，真实会议的声纹全部失败而测试全过）。
- 平台差异（GAP-008）：调用 macOS 专有能力（`systemPreferences` 的辅助功能 / 麦克风授权、`tccutil`、`defaults`、`ps`、`osascript`、`x-apple.systempreferences:`、模板图、`titleBarStyle: 'hiddenInset'`、`type: 'panel'`）前先判断 `process.platform`，否则在 Windows 上直接抛错、整个启动流程中断。键名、系统设置路径、默认快捷键（Windows 主键右 Ctrl）用 `src/shared/platform.ts`；界面上只属于 macOS 的元素加 `mac-only` 类、只属于其他平台的加 `non-mac`。

## 任务流程

1. 阅读 [docs/STATUS.md](docs/STATUS.md)，运行 `npm run docs:context -- --list` 查找任务 ID。
2. 运行 `npm run docs:context -- --task <id> --mode <mode> [--impact <ids>]`，阅读输出的文档和模块说明。
3. 检查 [docs/open-questions.md](docs/open-questions.md) 是否有影响本任务的未决事项。
4. 先写测试，再实现最小完整能力。
5. 运行任务路由给出的验证命令。
6. 按[任务收尾](docs/governance/playbooks/task-closeout.md)同步文档并写过程记录，最后运行 `npm run docs:check`。

默认只搜索路由输出的目录。需要跨域时先说明原因并增加对应 `--impact`。不要读取 `docs/_history/`，除非任务明确需要追溯历史。

## 代码协作（GitHub）

- 仓库 `cjx157791216/MyTypeless`（公开，D-031）。`main` 受保护：只能经 PR 合并、CI（`.github/workflows/ci.yml` 的 `check` 与 `check-windows`）必须通过、不能强推；合并方式只有 squash。
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

功能“完成”需要以下自动检查全部通过：`npm run typecheck`、`npm run test`、`npm run build`、`npm run docs:check`。改了 `native/*.swift` 时还需 `npm run native` 编译通过；改了 `native/win/` 时需 CI 的 `check-windows`（或 Windows 上 `npm run native:win`）编译与测试通过。改原生协议时，契约、Swift 与 C++ 两份实现、`test/native-helpers.test.ts` 在同一个 PR 里一起改。真机验证（快捷键、写入其他应用）不是完成条件，但未验证的项要在 [缺口账本](docs/implementation/gap-ledger.md) 中标为 `DONE_PENDING_REVIEW`。
