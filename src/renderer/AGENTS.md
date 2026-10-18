# src/renderer — 三个渲染窗口（原生 TS + CSS，无框架）

## 结构

| 路径 | 职责 |
| --- | --- |
| `floating-bar/` | 悬浮胶囊（D-010）：唯一负责麦克风采集（getUserMedia → AudioWorklet → 16k Int16 分片 IPC）、波形、静音自动停止、状态展示；会议录音也经它采集（`meetingCapture`），听写空闲时胶囊显示会议状态 |
| `hub/` | 主窗口（D-017）：`main.ts` 侧栏与 hash 路由；`home.ts` 首页；`history.ts`；`dict.ts`；`meeting.ts` 会议列表/详情/纪要；`settings.ts` 设置、模型、权限、声纹；`update.ts` 在线更新（关于里的状态与按钮、侧栏入口）；`util.ts` 公共工具 |
| `answer-card/` | 语音提问的回答浮卡：思考中/回答/错误、复制、插入到光标 |

每个窗口是 `index.html` + `main.ts` + `style.css`，入口在 `electron.vite.config.ts` 的 `renderer.build.rollupOptions.input` 注册。

## 可复制范例

- 订阅主进程状态：`floating-bar/main.ts` 的 `applyState`（`api.session.onStateChanged`）。
- 设置项读写：`hub/settings.ts` 的 `loadSettingsIntoUi` 与 `btn-save` 处理（`api.settings.get/set`）；即时保存的开关加 `data-autosave="字段名"`。
- 新增主窗口页面：`index.html` 加 `<section class="page" id="page-xxx">` 与侧栏按钮 `data-page`，在 `hub/main.ts` 的 `PAGES` 与 `route` 里注册加载函数。
- 列表渲染（防 XSS）：`hub/history.ts` 的 `renderRecord`，用户文本一律 `textContent` 或 `escapeHtml`；纪要 Markdown 用 `src/shared/markdown.ts`（先转义）。

## 不变量

- 渲染端只能通过 `window.mytypeless`（preload 白名单）访问主进程，不开 `nodeIntegration`。
- 浮动条窗口不抢用户应用的焦点：macOS `focusable: false`；Windows 上 `focusable: false` 会让按钮点不动，改为可聚焦 + `mt-focus --no-activate` 的“点击不激活”样式，点击仍激活一次时再把前台还给鼠标进入胶囊前的应用（`src/main/index.ts` 的 `createFloatingBar`）；它在隐藏时也要采集（`backgroundThrottling: false`）。
- 浮动条窗口比胶囊大且默认忽略鼠标（点击穿透）；只有鼠标进入胶囊或提示时才通过 `setBarInteractive` 接收点击。
- 胶囊各状态由 `.pill` 的 `state-*` 与 `hands-free` 类驱动，样式里不要写死文案。
- 浮动条 CSP 必须保留 `script-src 'self' blob:`（AudioWorklet 从 blob URL 加载）。
- 收到 `captureFlush` 后必须冲刷 worklet 剩余音频再调用 `audioFinal`。
- 麦克风：设置指定优先；“自动”跳过虚拟输入设备（优先内置麦克风）；开麦 0.6 秒内全是纯零则自动换到下一个真实麦克风并提示；设备插拔后重新选择（`floating-bar/main.ts` 的 `pickDeviceId` / `switchFromSilentDevice`；系统默认输入可能是只出纯静音的虚拟设备，如变声器）。
- 会话结束后按设置立即释放或保持就绪 60 秒（D-011）；AudioContext 与 worklet 模块可以常驻。
- 用户文本不得直接拼进 `innerHTML`。
- 快捷键名、系统设置路径按 `api.platform` 显示（`src/shared/platform.ts`）；只在 macOS 有意义的元素（辅助功能授权等）加 `mac-only` 类，只在其他平台显示的加 `non-mac`；页面里写死的主键名放进 `.main-key`（非 macOS 由 `renderShortcuts` 换成实际主键）。

## 依赖与影响面

- 依赖 `src/shared/api.ts`（`MyTypelessBridge` 类型）与 `src/preload/index.ts`；新增 API 时三处同步。
- 窗口创建参数（尺寸、置顶、可聚焦）在 `src/main/index.ts`。

## 测试

没有渲染端自动测试。`npm run typecheck` 覆盖类型。行为验证用 `npm run dev`，或以 `--remoteDebuggingPort` 启动后用 CDP 驱动（见 `docs/_history/agent-runs/2026-10-14-stability-fixes.md`）。Windows 测浮动条鼠标要用 `mouse_event` / `SendInput` 产生真实输入：`SetCursorPos` 不经过低级鼠标钩子，`forward` 收不到移动；PowerShell 不感知缩放，坐标用逻辑像素；接点击的测试窗口不要置顶（会被激活后盖住浮动条）。

## 必读

[界面与存储需求](../../docs/requirements/ui.md) · [听写管线需求](../../docs/requirements/pipeline.md) · [IPC 契约](../../docs/contracts/ipc.md)
