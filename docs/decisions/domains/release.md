# 决策登记 · 打包发布

状态：`active`。本文件是[决策索引](../decision-register.md)中“打包发布”领域决策的完整原文；编号全局唯一、只追加。新增决策时同时在索引追加一行。

| ID | 结论 |
| --- | --- |
| D-006 | **仅 macOS 先行。** 首个平台为 macOS（arm64）；Windows/Linux 在架构上预留，后续移植。确认：项目负责人，2026-10-14（来源：项目初始方案） |
| D-028 | **在线更新：发现新版本先提示，用户确认后在应用内下载，下载完提示重启更新。** 发布地址为不用登录即可读取的公开地址（见 D-029），存放版本说明 `latest-mac.yml` 与各版本的 zip / DMG。应用启动 1 分钟后与之后每 6 小时检查一次（设置 → 关于「自动检查更新」，默认开，可关；也可随时手动检查）；自动检查只读取版本说明，不发送任何用户数据，失败时不打扰。发现新版本时系统通知一次（每个版本一次），托盘、侧栏、关于里显示；下载、重启都需用户点击；录音、会议或纪要整理中拒绝重启；下载完没重启则下次退出时安装。自动安装由 Squirrel.Mac 替换应用，要求新版本与当前应用用同一证书签名（本机自签名证书 `.vendor/signing/`），失败时提示下载 DMG 手动安装。发布（上传安装包）由 `npm run release` 完成、需人工确认，版本号必须比已发布的大。这是可选的检查，不是使用依赖，不违反 D-003。确认：项目负责人（选择“发现新版本后提示，确认下载时使用内置下载，完成后提示重启更新”），2026-10-17 |
| D-029 | **在线更新的发布地址改为 GitHub 公开仓库 `cjx157791216/mytypeless-releases`（修订 D-028 的发布地址）。** 仓库只放 Releases（每个版本一个 `v<版本号>` Release，含 zip、DMG 与版本说明 `latest-mac.yml`），应用读取 `https://github.com/cjx157791216/mytypeless-releases/releases/latest/download/latest-mac.yml`（最新正式 Release），不用登录。发布由 `npm run release` 用 GitHub 令牌（只授权该仓库 Contents 读写）先建草稿、传完全部文件再转为正式发布。其余规则同 D-028。国内访问 GitHub 下载可能较慢；不经第三方加速镜像（会新增数据外发对象，需另行确认）。确认：项目负责人（“换成 github 吧”，选择“新建公开仓库 mytypeless-releases”，账号 cjx157791216），2026-10-17 |
| D-032 | **版本发布到代码仓库自己的 Releases（修订 D-029）。** 在线更新地址改为 `https://github.com/cjx157791216/MyTypeless/releases/latest/download`；每个版本一个 `v<版本号>` Release，标签打在这次构建的提交上；只能发布打包时没有未提交改动、且已合并到 GitHub `main` 的提交（`npm run dist` 写 `release/build-info.json`，`npm run release` 核对）。旧发布仓库 `cjx157791216/mytypeless-releases` 保留：0.2.1 从那里检查更新，所以每次发布在旧仓库同步一个只含版本说明的 Release（安装包地址指向代码仓库），旧版本更新一次后即改读新地址。确认：项目负责人（“releases 也可以在这个 git 项目中发版了”），2026-10-17 |
