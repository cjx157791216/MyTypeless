# 2026-10-17 Windows 助手：mt-audiotap（线上会议截取会议软件的声音）

## 范围

GAP-008：D-033（线上会议截取会议软件声音）的 Windows 实现。协议与 macOS 版 `mt-audiotap` 一致，主进程 `app-audio.ts` 的截取、混合、回声处理流程不变。需要 Windows 11（进程回环录音要求 Windows 10 build 20348+），更早的系统仍只能用麦克风。

## 改动

- `native/win/audiotap-helper.cpp`（`mt-audiotap.exe`）：WASAPI 进程回环录音。给了 `--bundle`（小写 exe 名，完全匹配）/ `--pid`：对匹配进程树的根各截一路（含子进程，Chrome、Teams 的声音来自子进程）并混合；都不给：截取全部系统声音、排除父进程（MyTypeless 主进程）整棵树。请系统直接转换为 16k 单声道，不行退到 48k 双声道自己下混降采样。按真实时间补静音，严格 16000 样本/秒；每 2 秒重新匹配进程（应用后开、重启、换输出设备后自动重建）。`--apps` / `--list` 用音频会话（所有输出设备）+ 可见窗口列应用。Windows 截取应用声音不需要授权，`--probe` 直接试建。
- `native/win/process-info.h`：exe 路径、文件描述、父进程退出即退出，`mt-focus` 改用它（去掉重复代码）。
- `app-audio.ts`：Windows 按系统版本判断是否支持；常见会议软件加入 Windows 的 exe 名（腾讯会议 `wemeetapp.exe`、飞书、Zoom、Teams、钉钉、微信、Webex、浏览器）；MyTypeless 自己按 exe 名排除。
- 界面与提示：Windows 上不提“系统会请求录制系统音频权限”；不支持时说明需要 Windows 11；“一直没有收到声音”的提示在 Windows 上改为检查会议软件是否在播放 / 被静音。需求与验收 MEET-025 补上 Windows 的条件。

## 验证

- 端到端（测试进程用 SoundPlayer 小音量播放 440Hz）：按 exe 截取与截取全部系统声音都得到 440Hz、均方根 2115（理论 2121），输出约 16000 样本/秒；没有匹配进程时输出纯静音、时间线照常推进。6 项全部通过。中途接入的诊断：从播放开始就截取时补静音比例 0%、主频 440Hz。
- `--apps` 在本机列出 10 个应用，名称取自文件描述，能区分正在发声的应用；`--probe` 就绪（Windows 11 build 26300）。
- 单测：`--apps` / `--list` 为 JSON、参数错误退出码 2、截取不存在的应用输出 16kHz 静音（CI 机器不支持进程回环录音时跳过）。`npm run test` 105 通过 / 0 失败；typecheck、build、docs:check 通过。
- `mt-focus` 改用共用头文件后，读选区端到端 23 项仍全部通过。

## 遗留

- 用真实会议软件（腾讯会议、飞书、Teams、网页会议）开线上会议的真机验收（MEET-020～024）。
- 不支持 `--mute`（进程回环录音不能让原声不从扬声器播放）；Windows 10（build 20348 以下）不支持。
