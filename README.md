# MyTypeless

[English](README.en.md) · 中文

macOS 上的 AI 语音听写工具：**按住 `Fn` 说话，松开后润色好的文字写入光标处**。语音识别默认在本机完成，AI 润色用你自己的 API Key（BYOK），历史只存在你的电脑上。

另有**会议模式**：录下线下会议，在本机区分说话人、记住声音，会后生成每人发言摘要与会议纪要。

> MyTypeless 是个人开源项目，与 Typeless 及其开发者没有任何关联。全部代码、提示词、界面文案和图标均为原创。

## 功能

- **听写**：按住 `Fn` 说话、松开写入；轻按 `Fn` 免手持，说完再按一下结束。中英混说、自动标点、去掉“嗯、那个”和说错又改口的部分。
- **改写选中文字**：先选中，再按 `Fn` 说“更简短”“改成英文”……，结果替换选区。
- **语音提问**（`Fn` + `空格`）与**翻译**（`Fn` + `Shift`）。
- **个人词典**：手动添加，也会从你改正的词和常用专有名词中自动学习。
- **会议模式**：按句转写、本地区分说话人、改名并记住声音、会后纪要（可编辑、导出 Markdown）。
- **在线更新**：发现新版本时提示，确认后在应用内下载，重启完成更新。

## 安装

1. 从 [Releases](https://github.com/cjx157791216/MyTypeless/releases/latest) 下载最新的 `MyTypeless-<版本>-<构建号>-arm64.dmg`（仅支持 Apple Silicon）。
2. 打开 DMG，把 MyTypeless 拖进「应用程序」。安装包未经 Apple 公证，首次打开请**右键 → 打开**。
3. 按主窗口首页的引导：
   - 下载识别模型（中文、英文推荐「中文高精度」，约 1.3GB，只需一次；之后识别完全离线）。
   - 授予「辅助功能」与「麦克风」权限。
   - 把「系统设置 → 键盘 → 按下 🌐 键时」改为「无操作」，否则松开 Fn 会弹出表情面板。
   - 想要 AI 润色 / 翻译 / 改写 / 提问：在设置里填一个 OpenAI 兼容的 Base URL 和 API Key（不填则只做本地清理）。

## 隐私

- 键盘监听只匹配你设置的快捷键，不记录按键。
- 录音识别完即丢弃，不写入磁盘；会议录音只在会议期间临时保存，整理完删除。
- 不采集屏幕文字和网址；历史、词典、声纹只存在本机；API Key 由系统钥匙串加密保存。
- 没有任何中心服务器：云端能力只走你自己配置的服务；检查更新只读取公开的版本说明，不发送你的数据（可关闭）。

完整规则见 [D-002 隐私红线](docs/decisions/domains/general.md)。

## 从源码构建

需要 Apple Silicon Mac、Xcode Command Line Tools、Node.js 24（或 22.18 以上）、`brew install cmake`。

```bash
npm install          # postinstall 按 Electron ABI 重编译 better-sqlite3
npm run native       # 编译 Swift 原生助手
npm run whisper      # 编译 Whisper 识别引擎（whisper.cpp）
npm run diarize      # 编译会议声纹 / 中文识别助手（首次下载 sherpa-onnx 预编译库，约 230MB）
npm run dev          # 开发运行（shell 里有 ELECTRON_RUN_AS_NODE=1 时先 unset）
```

开发模式下辅助功能、麦克风权限属于你运行命令的终端应用（终端、iTerm、VS Code…），要给它授权。

```bash
npm run typecheck && npm run test && npm run build && npm run docs:check   # 提交前的检查
npm run dist         # 打包到 release/（DMG + zip）
```

自己打的包没有发布者的签名证书，第一次运行会生成本机证书（`.vendor/signing/`）；只能手动安装，不能从官方版本在线更新过去。

## 参与贡献

欢迎提 Issue 和 PR，尤其欢迎 **Windows 版**的移植。开始之前请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

项目文档面向人和 AI 编码工具共同维护：

- [AGENTS.md](AGENTS.md)：开发规则、代码地图、常用命令、已知陷阱（`CLAUDE.md` 导入它）
- [docs/](docs/AGENTS.md)：需求、决策、接口契约、验收场景、缺口账本、术语表；当前状态见 [docs/STATUS.md](docs/STATUS.md)

## 架构

```
src/main/          主进程：会话状态机、识别与润色、热键、写入、设置、历史、在线更新
src/main/meeting/  会议模式：分句、说话人聚类、声纹、纪要、存储
src/preload/       contextBridge 白名单 API
src/renderer/      浮动胶囊（录音采集）、主窗口、回答浮卡
native/            Swift 原生助手（快捷键、写入、焦点与选区、繁简转换）+ C 写的 sherpa-onnx 助手
scripts/           原生编译、打包、签名、发布、文档检查
docs/              需求、决策、契约、验收
```

## 许可证

[MIT](LICENSE)。第三方组件（whisper.cpp、sherpa-onnx、ONNX Runtime、electron-updater 等）与应用内下载的模型的许可证见 [build/THIRD_PARTY_NOTICES.md](build/THIRD_PARTY_NOTICES.md)。
