# 打包发布需求

> **状态：confirmed（2026-10-14，项目负责人）**

## 范围

包含：构建、原生助手编译、打包（DMG/zip）、签名与权限声明。

## 规则

1. `npm run dist`（`scripts/dist.cjs`）依次编译代码与原生助手、准备签名证书并打包，产出 arm64 的 DMG 与 zip（来源：[README](../../README.md)，D-006）。
2. 打包后由 `scripts/sign-app.cjs` 对整个应用签名（标识 `com.mytypeless.desktop`）：有本地自签名证书时用证书签名，重新打包后辅助功能/麦克风授权仍有效；否则 adhoc。供本机与内部测试使用；对外分发必须 Developer ID 签名并公证（来源：[README](../../README.md)；属于人工门禁）。
3. 原生助手随包安装在 `MyTypeless.app/Contents/Resources/bin/`（来源：[README](../../README.md)），包括内置识别引擎 `mt-whisper`（`npm run whisper` 从 whisper.cpp 源码静态编译，需要 cmake）；语音模型不进安装包（D-009）。
4. entitlements 声明麦克风、Apple Events、JIT（来源：[README](../../README.md)）。
5. 未公证的应用首次打开需右键 → 打开（来源：[README](../../README.md)）。
6. 版本号取 `package.json` 的 `version`，发布新版本时手动升级；每次打包生成构建号（打包时间 `YYYYMMDD.HHmm`），写入安装包文件名 `MyTypeless-<版本>-<构建号>-arm64.dmg/.zip`、应用的 CFBundleVersion 与应用内版本显示；git 短哈希（有未提交改动时带 `-dirty`）显示在应用的“关于”里。

7. 在线更新（D-028、D-032）：已安装的应用读取发布地址 `https://github.com/cjx157791216/MyTypeless/releases/latest/download/latest-mac.yml`（0.2.1 读取旧发布仓库 `cjx157791216/mytypeless-releases` 的同名地址）（最新正式 Release；`src/main/update-info.ts` 的 `DEFAULT_UPDATE_URL`），版本号更大即为新版本；发现后提示，用户确认后在应用内下载 zip（校验 sha512），下载完提示「重启并更新」；录音、会议或纪要整理中拒绝重启；开发运行不检查。
8. 发布：`npm run release -- --notes "更新内容" --yes`（需要环境变量 `GH_TOKEN`）在代码仓库建 `v<版本号>` 草稿 Release（标签打在构建所用的提交上），上传当前版本最新构建的 zip、DMG 与版本说明，最后转为正式发布，再在旧发布仓库同步一个只含版本说明的 Release（重跑时删掉同版本的旧草稿；同版本已正式发布则拒绝）；打包时有未提交改动、或该提交未合并到 GitHub `main` 时拒绝；版本号不比已发布的大、应用不是证书签名、`release/mac-arm64` 不是这次构建时拒绝。不带 `--yes` 只打印计划（对外分发，人工门禁）。

## 必测不变量

- 打包后的应用能加载 better-sqlite3（按 Electron ABI 编译）。
- 打包后的应用能找到全部原生助手（`mt-hotkey`、`mt-inject`、`mt-focus`、`mt-text`、`mt-whisper`）。
- 新旧版本必须用同一证书签名，否则 Squirrel 拒绝自动安装（`.vendor/signing/` 不能删）。
- `codesign -dv` 显示 `Identifier=com.mytypeless.desktop`，`codesign --verify --deep --strict` 通过；`codesign -dr -` 的指定要求含 `certificate leaf`（证书签名时）。

## 待确认

见 [open-questions.md](../open-questions.md) 中与本领域相关的 B 项。
