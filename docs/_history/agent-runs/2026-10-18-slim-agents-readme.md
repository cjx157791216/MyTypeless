# 2026-10-18 精简根 AGENTS.md、重写 README

## 范围

文档重组，不改代码与规则：根 `AGENTS.md` 的“已知陷阱”按模块拆到各目录 `AGENTS.md`；README（中英）补上 Windows 版并重新整理。

## 改动

- 根 `AGENTS.md`：“已知陷阱”只留跨模块的 6 条（Python distutils、better-sqlite3 ABI、Windows 安装依赖、开发模式权限、隔离实例路径带空格、平台判断），加各模块陷阱的索引；代码地图补新模块说明的链接。约 19.7KB → 11.9KB。
- 新建 `src/main/meeting/AGENTS.md`（分句、聚类、声纹、远场、慢电脑降级、线上会议与改动前必做的回归）、`src/main/whisper/AGENTS.md`（两个识别引擎、Whisper 参数、残留进程、换模型）、`scripts/AGENTS.md`（签名、在线更新、Windows 安装包与依赖安装），各带 `CLAUDE.md`。
- `src/main/AGENTS.md`：会议、内置识别的行与不变量改为指向子目录；接收 VAD 与 `setVisibleOnAllWorkspaces` 两条。
- `native/AGENTS.md`：接收 Electron 辅助功能树、Windows 读选区、`mt-audiotap` 授权与 Windows 端到端测试注意事项。`src/renderer/AGENTS.md`：接收虚拟麦克风与 Windows 浮动条鼠标测试注意事项。
- README.md / README.en.md：双平台说明、快捷键对照、下载文件表、首次使用、平台差异、两个平台的源码构建。

## 验证

- `npm run docs:check` 通过；原有 25 条陷阱逐条核对均有落点。
- `npm run docs:context -- --task meeting` 输出包含新的 `src/main/meeting/AGENTS.md`。

## 遗留

- 无。
