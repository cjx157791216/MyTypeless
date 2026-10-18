# MyTypeless

[English](README.en.md) · 中文

macOS 与 Windows 上的 AI 语音听写工具：**按住快捷键说话，松开后润色好的文字写入光标处**。语音识别默认在本机完成，AI 润色用你自己的 API Key（BYOK），历史只存在你的电脑上。

另有**会议模式**：录下线下或线上会议，在本机区分说话人、记住声音，会后生成每人发言摘要与会议纪要。

> MyTypeless 是个人开源项目，与 Typeless 及其开发者没有任何关联。全部代码、提示词、界面文案和图标均为原创。

## 功能

- **听写**：按住主键说话、松开写入；轻按主键免手持，说完再按一下结束。中英混说、自动标点，去掉“嗯、那个”和说错又改口的部分。
- **改写选中文字**：先选中，再按主键说“更简短”“改成英文”……，结果替换选区。
- **翻译**：用母语说，写入设置中指定的目标语言。
- **语音提问**：说出问题，回答显示在浮卡里，可一键插入光标处。
- **个人词典**：手动添加，也会从你改正的词和常用专有名词中自动学习。
- **会议模式**：按句实时转写、本地区分说话人、改名并记住声音，会后生成纪要（可编辑、导出 Markdown）。线上会议可同时截取会议软件的声音，现场与线上分开区分说话人，并去掉外放回声。
- **本地识别**：中文、英文默认 FireRedASR2，其他语言用 Whisper；下载一次模型后完全离线。
- **在线更新**：发现新版本时提示，确认后在应用内下载，重启完成更新。

### 默认快捷键

| 操作 | macOS | Windows |
| --- | --- | --- |
| 听写（按住说话 / 轻按免手持） | `Fn` | 右 `Ctrl` |
| 改写 | 选中文字后按主键 | 选中文字后按主键 |
| 翻译 | `Fn` + `Shift` | 右 `Ctrl` + `Shift` |
| 语音提问 | `Fn` + `空格` | 右 `Ctrl` + `空格` |

快捷键可在设置里修改。Windows 键盘的 Fn 系统读不到，所以主键默认是右 Ctrl；没有右 Ctrl 的键盘可以改为右 Shift 或右 Alt。

## 下载安装

从 [Releases](https://github.com/cjx157791216/MyTypeless/releases/latest) 下载对应平台的最新版本：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `MyTypeless-<版本>-<构建号>-arm64.dmg` | 打开 DMG，把 MyTypeless 拖进「应用程序」。未经 Apple 公证，首次打开请**右键 → 打开** |
| Windows 10/11（x64） | `MyTypeless-<版本>-<构建号>-win-x64.exe` | 双击安装到当前用户，不需要管理员权限。没有代码签名，SmartScreen 提示“Windows 已保护你的电脑”时点「更多信息 → 仍要运行」 |
| Windows 解压即用版 | `MyTypeless-<版本>-<构建号>-win-x64.zip` | 解压后运行 `MyTypeless.exe`，数据与安装版共用；有新版本时只提示，需手动下载新的 zip 覆盖 |

### 首次使用

按主窗口首页的引导完成：

1. **下载识别模型**：中文、英文推荐「中文高精度」（约 1.3GB，只需一次）。
2. **授予权限**：
   - macOS：「辅助功能」与「麦克风」。并把「系统设置 → 键盘 → 按下 🌐 键时」改为「无操作」，否则松开 Fn 会弹出表情面板。
   - Windows：在「设置 → 隐私和安全性 → 麦克风」里允许桌面应用访问麦克风。
3. **（可选）配置 AI 润色**：在设置里填一个 OpenAI 兼容的 Base URL 和 API Key，才能使用润色、翻译、改写和提问；不填时只做本地清理。

### 平台差异

| | macOS | Windows |
| --- | --- | --- |
| 系统要求 | Apple Silicon | Windows 10/11 x64 |
| Whisper 识别（中文、英文以外的语言） | 使用 GPU | 只用 CPU，较慢 |
| 线上会议截取会议软件的声音 | macOS 14.2 及以上 | Windows 11 |

## 隐私

- 键盘监听只匹配你设置的快捷键，不记录按键。
- 录音识别完即丢弃，不写入磁盘；会议录音只在会议期间临时保存，整理完删除。
- 不采集屏幕文字和网址；历史、词典、声纹只存在本机；API Key 用系统的加密存储保存（macOS 钥匙串，Windows 数据保护 API）。
- 两个默认关闭的可选功能：
  - 「参考光标前的文字」：开启后，听写时把光标前最多 300 字随润色请求发给你配置的模型（不保存，密码框不读）。
  - 「学习我的修改习惯」：开启后，在本机保存你改过的听写结果（最多 50 条，可删除），润色时挑几条发给模型参考。
- 没有任何中心服务器：云端能力只走你自己配置的服务；检查更新只读取公开的版本说明，不发送你的数据（可在设置里关闭）。

完整规则见 [D-002 隐私红线](docs/decisions/domains/general.md)。

## 从源码构建

### macOS

需要 Apple Silicon Mac、Xcode Command Line Tools、Node.js 24（或 22.18 以上）、`brew install cmake`。

```bash
npm install          # postinstall 按 Electron ABI 重编译 better-sqlite3
npm run native       # 编译 Swift 原生助手
npm run whisper      # 编译 Whisper 识别引擎（whisper.cpp）
npm run diarize      # 编译会议声纹 / 中文识别助手（首次下载 sherpa-onnx 预编译库，约 230MB）
npm run dev          # 开发运行（shell 里有 ELECTRON_RUN_AS_NODE=1 时先 unset）
```

开发模式下辅助功能、麦克风权限属于你运行命令的终端应用（终端、iTerm、VS Code…），要给它授权。

### Windows

需要 Windows 10/11 x64、Node.js 24、git、Visual Studio 2022 生成工具（“使用 C++ 的桌面开发”）。

```bash
npm run setup:win    # 代替 npm install（直接 npm install 在 Windows 上会失败，原因见 CONTRIBUTING.md）
npm run native:win   # 编译 C++ 原生助手
npm run diarize:win  # 编译会议声纹 / 中文识别助手（首次下载 sherpa-onnx 静态库，约 120MB）
npm run whisper:win  # 编译 Whisper 识别引擎（只用 CPU）
npm run dev
```

### 检查与打包

```bash
npm run typecheck && npm run test && npm run build && npm run docs:check   # 提交前的检查
npm run dist         # 打包到 release/：macOS 为 DMG + zip，Windows 为安装包 + zip
```

自己打的包没有发布者的签名证书（macOS 第一次打包会在 `.vendor/signing/` 生成本机证书），只能手动安装，不能从官方版本在线更新过去。

## 项目结构

```
src/main/          主进程：会话状态机、识别与润色、热键、写入、设置、历史、在线更新
src/main/meeting/  会议模式：分句、说话人聚类、声纹、纪要、存储
src/main/whisper/  内置本地识别：引擎管理、模型目录与下载
src/preload/       contextBridge 白名单 API
src/renderer/      浮动胶囊（录音采集）、主窗口、回答浮卡
native/            原生助手：macOS 为 Swift，Windows 为 C++（native/win/）；会议声纹 / 中文识别助手为 C（两平台共用）
scripts/           原生编译、打包、签名、发布、文档检查
docs/              需求、决策、契约、验收
```

## 参与贡献

欢迎提 Issue 和 PR，macOS 与 Windows 版都欢迎。开始之前请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

项目文档面向人和 AI 编码工具共同维护：

- [AGENTS.md](AGENTS.md)：开发规则、代码地图、常用命令、已知陷阱（`CLAUDE.md` 导入它；各目录另有自己的 `AGENTS.md`）
- [docs/](docs/AGENTS.md)：需求、决策、接口契约、验收场景、缺口账本、术语表；当前状态见 [docs/STATUS.md](docs/STATUS.md)

## 许可证

[MIT](LICENSE)。第三方组件（whisper.cpp、sherpa-onnx、ONNX Runtime、electron-updater 等）与应用内下载的模型的许可证见 [build/THIRD_PARTY_NOTICES.md](build/THIRD_PARTY_NOTICES.md)。
