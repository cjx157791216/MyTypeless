# 2026-10-17 Windows 版审查建议（Issue #16）

## 范围

维护者合并 #7～#13 前做的隐私 / 安全审查（D-002，没有阻塞问题）提出的 8 处只影响 Windows 版的改进，一个 PR 一起改。第 8 条（下载校验）macOS 的 `build-diarize.sh` 一并补上。

## 改动

1. **剪贴板可能被清空**（`inject-helper.cpp`）：`SnapshotClipboard` 区分“备份失败”（剪贴板被别的程序一直占着）与“原本为空”。备份失败时 `--paste` 不粘贴、退出码 4（主进程按写入失败处理：结果放进剪贴板并提示，D-008），`--copy-selection` 不复制、退出码 5——不再出现事后“恢复”一个空备份、把用户剪贴板清空。
2. **改写抓选区进入剪贴板历史**（`inject.ts`）：Windows 上 `captureSelectedText` 先用 `mt-focus --selected-text`（UI Automation，不碰剪贴板），读不到再模拟 Ctrl+C（那一份会进 Win+V 历史 / 云剪贴板）。macOS 不变。
3. **孤儿键盘钩子**（`hotkey-helper.cpp`）：stdin 是管道时，读到管道关闭（主进程退出或崩溃）即退出，不依赖父进程号；原有的监视父进程保留。
4. **JSON 边界**：字符串结尾的反斜杠、不足 4 位或不是十六进制的 `\u` 判为配置错误，不越过字符串结尾读取。
5. **钩子回调里同步写管道**：事件交给写入线程输出（队列 + 条件变量），钩子回调立即返回；管道写失败（主进程不在）即退出。安装钩子前与 `--replay` 仍直接写。
6. **密码框后备读取**（`focus-helper.cpp`）：UI Automation 认出密码框时记下，`UiaThread` 不再走 `ReadEditControl`。
7. **`CommandLineToArgvW` 判空**（`diarize-helper.c`，只在 `_WIN32` 分支）：失败或内存不足时退出码 2；顺带 `LocalFree` 掉宽字符参数。
8. **下载校验**：`build-native-win.cjs` 校验 sherpa-onnx Windows 静态库包与 `c-api.h` 的 SHA256；`build-diarize.sh` 校验 macOS 预编译包。哈希取自 GitHub Release 资源的官方摘要（`c-api.h` 为该 tag 源码），与本机此前下载的文件逐一核对一致；不符时删除下载内容并中止。

## 验证

- 剪贴板被占住（另一进程用窗口句柄 `OpenClipboard` 3 秒；`OpenClipboard(NULL)` 实测挡不住别的进程，不能用来模拟）：`--paste` 退出码 4、没有发出 Ctrl+V、剪贴板原内容还在；`--copy-selection` 退出码 5、剪贴板不变；剪贴板空闲时照常粘贴并恢复。7 项全部通过（自建测试窗口，发按键前核对前台）。
- 单测新增：`mt-hotkey` stdin 关闭后约 0.13 秒退出；不完整转义退出码 2。
- 读选区端到端 23 项全部通过（密码框仍读不到）。
- `npm run test` 107 通过 / 0 失败；typecheck、build、docs:check 通过；Windows 助手零警告编译。

## 遗留

- 第 2 条在 Notepad++ / VS Code 编辑器里仍会退回 Ctrl+C（UI Automation 读不到），那一份照旧进入剪贴板历史。
