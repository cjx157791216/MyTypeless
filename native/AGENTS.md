# native — 原生助手（独立 CLI 进程，原创实现；macOS 用 Swift，Windows 用 C++）

## 结构

| 路径 | 职责 |
| --- | --- |
| `hotkey-helper.swift` → `bin/mt-hotkey` | CGEventTap 全局快捷键：只匹配传入的绑定，stdout 输出 JSON 行事件 |
| `inject-helper.swift` → `bin/mt-inject` | 写入：Unicode 键入 / 剪贴板粘贴（完整备份恢复）/ 组合键 / 抓选区 |
| `text-helper.swift` → `bin/mt-text` | 繁简转换（系统 ICU） |
| `bin/mt-whisper` | 内置识别引擎：whisper.cpp 的 whisper-server，由 `scripts/build-whisper.sh` 从源码静态编译（不是本目录的 Swift 源码）；Windows 版由 `scripts/build-whisper-win.cjs` 编译成 `mt-whisper.exe`（只用 CPU） |
| `diarize-helper.c` → `bin/mt-diarize` | 会议声纹（D-015）：常驻，按行读命令，从会议临时录音取一段算声音特征；静态链接 sherpa-onnx / ONNX Runtime，由 `scripts/build-diarize.sh` 编译；Windows 用同一份源码（`_WIN32` 分支），由 `npm run diarize:win` 编译成 `mt-diarize.exe` |
| `focus-helper.swift` → `bin/mt-focus` | 前台应用信息（bundleId、名称、pid）、按 pid 激活应用、读焦点输入框的选中文字（`--selected-text`）与光标前后一段（`--caret-context`） |
| `audiotap-helper.swift` → `bin/mt-audiotap` | 线上会议截取会议软件播放的声音（Core Audio process tap，macOS 14.2+，D-033）：stdout 连续输出 16kHz 单声道 s16le；`--apps` 列应用、`--probe` 开会前完成授权 |
| `win/` → `bin/mt-*.exe` | Windows 版助手（C++ + Win32，GAP-008）：`text-helper.cpp`、`focus-helper.cpp`、`inject-helper.cpp`、`hotkey-helper.cpp`、`audiotap-helper.cpp`，共用 `process-info.h`（exe 路径与文件描述、父进程退出即退出）与 `common.h`（UTF-8 转换、二进制 stdin/stdout、base64、JSON 转义）；`CMakeLists.txt` 由 `npm run native:win` 调用 |
| `bin/` | 编译产物（gitignore），打包时经 `extraResources` 放到 `Resources/bin/` |

参数、输出和退出码以 [原生助手契约](../docs/contracts/native-helpers.md) 为准。改协议时先改契约，再在**同一个 PR** 里同步 Swift 与 `win/` 两份实现、`src/main/native.ts` 和 `test/native-helpers.test.ts`（两个平台跑同一组用例）；只有 Mac 时 C++ 部分靠 CI 的 `check-windows` 编译与测试。

## 可复制范例

- 新增按键名：在 `hotkey-helper.swift` 的 `keyTable` 加映射（kVK 键码），单修饰键还要加 `modifierDeviceMask`；Windows 在 `hotkey-helper.cpp` 的 `NormalKey` / `kModifierKeys` 加虚拟键码，并在 `test/native-win.test.ts` 用 `--replay` 补场景。
- 新增 `mt-inject` 子命令：照 `--copy-selection`（参数解析 → 权限检查后的独立函数 `copySelectedText` → 退出码）。
- 剪贴板临时占用：用 `snapshotPasteboard` 备份全部类型，恢复前检查 `changeCount` 是否被他人改过。Windows 照 `inject-helper.cpp` 的 `SnapshotClipboard` / `RestoreClipboard`（序列号判断），写入时调用 `MarkPrivate` 排除出剪贴板历史。

## 不变量

- 键盘监听只匹配已注册的快捷键，不记录、不输出其他按键（D-002）。
- 事件回调里必须处理 `tapDisabledByTimeout` / `tapDisabledByUserInput` 并重新启用 tap。`mt-hotkey` 的按键处理只写在 `handleEvent` 里（真实 tap 与 `--replay` 共用），不要在回调里另写逻辑。
- 🌐 键可能报为 63 号（`flagsChanged`）或 179 号（`keyDown`/`keyUp`），也可能两者都报（D-043）：新增“按住 Fn 时按了别的键就放弃”一类判断时，先排除 179。
- 合成键盘事件要显式设置 `flags`（用户可能还按着 Option/Cmd）。
- 单修饰键触发不吞 `flagsChanged`，避免修饰键状态卡死。
- 参数先校验（错误一律 `exit(2)`、不发任何按键），再检查权限：无辅助功能权限一律 `exit(3)`；`mt-hotkey` 在父进程退出后自行退出。
- `mt-audiotap` 的 IOProc 必须直接在音频线程调用（不给 dispatch queue，否则会跳过 IO 周期、声音变短）；音频线程只下混写入预分配缓冲；重采样按聚集设备的实际采样率（tap 报的格式不准，扬声器常是 44.1kHz）。
- Windows 剪贴板：备份不了（被别的程序占着）就不能动剪贴板，否则事后“恢复”等于清空用户原来的内容；`SnapshotClipboard` 区分“备份失败”与“原本为空”。
- Electron / Chromium 应用（Claude、VS Code、Slack…）默认不公开辅助功能树：问系统焦点元素返回 -25204，读不到输入框文字。`mt-focus` 的 `focusedElement` 会改问应用自己的焦点并打开 `AXManualAccessibility`；新增读文字的原生功能要复用它，并用 Electron 应用实测。
- Windows 读选区 / 光标上下文：Chromium / Electron 应用要先唤醒辅助功能，且唤醒前已获得焦点的输入框要等光标动一次才可读（听写开始时的选区检查负责唤醒）；WinForms 文本框经系统代理“支持”文本模式却读出空串，要退到 `EM_GETSEL` / `WM_GETTEXT`。
- `mt-audiotap`（macOS）：用户点「允许」录制系统音频后系统会重启所有 MyTypeless 实例，授权必须在开会前用 `--probe` 完成；没授权时只给全零、不报错。
- Windows 版与 macOS 版协议完全一致（同名、带 `.exe`）；stdin/stdout 用二进制模式（换行不被转成 CRLF），文本一律 UTF-8；静态链接运行库，不依赖 VC++ 运行库。

## 依赖与影响面

- Swift 助手只依赖系统框架（AppKit、ApplicationServices、CoreGraphics、CoreAudio）；`mt-diarize` 静态链接第三方库（许可证见 `build/THIRD_PARTY_NOTICES.md`），产物也只依赖系统库。
- 调用方是 `src/main/native.ts`、`hotkeys.ts`、`inject.ts`、`meeting/app-audio.ts`（`mt-audiotap`）；退出码含义变化会影响降级判断。

## 测试

`npm run native`（`swiftc` 编译 Swift 助手）；`npm run whisper`（编译 `mt-whisper`，需要 cmake，已编译同版本会跳过）；`npm run diarize`（编译 `mt-diarize`，首次下载 sherpa-onnx 预编译包）；冒烟：`native/bin/mt-focus` 应输出 JSON，`echo 會議 | native/bin/mt-text --to hans` 应输出“会议”，`native/bin/mt-audiotap --list` 应输出进程 JSON 数组（截到真实声音需要「系统音频录制」授权，归属启动它的 app；命令行里归属终端，未授权只给静音）。两个平台共同的协议与退出码在 `test/native-helpers.test.ts`（`npm run test`，助手未编译时跳过；只测不发按键、不读输入框的路径）；`mt-hotkey` 的按键状态机用 `--replay` 测：macOS 在 `test/native-mac.test.ts`（需先 `npm run native`），Windows 在 `test/native-win.test.ts`（另含 `mt-whisper`、`mt-audiotap` 输出，需先 `npm run native:win`）。快捷键与写入需要辅助功能权限，只能真机验证。Windows 端到端测试只能对自建窗口操作（脚本发按键前核对前台进程与窗口标题），不能用记事本等真实应用（Windows 11 记事本会恢复用户未关闭的标签页）。

## 必读

[原生层需求](../docs/requirements/native.md) · [原生助手契约](../docs/contracts/native-helpers.md)
