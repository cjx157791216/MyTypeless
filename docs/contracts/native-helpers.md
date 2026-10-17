# 原生助手契约（主进程 ↔ `mt-*`）

助手是独立 CLI 进程，源码在 `native/`（`mt-whisper` 来自第三方 whisper.cpp，见下文），编译到 `native/bin/`，打包后位于 `MyTypeless.app/Contents/Resources/bin/`。路径解析：`src/main/native.ts` 的 `helperPath`（Windows 版助手同名、带 `.exe`，协议与本文相同；移植进度见 GAP-008）。辅助功能权限归属于启动它们的 app。

## 通用退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 参数/配置错误 |
| 3 | 未授予辅助功能权限 |
| 4 | 操作失败 |
| 5 | 没有选中文本（仅 `mt-inject --copy-selection`） |

## mt-hotkey（常驻）

调用：`mt-hotkey '<json>'`，`json = {"matches":[{"name":"dictation","key":"space","require":["opt"]}]}`。

- `key`：字母、数字、标点、`space`/`return`/`tab`/`escape`/`delete`、`f1`～`f20`、方向键与翻页键；单修饰键 `fn`、`ropt`/`lopt`、`rcmd`/`lcmd`、`rshift`/`lshift`、`rctrl`/`lctrl`；`shift` 只用于 `fn+shift`（左右 Shift 都算）。未知键写 stderr `unknown key: <key>` 并跳过。
- `require`：`opt`、`cmd`、`ctrl`、`shift`、`fn`。四个主修饰键**精确匹配**（多按了其他修饰键不触发）。Windows 版还支持区分左右的 `rshift`、`lshift`、`rctrl`、`lctrl`、`ropt`（`ralt`）、`lopt`（`lalt`）、`rcmd`、`lcmd`（该侧必须按着，同时算作对应的通用修饰键）。macOS 版不支持区分左右的 `require`：主进程把这类写法判为无效（`bindings.ts`），助手遇到不认识的修饰键时写 stderr `unknown modifier: <名> in <name>` 并跳过整条规则（不能只忽略修饰键，否则 `rctrl+space` 会变成单按空格）。
- stdout 每行一个 JSON 事件：`{"name":"system","phase":"ready"}`（tap 就绪）；`{"name":<绑定名>,"phase":"down"|"up"|"abort"}`。
- `abort` 只用于单修饰键触发（如 `fn`）：按住期间按了其他键。若该键与 fn 组成另一条注册组合（`fn+space` 的空格、`fn+shift` 的 Shift），先发当前绑定的 `abort`、再发那条组合的 `down`，组合键被吞掉；否则只发 `abort`，按键照常传给系统（如 Fn+方向键）。
- 命中的触发键被吞掉（包括按住时的自动重复）；单修饰键事件不吞。
- 父进程退出后 0.4 秒内自行退出。主进程侧：异常退出时退避重启至多 5 次；退出码 3 时转为 `globalShortcut` 兜底，并每 4 秒重试。

## mt-inject（一次性）

| 调用 | 行为 |
| --- | --- |
| `mt-inject <base64>` | 以 Unicode 键盘事件键入文本（16 字符一块，修饰键标志清空） |
| `mt-inject --paste <base64>` | 备份剪贴板全部类型 → 写入文本 → ⌘V → 约 0.45 秒后恢复（期间剪贴板被他人改过则不恢复） |
| `mt-inject --combo cmd+c` | 发送组合键（字母、`return`、`space`） |
| `mt-inject --copy-selection` | ⌘C 后等待剪贴板变化（≤600ms），stdout 输出选中文本的 base64，并完整恢复剪贴板；没有选中时退出码 5 |

`base64` 为 UTF-8 文本。主进程降级链（`src/main/inject.ts`）：`auto` 模式下 ≤160 字且无换行时先键入，否则直接粘贴；原生粘贴失败再退 osascript 粘贴。

## mt-text（一次性）

`echo <文本> | mt-text --to hans|hant`：用系统 ICU（`Hant-Hans` / `Hans-Hant`）做繁简转换，UTF-8 进出。调用方 `convertChineseScript`（`src/main/native.ts`）在失败时原样返回文本。

## mt-whisper（常驻，内置识别引擎）

whisper.cpp（MIT）`whisper-server` 的静态编译版，由 `scripts/build-whisper.sh` 从固定版本源码构建（Metal 着色器内嵌，只依赖系统框架）。由 `src/main/whisper/engine.ts` 管理：

- 启动：`mt-whisper -m <模型路径> --host 127.0.0.1 --port <随机空闲端口> -t <线程数> -l auto`
- 就绪：`GET /health` 返回 200（加载模型期间 503）；启动超时 60 秒
- 识别：`POST /inference`，multipart：`file`（WAV 16kHz 单声道）、`response_format=json`、`language`（`auto` 或 ISO-639-1）、可选 `prompt`；返回 `{"text": ...}`，分段之间带换行
- 生命周期：开始录音时预热；闲置 10 分钟退出；意外退出后下次调用自动重启；应用退出时结束
- 已知限制：`language=auto` 会额外跑一次编码器做语言检测（耗时约翻倍）；按请求缩小 `audio_ctx` 会让 turbo 模型输出乱码，不要使用

## mt-diarize（常驻，会议声纹与边录边降噪，D-015、D-024）

`native/diarize-helper.c`（原创）静态链接 sherpa-onnx（Apache-2.0）与 ONNX Runtime（MIT），由 `scripts/build-diarize.sh` 构建。由 `src/main/meeting/diarizer.ts` 管理：

- 启动：会议用两个进程——声纹 `mt-diarize --model <声纹模型.onnx> --segmentation <分段模型.onnx> --threads 2 [--turn-threshold 0.7]`，降噪 `mt-diarize --denoiser <gtcrn_simple.onnx> --threads 1`；内置中文识别另一个进程 `mt-diarize --firered <模型目录> --punct <标点模型.onnx> --threads 4`（D-027，正常优先级、闲置 10 分钟退出）；至少给一个模型；就绪时 stdout 输出 `{"ready":true,"dim":<维度，无声纹模型为 0>,"turns":<bool>,"denoise":<bool>,"asr":<bool>}`（启动超时 20 秒）；调度优先级 nice 15
- 命令（stdin 每行一条；**文件路径放最后、取到行尾**——真实路径含空格，如 `Application Support`）：`embed <起始样本> <样本数> <pcm 文件>`，从会议临时录音（16kHz 单声道 s16le）读取该段（最长 60 秒）
- 命令 `turns <起始样本> <样本数> <pcm 文件>`：对该段做 sherpa-onnx 离线说话人区分（分段 + 句内聚类），返回 `{"ok":true,"turns":[[起,止,说话人],...]}`（相对该段的样本下标；说话人标签只在该段内有意义，仅用来找换人位置）。主进程对每句话带上前面 8 秒录音调用
- 命令 `dnfeed <起始样本> <样本数> <pcm 文件>`：把该段接着送入流式降噪（GTCRN），返回已能输出的部分 `{"ok":true,"at":<首个输出样本在录音时间线上的位置>,"pcm":"<base64 s16le>"}`；输出与输入按样本对齐（实测无额外延迟），可能比输入少（缓冲到下次输出）；起始样本与上次结尾不连续时先重置。`dnflush`（单独一行）输出剩余部分并重置（输出可能比输入略长，调用方截到录音结尾）。`denoise <起始样本> <样本数> <pcm 文件>`：整段降噪，返回 `{"ok":true,"pcm":"..."}`
- 命令 `asr <base64 16kHz s16le>`：识别随命令传入的音频（听写录音不落盘，所以不传文件路径；一行可能很长），返回 `{"ok":true,"text":"..."}`；有 `--punct` 时结果已加标点（FireRedASR2 本身不出标点、英文全大写，大小写由主进程 `fixAsrCase` 处理）
- 结果（stdout 每行一条，与命令按顺序一一对应）：`{"ok":true,"v":[...]}` 或 `{"ok":false,"error":"..."}`（`too short` / `no audio` / `bad range` 等）
- 生命周期：会议中按需启动；闲置 2 分钟退出；stdin 关闭即退出；退出码 2 参数错误、4 模型加载失败
- 只读取传入的录音文件，不写任何文件、不联网

## mt-audiotap（常驻，应用声音截取，D-033）

`native/audiotap-helper.swift`（原创）用 Core Audio process tap（macOS 14.2+）截取其他应用播放的声音，挂在以默认输出设备为时钟的私有聚集设备上。由 `src/main/meeting/app-audio.ts` 管理（线上会议的应用声音一路）。

| 调用 | 行为 |
| --- | --- |
| `mt-audiotap --list` | stdout：有音频连接的进程 `[{"pid","bundleId","name","output"}]`（`output`：此刻正在发声） |
| `mt-audiotap --apps` | stdout：正在运行的普通应用 `[{"bundleId","name","audio","output"}]`（`audio`：它或它的辅助进程连过音频；`output`：此刻正在发声），供开会时选择 |
| `mt-audiotap --probe` | 建立截取后立即退出：stderr 输出 `{"ready":true,...}` 即已能截取。首次使用时系统先弹「录制系统音频」授权框，回应前不输出；用户允许后 macOS 会退出并重新打开启动它的 app——主进程在开会前用它完成授权 |
| `mt-audiotap [--bundle <前缀>]... [--pid <pid>]... [--exclude-bundle <前缀>]... [--exclude-pid <pid>]... [--mute] [--verbose]` | stdout 连续输出 16kHz 单声道 s16le（没人发声时输出静音，时间线与真实时间一致）；不给 `--bundle` / `--pid` 时截取全部系统声音（排除 `--exclude-*` 与自身）；给了则只截取 bundleId 以该前缀开头（Chrome 网页的声音来自 `com.google.Chrome.helper`）或该 pid 的进程；系统的音频进程列表一变就重新匹配（另每 2 秒检查一次）；`--mute`：被截取的声音不再从扬声器播放（测试用） |

- stderr 每行一条 JSON：就绪 `{"ready":true,"rate":<设备采样率>,"channels":2}`；匹配到的进程变化 `{"processes":[pid,...]}`；输出设备采样率变化 `{"rate":...}`；换了输出设备（插拔耳机、连蓝牙，整个截取重建，期间按真实时间补静音）`{"device":"名称"}`；`--verbose` 时每 2 秒 `{"peak":<0～32767>}`；错误 `{"error":"..."}`
- 权限：「系统音频录制」，归属启动它的 app（需要该 app 的 Info.plist 带 `NSAudioCaptureUsageDescription`）；授权框回应前停在启动阶段；拒绝过时系统不再询问、只给静音、不报错，调用方按长时间纯静音提示去系统设置
- 退出码：2 参数错误；4 系统低于 14.2 / 建立 tap 或聚集设备失败；收到 SIGTERM、stdout 关闭或父进程退出时清理并退出（0）
- 实现约束：IOProc 直接在音频线程回调（交给 dispatch queue 会跳过 IO 周期，声音变短）；按聚集设备的实际采样率重采样（tap 报的格式不准）；输出严格 16000 样本/秒（与麦克风录音放在同一时间线）
- 只把声音写到 stdout，不写文件、不联网

## mt-focus（一次性）

| 调用 | 行为 |
| --- | --- |
| `mt-focus` | stdout：`{"bundleId","name","pid"}`，取不到时为 `{}` |
| `mt-focus --activate <pid>` | 把该进程的应用切到前台；进程不存在退出码 2 |
| `mt-focus --caret-context <前> <后>` | 光标前后各若干字符：`{"text","caret","pid"}`；优先按范围读取（`AXStringForRange`），不支持时读出后只截这一段输出；读不到退出码 5；需要辅助功能权限（D-012） |
| `mt-focus --selected-text` | 焦点元素的 `AXSelectedText`（base64）；没有选中或应用不支持时退出码 5；需要辅助功能权限（否则退出码 3）；单次辅助功能调用超时 0.3 秒 |

两个读文字的用法找焦点元素时先问系统焦点；问不到（Electron / Chromium 应用默认不公开辅助功能树，返回 -25204）时改问前台应用自己的焦点元素，仍问不到则对该应用设置 `AXManualAccessibility = true`（Electron 提供的开关，让它建立辅助功能树）后再问一次。读到的仍只是光标附近这一段 / 选中的文字。

前两个用法不需要辅助功能权限。

## Windows 版（GAP-008）

源码在 `native/win/`（C++ + Win32，原创），`npm run native:win`（`scripts/build-native-win.cjs`，CMake + MSVC，静态链接运行库）编译到 `native/bin/mt-*.exe`。参数、输出与退出码同上；Windows 没有辅助功能授权，不会返回 3。与 macOS 的差异：

| 助手 | 状态 | 差异 |
| --- | --- | --- |
| `mt-text` | 已实现 | 系统 `LCMapStringEx`（`LCMAP_SIMPLIFIED_CHINESE` / `LCMAP_TRADITIONAL_CHINESE`），逐字转换，与 ICU `Hant-Hans` 一样不做词语转换 |
| `mt-focus` | 已实现 | `bundleId` 为小写 exe 文件名（如 `code.exe`），`name` 为程序的文件描述（没有时用 exe 文件名）；UWP 应用跳过外壳 `ApplicationFrameHost.exe` 取里面的应用；`--activate` 用 `AttachThreadInput` 绕过前台锁，切换后前台不是目标窗口时退出码 4。`--selected-text` / `--caret-context` 用 UI Automation 文本模式（`TextPattern` 的选区，光标前后按字符移动取一段，`caret` 为 UTF-16 下标）；拿不到时对标准编辑框（类名含 Edit，含 WinForms 文本框）直接发 `EM_GETSEL` / `WM_GETTEXT`；**密码框（`IsPassword` / `ES_PASSWORD`）一律不读**；Chromium / Electron 默认不开辅助功能：向页面窗口（新版为顶层 `Chrome_WidgetWin_*`）发一次 `WM_GETOBJECT`/`OBJID_CLIENT` 唤醒并重试——唤醒前已获得焦点的输入框要等光标动一次才可读，所以每个 Chromium 应用的第一次读取会落空；往后读到文本末尾时去掉 Chromium 附加的空格；读取在单独线程里做，超时（选区 0.8 秒、上下文 1.2 秒）按读不到处理；Scintilla（Notepad++）两种方式都读不到；VS Code 编辑器只在它的屏幕阅读器优化模式（`editor.accessibilitySupport: on`）下公开内容，否则焦点元素 `native-edit-context` 的选区为空、上下文是给读屏软件的提示语（macOS 同理） |
| `mt-inject` | 已实现 | `SendInput` 的 Unicode 键盘事件键入（16 个 UTF-16 单元一块，不拆开代理项对；换行发回车键）；键入 / 组合键前先松开仍按着的修饰键（Alt / Win 前插一个未分配的键，避免激活菜单栏 / 开始菜单）；粘贴为 Ctrl+V，`--combo` 的 `cmd` 按 Ctrl 处理；剪贴板备份恢复全部内存格式与增强图元文件，用剪贴板序列号判断是否被他人改过；写入剪贴板的临时内容与恢复的备份都带 `ExcludeClipboardContentFromMonitorProcessing`、`CanIncludeInClipboardHistory=0`、`CanUploadToCloudClipboard=0`（不进剪贴板历史与云剪贴板）。`--copy-selection` 由目标应用执行复制，那一份会进入剪贴板历史（无法标记）。被 UIPI 拦截（目标是管理员权限窗口）时系统不报错，键入会静默丢失 |
| `mt-hotkey` | 已实现 | 低级键盘钩子（`WH_KEYBOARD_LL`）；忽略程序模拟的按键（`LLKHF_INJECTED`，含 `mt-inject` 的键入）；`fn` 读不到，写 stderr `unknown key: fn` 后跳过（没有有效绑定时退出码 2，主进程退回 `globalShortcut`）；`opt` = Alt、`cmd` = Win；`key` 还可以是 `ralt` / `lalt`，以及只用于组合的 `ctrl` / `alt`（左右都算）；**单修饰键触发按住满 150ms 才发 `down`**，期间松开 = 轻按（补发 `down` + `up`），期间按下注册组合的键直接发那条组合的 `down`，期间按下其他键（如右 Shift+字母打大写）什么都不发；单修饰键触发是 Alt / Win 时按下后补发未分配的虚拟键 0xE8（避免松开时激活菜单栏 / 开始菜单）；AltGr 布局插入的假左 Ctrl（扫描码 0x21D）不计入修饰键；修饰键组合（`rshift+ctrl`）的第二个修饰键按下与抬起成对吞掉（Windows 默认 Ctrl+Shift / Alt+Shift 切换键盘布局 / 输入语言）；父进程退出后立即退出；安装钩子失败退出码 4。测试用 `mt-hotkey '<json>' --replay`：不安装钩子，从 stdin 逐行读 `<键名> down|up`，`tick` 一行表示按住满 150ms，输出同样的事件，被吞的按键另输出 `{"swallowed":"<行>"}`、补发菜单屏蔽键输出 `{"masked":"<行>"}`。目标是管理员权限窗口时收不到按键（UIPI） |
| `mt-diarize` | 已实现 | 与 macOS 同一份 `native/diarize-helper.c`（Windows 差异都在 `_WIN32` 分支：自带 `getline`、64 位文件偏移、命令行参数与录音路径按 UTF-8 处理、stdout 二进制模式），静态链接 sherpa-onnx `win-x64-static-MT-Release-no-tts-lib`；`npm run diarize:win` 编译；调度优先级由主进程 `setPriority` 设置 |
| `mt-whisper` | 暂不支持 | Windows 上 Whisper 模型（多语种）在模型列表里标为不支持、不能下载（`catalog.ts` 的 `engineUnsupported`）；识别语言只能用 Whisper 时（如日语、韩语），按键提示 `LOCAL_ENGINE_UNSUPPORTED` 并引导改为中文 / 英文或云端识别 |

