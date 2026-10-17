# native — Swift 原生助手（独立 CLI 进程，原创实现）

## 结构

| 路径 | 职责 |
| --- | --- |
| `hotkey-helper.swift` → `bin/mt-hotkey` | CGEventTap 全局快捷键：只匹配传入的绑定，stdout 输出 JSON 行事件 |
| `inject-helper.swift` → `bin/mt-inject` | 写入：Unicode 键入 / 剪贴板粘贴（完整备份恢复）/ 组合键 / 抓选区 |
| `text-helper.swift` → `bin/mt-text` | 繁简转换（系统 ICU） |
| `bin/mt-whisper` | 内置识别引擎：whisper.cpp 的 whisper-server，由 `scripts/build-whisper.sh` 从源码静态编译（不是本目录的 Swift 源码） |
| `diarize-helper.c` → `bin/mt-diarize` | 会议声纹（D-015）：常驻，按行读命令，从会议临时录音取一段算声音特征；静态链接 sherpa-onnx / ONNX Runtime，由 `scripts/build-diarize.sh` 编译 |
| `focus-helper.swift` → `bin/mt-focus` | 前台应用信息（bundleId、名称、pid），以及按 pid 激活应用 |
| `audiotap-helper.swift` → `bin/mt-audiotap` | 线上会议截取会议软件播放的声音（Core Audio process tap，macOS 14.2+，D-033）：stdout 连续输出 16kHz 单声道 s16le；`--apps` 列应用、`--probe` 开会前完成授权 |
| `bin/` | 编译产物（gitignore），打包时经 `extraResources` 放到 `Resources/bin/` |

参数、输出和退出码以 [原生助手契约](../docs/contracts/native-helpers.md) 为准，改协议时先改契约，再同步 `src/main/native.ts`。

## 可复制范例

- 新增按键名：在 `hotkey-helper.swift` 的 `keyTable` 加映射（kVK 键码），单修饰键还要加 `modifierDeviceMask`。
- 新增 `mt-inject` 子命令：照 `--copy-selection`（参数解析 → 权限检查后的独立函数 `copySelectedText` → 退出码）。
- 剪贴板临时占用：用 `snapshotPasteboard` 备份全部类型，恢复前检查 `changeCount` 是否被他人改过。

## 不变量

- 键盘监听只匹配已注册的快捷键，不记录、不输出其他按键（D-002）。
- 事件回调里必须处理 `tapDisabledByTimeout` / `tapDisabledByUserInput` 并重新启用 tap。
- 合成键盘事件要显式设置 `flags`（用户可能还按着 Option/Cmd）。
- 单修饰键触发不吞 `flagsChanged`，避免修饰键状态卡死。
- 无辅助功能权限一律 `exit(3)`；`mt-hotkey` 在父进程退出后自行退出。
- `mt-audiotap` 的 IOProc 必须直接在音频线程调用（不给 dispatch queue，否则会跳过 IO 周期、声音变短）；音频线程只下混写入预分配缓冲；重采样按聚集设备的实际采样率（tap 报的格式不准，扬声器常是 44.1kHz）。

## 依赖与影响面

- Swift 助手只依赖系统框架（AppKit、ApplicationServices、CoreGraphics、CoreAudio）；`mt-diarize` 静态链接第三方库（许可证见 `build/THIRD_PARTY_NOTICES.md`），产物也只依赖系统库。
- 调用方是 `src/main/native.ts`、`hotkeys.ts`、`inject.ts`、`meeting/app-audio.ts`（`mt-audiotap`）；退出码含义变化会影响降级判断。

## 测试

`npm run native`（`swiftc` 编译 Swift 助手）；`npm run whisper`（编译 `mt-whisper`，需要 cmake，已编译同版本会跳过）；`npm run diarize`（编译 `mt-diarize`，首次下载 sherpa-onnx 预编译包）；冒烟：`native/bin/mt-focus` 应输出 JSON，`echo 會議 | native/bin/mt-text --to hans` 应输出“会议”，`native/bin/mt-audiotap --list` 应输出进程 JSON 数组（截到真实声音需要「系统音频录制」授权，归属启动它的 app；命令行里归属终端，未授权只给静音）。快捷键与写入需要辅助功能权限，只能真机验证。

## 必读

[原生层需求](../docs/requirements/native.md) · [原生助手契约](../docs/contracts/native-helpers.md)
