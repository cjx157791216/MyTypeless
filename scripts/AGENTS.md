# scripts — 编译原生助手、打包、签名、发布与评测脚本

## 结构

| 路径 | 职责 |
| --- | --- |
| `build-native.sh` / `build-native-win.cjs` | 编译原生助手：Swift → `native/bin/mt-*`；Windows C++（CMake + MSVC）→ `mt-*.exe`，`--diarize` 另编 `mt-diarize.exe`（首次下载 sherpa-onnx 静态库） |
| `build-whisper.sh` / `build-whisper-win.cjs` | 从 whisper.cpp 源码静态编译 `mt-whisper`（两边同一版本；同版本已编译则跳过） |
| `build-diarize.sh` | 编译 `mt-diarize`（`native/diarize-helper.c` + sherpa-onnx 预编译静态库，下载到 `.vendor/`） |
| `win-cmake.cjs` | Windows 编译脚本共用：找 CMake（PATH 或 VS 2022 生成工具自带） |
| `setup-win.cjs` | Windows 开发环境安装依赖（`npm run setup:win`，代替 `npm install`） |
| `dist.cjs` | 打包（`npm run dist`）：生成构建号 → 编译代码与原生助手 → 准备签名证书 → electron-builder |
| `sign-app.cjs` | electron-builder `afterPack` 钩子：对整个 .app 签名 |
| `setup-signing.sh` | 本地自签名证书（存于 `.vendor/signing/`，`predist` 自动生成） |
| `publish.cjs` / `publish-win.cjs` | 发布到 GitHub Release（`npm run release`，D-028、D-032）/ Actions 里上传 Windows 包到草稿（D-036） |
| `gen-icon.py` / `gen-tray-icon.py` | 生成应用图标 / 托盘模板图 |
| `gen-speaker-fixture.cjs` | 生成说话人回归数据 `test/fixtures/speakers.json`（换声纹模型后重跑，D-026） |
| `echo-sim.ts` / `speaker-eval.ts` / `polish-eval.ts` | 外放回声门槛标定（D-033）/ 说话人区分与声纹认人评测（D-042）/ 听写润色提示词评测 |
| `doc-kit/` | 文档脚本：`context.mjs` 任务路由、`check.mjs` 文档校验 |

## 不变量与陷阱

- 签名：`electron-builder.yml` 的 `identity: null` 让 electron-builder 完全跳过签名，由 `sign-app.cjs` 补签：有本地证书就用证书签名（重新打包后系统授权仍有效），没有才退回 adhoc（每次打包都要重新授权）。不要删 `.vendor/signing/`，删了证书会变、所有授权失效。从 adhoc 版本换到证书签名版本时，旧授权记录无效但开关显示为开：主窗口「重置授权」按钮会清除本应用的旧记录。
- 在线更新（D-028）按**版本号**判断新旧，不看构建号：发布前必须升级 `package.json` 的 `version`（`npm run release` 会拒绝不更大的版本）。自动安装要求新旧版本同一证书签名；应用不在「应用程序」文件夹（如直接从 DMG 运行）时 Squirrel 无法替换。开发运行不检查更新；测试用打包版 + `MT_UPDATE_URL=http://127.0.0.1:<端口>/latest` 指向本机临时服务器。
- Windows 安装包（D-036）：electron-builder 写 exe 图标要用的 winCodeSign 工具包里有 macOS 符号链接，没开开发者模式的普通用户解压失败、打包中止——`dist.cjs` 的 `prepareWinCodeSign` 预先解压（跳过 darwin 目录）；Windows 不传 `buildVersion`（文件版本每段最大 65535，放不下 YYYYMMDD 构建号）。文件名带操作系统（`-win-x64`），改名时同步 `publish.cjs` 的解析与 `release-windows.yml`。
- 安装版与开发版共用 `%APPDATA%\MyTypeless` 和单实例锁：开发版开着时安装版（包括更新后自动重新打开的那次）一启动就把窗口交给开发版并退出，测安装版先关开发版或用 `--user-data-dir`。
- `workflow_dispatch` 的工作流必须在默认分支上才能被触发：改 `release-windows.yml` 合并前无法从 `npm run release` 触发。
- Windows 上不能直接 `npm install`：better-sqlite3 没有 Node 24 的 Windows 预编译包（现场编译要 VS 的 ClangCL 组件），Electron 33 的安装脚本在 Node 24 下只解压出第一个文件却报告成功；`setup-win.cjs` 跳过安装脚本、按 Electron ABI 下载预编译包、解压不完整时用系统 tar。CI 的 Windows job 用 `npm ci --ignore-scripts` 即可。
- 换 sherpa-onnx / whisper.cpp 版本：两个平台的脚本一起改（版本与 SHA256），升级 whisper.cpp 还要更新 A-007 并回归 `mt-whisper` 的 `/health` 与 `/inference`。

## 人工门禁

`npm run release -- --yes`（上传新版本）、Developer ID 签名与公证必须先经人工确认（见根 `AGENTS.md`）。

## 测试

`npm run test`（`test/update.test.ts`：发布脚本的文件名解析与版本说明格式）；`npm run native` / `npm run native:win` 编译通过；`npm run docs:check`。

## 必读

[打包发布需求](../docs/requirements/release.md) · [打包发布决策](../docs/decisions/domains/release.md)
