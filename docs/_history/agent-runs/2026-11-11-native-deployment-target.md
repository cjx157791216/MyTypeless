# 2026-11-11 修复原生助手老系统加载即崩（issue #59）+ 应用内官方下载链接

## 范围

GAP-031。issue #59：macOS 15.7.7 用户按 Fn 无反应，`mt-hotkey` 启动即崩。原因：`scripts/build-native.sh` 的 `swiftc` 没指定 `-target`，部署目标跟随编译机 SDK（27.0），产物依赖 macOS 26+ 才有的 `libswift_DarwinFoundation2.dylib`，老系统 dyld 加载失败（EXC_BREAKPOINT）。同一 PR 顺带在主窗口「设置 → 关于」加官方 GitHub Releases 下载链接（用户要求）。刻意没做：不引入 Swift 运行时静态链接等更大改动；不改 Windows（C++/MSVC 不受影响）。

## 改动

- `scripts/build-native.sh`：五个 Swift 助手显式指定部署目标——`mt-hotkey` / `mt-inject` / `mt-focus` / `mt-text` 用 13.0（与 `mt-whisper` / `mt-diarize` 一致），`mt-audiotap` 用 14.2（其 API 只在 14.2+ 可用且调用方 `appAudioSupported()` 有版本门槛；13.0 编不过，清理路径用了 14.2 API）。
- `electron-builder.yml`：`mac.minimumSystemVersion: 13.0`，声明与实际一致（原来声称 11.0）；`package.json` 版本升 0.3.10。
- 官方下载链接：新增 IPC `mt:update-open-releases`（契约 → types → preload → api → handler），`update-info.ts` 加 `releasesLatestUrl()`，设置 → 关于 卡片加「官方下载」行，点击经 `shell.openExternal` 打开 GitHub Releases（`hub/main.ts` 拦 click/auxclick，窗口内导航被禁）。
- 文档：`docs/contracts/ipc.md`、`scripts/AGENTS.md`（部署目标陷阱）、`docs/implementation/gap-ledger.md`（GAP-031）、`docs/STATUS.md` 原生层行、README 系统要求加 macOS 13+。

## 验证

- 修复前证据：`otool -l` 旧 `mt-hotkey` minos 27.0、依赖 libswift_DarwinFoundation2；`mt-whisper` / `mt-diarize` 为 13.0（只有 Swift 助手漏了）。
- `npm run native` 编译通过；五个助手 minos 13.0 / 14.2，`otool -L` 无 DarwinFoundation 依赖；`mt-focus` 输出 JSON、`mt-text` 繁转简冒烟通过。
- `typecheck`、`test` 172 过 0 挂（含 `test/update.test.ts` 新增 `releasesLatestUrl` 断言）、`build`、`docs:check` 通过。
- `npm run dist` 产出 `MyTypeless-0.3.10-20261111.2305-arm64.dmg`；解包 zip 验证包内助手 minos 正确、Info.plist `LSMinimumSystemVersion = 13`。

## 遗留

- 老 macOS（15 及以下）真机验证：本机 SDK 27 无法复现，等用户升级反馈（GAP-031 保持 DONE_PENDING_REVIEW）。
- 未发布：`npm run release` 属人工门禁；issue #59 的回复在合并后由本会话完成。
