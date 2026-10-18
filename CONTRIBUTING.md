# 参与贡献 / Contributing

感谢你愿意参与 MyTypeless！Issue、PR 用中文或英文都可以。*Issues and PRs in English are welcome.*

## 开始之前

- **先读 [AGENTS.md](AGENTS.md)**：开发原则、代码地图、常用命令和已知陷阱都在里面。用 AI 编码工具（Claude Code、Codex、Cursor…）参与开发时，它们会自动读取这个文件。
- **改动较大或会改变用户可见行为时，先开 Issue 讨论**：产品规则只来自 [docs/requirements/](docs/requirements/README.md) 与 [决策登记](docs/decisions/decision-register.md)，文档里没有的规则不要自行补全。
- **小修小补（错别字、明显的 bug、补测试）直接提 PR。**

## 开发环境

- Apple Silicon Mac、Xcode Command Line Tools、Node.js 24（或 22.18 以上）、`brew install cmake`
- `npm install` 报 `No module named 'distutils'`：编译 better-sqlite3 的 node-gyp 需要 distutils，用 Python 3.11 或先 `pip3 install setuptools`
- 首次：`npm install` → `npm run native` → `npm run whisper` → `npm run diarize` → `npm run dev`
- 开发模式下辅助功能 / 麦克风权限属于运行 `npm run dev` 的终端应用

### Windows

- Windows 10/11 x64、Node.js 24、Visual Studio 2022 生成工具（“使用 C++ 的桌面开发”，编译 Windows 原生助手时需要）
- **不要直接 `npm install`**，用 `npm run setup:win`：跳过 better-sqlite3 按 Node 编译的步骤、直接下载 Electron 版预编译包，并修正 Electron 解压不完整的问题。网络慢时先设置 `ELECTRON_MIRROR`（如 `https://npmmirror.com/mirrors/electron/`）
- `npm run native:win` 编译 Windows 原生助手（`mt-text`、`mt-focus`、`mt-inject`、`mt-hotkey`、`mt-audiotap`）
- `npm run diarize:win` 另外编译 `mt-diarize`（中文 / 英文内置识别、会议声纹，首次下载 sherpa-onnx 静态库约 120MB）
- `npm run whisper:win` 编译 `mt-whisper`（多语种识别，whisper.cpp 源码，需要 git；只用 CPU）
- Windows 默认主键是右 Ctrl（按住约 0.15 秒开始说话、轻按免手持；右 Ctrl+空格 提问；右 Ctrl+Shift 翻译）。没有右 Ctrl 的键盘在设置里改为 `rshift`（翻译 `rshift+ctrl`，右 Shift+字母照常打大写）或 `ralt`
- 提交前同样跑 `npm run typecheck`、`npm run test`、`npm run build`、`npm run docs:check`（CI 的 macOS 与 Windows 两个 job 都必须通过才能合并）
- `npm run dist` 在 Windows 上打包为 `release/MyTypeless-<版本>-<构建号>-x64.exe`（一键安装到当前用户，不签名）；没有 Windows 电脑时可在 Actions 页面手动运行 `release-windows`（标签留空），从构建产物下载安装包

## 提交流程

1. Fork 本仓库（维护者直接在本仓库开分支），从最新的 `main` 建分支：`feat/…`、`fix/…`、`docs/…`、`ci/…`。
2. 改动尽量小而聚焦，一个 PR 只做一件事。
3. 推送后向 `main` 提 PR，按模板写清楚改了什么、为什么、怎么验证。
4. CI 通过、维护者审阅后以 squash 方式合并。

## 提交 PR 前

```bash
npm run typecheck
npm run test
npm run build
npm run docs:check
npm run native      # 改了 native/*.swift 时
```

- 能脱离 `electron` 的逻辑先写测试（`test/*.test.ts`，Node 原生 test runner）。
- 改了 IPC、设置、表结构、原生助手协议：同步 [docs/contracts/](docs/contracts/README.md)。
- 按[任务收尾](docs/governance/playbooks/task-closeout.md)同步文档；过程记录可选，写在 `docs/_history/agent-runs/`。
- 提交信息用中文或英文均可，一句话说清改了什么、为什么。

## 必须先讨论、不能直接合并的改动

- **隐私**（[D-002](docs/decisions/domains/general.md)）：新增任何数据外发、录音写入磁盘、扩大键盘监听范围、采集屏幕或选区以外的内容。
- **合规**（D-001）：不得引入来自其他产品（包括 Typeless）的代码、提示词、资源、文案或商标。
- **数据兼容**：`settings.json`、加密的 Key、sqlite 表结构只允许向前兼容的增量迁移。
- **识别 / 声纹模型或阈值**：需要附上用公开人工标注数据在本机实测的对比结果（方法见 AGENTS.md 已知陷阱）。

## 欢迎认领：Windows 版

目前只有 macOS 版（[D-006](docs/decisions/domains/release.md)）。Electron 主体（界面、听写流程、润色、会议、历史）可以复用，需要为 Windows 实现的主要是：

| 模块 | macOS 现状 | Windows 需要 |
| --- | --- | --- |
| 全局快捷键 `mt-hotkey` | Swift，CGEventTap | 低级键盘钩子；Windows 键盘的 Fn 通常系统读不到，需要另定默认键 |
| 写入文字 `mt-inject` | Swift，CGEvent / 粘贴 | SendInput / 剪贴板粘贴 |
| 前台应用、选区、光标附近文字 `mt-focus` | Swift，辅助功能 API | UI Automation |
| 繁简转换 `mt-text` | Swift | 开源转换库 |
| Whisper 引擎 `mt-whisper` | whisper.cpp + Metal | whisper.cpp（CPU / Vulkan） |
| sherpa-onnx 助手 `mt-diarize` | C | 同一份 C 代码，换 Windows 预编译库 |
| 打包 / 更新 | DMG + zip，Squirrel.Mac | NSIS 安装包，electron-updater（已完成，D-036） |

原生助手与主进程的协议见 [原生助手契约](docs/contracts/native-helpers.md)。有意做的话请先开 Issue，说明打算从哪部分开始。

## 发布

正式版本由维护者用固定的签名证书，从已合并到 `main` 的提交打包，发布到本仓库的 [Releases](https://github.com/cjx157791216/MyTypeless/releases)（`npm run release`，版本标签打在对应提交上；Windows 安装包由 GitHub Actions 在同一次发布中打包上传，D-036）；PR 里不需要升级版本号。

## 安全问题

请不要在公开 Issue 里报告安全漏洞，见 [SECURITY.md](SECURITY.md)。

## 行为准则

参与本项目即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
