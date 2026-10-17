# 2026-10-17 Windows 助手：mt-whisper（多语种识别）

## 范围

GAP-008：Windows 版内置 Whisper 引擎（中文、英文以外的多语种识别），取代上一步“Windows 暂不支持 Whisper”的过渡做法（撤销其代码，过程记录保留）。只用 CPU；Vulkan 需要另装 SDK，暂不做。

## 改动

- `scripts/build-whisper-win.cjs` + `npm run whisper:win`：与 `build-whisper.sh` 同一版本（v1.9.5）的 whisper.cpp 源码，CMake + MSVC，静态链接（含运行库），`GGML_NATIVE=OFF` + AVX / AVX2 / FMA / F16C（2013 年以后的 x64 处理器都有）；同版本已编译则跳过；引擎正在运行时挪开旧文件再放新的。
- `scripts/win-cmake.cjs`：两个 Windows 编译脚本共用的查找 CMake。
- `whisper/engine.ts`：识别线程 Windows 按物理核数、最多 8 个（macOS 计算在 GPU 上，仍为最多 4 个）；`killOrphanEngines` 的 Windows 实现——没有“被 launchd 收养”，后台用 PowerShell 查本应用 `mt-whisper.exe` 中父进程已不存在的并结束（不拖慢启动；父进程号被复用时只会漏清一次，不会误杀）。
- 撤销“Whisper 暂不支持”：`engineUnsupported`、`ModelInfo.unsupported`、`LOCAL_ENGINE_UNSUPPORTED` 及界面上的不支持提示。
- CI `check-windows`：编译 `mt-whisper`（缓存源码、构建目录与产物）；`test/native-win.test.ts` 用 whisper.cpp 自带的测试模型验证引擎能加载并就绪。

## 验证

- 编译通过，产物 2.8MB；用 whisper.cpp 自带测试模型按主进程参数启动：`/health` 就绪，`/inference` 返回 200 + JSON；结束后无残留进程。
- `npm run test` 103 通过 / 0 失败；typecheck、build、docs:check 通过。

## 遗留

- 真实模型（large-v3-turbo q5_0，574MB）的识别速度与准确度待真机验收（本机网络慢，未下载）；CPU 识别会比 macOS 的 Metal 慢。
- Vulkan（显卡）加速未做。
