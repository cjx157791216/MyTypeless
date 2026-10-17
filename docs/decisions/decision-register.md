# 决策登记

## 已确认决策

完整原文按领域存放在 `domains/` 目录。本索引每条一行，用于定位；实现时读取任务路由给出的领域文件。新增决策：在对应领域文件追加完整原文（注明确认人和日期），并在本索引追加一行（`npm run docs:check` 校验两边一致）。

| ID | 领域 | 摘要 | 确认日期 |
| --- | --- | --- | --- |
| D-001 | [全局](domains/general.md) | 全部原创：不复制其他产品的代码/提示词/资源/文案/商标，不接入其服务端 | 2026-10-14 |
| D-002 | [全局](domains/general.md) | 隐私红线：只匹配注册快捷键、不采集屏幕/URL、音频不落盘、历史仅本地、Key 进 Keychain | 2026-10-14 |
| D-003 | [全局](domains/general.md) | BYOK，无中心云服务，润色本地编排 | 2026-10-14 |
| D-004 | [听写管线](domains/pipeline.md) | ASR 混合双模式：云端 OpenAI 兼容 + 本地 whisper.cpp | 2026-10-14 |
| D-005 | [听写管线](domains/pipeline.md) | 不做云同步 | 2026-10-14 |
| D-006 | [打包发布](domains/release.md) | 仅 macOS（arm64）先行，其他平台架构预留 | 2026-10-14 |
| D-007 | [原生层](domains/native.md) | 自动写入：≤160 字且无换行逐字键入，否则粘贴 | 2026-10-14 |
| D-008 | [听写管线](domains/pipeline.md) | 听写不丢字：润色失败回退本地清理，写入失败放进剪贴板 | 2026-10-14 |
| D-009 | [听写管线](domains/pipeline.md) | 内置本地识别为默认：随包 whisper.cpp 引擎，模型首次使用时下载 | 2026-10-14 |
| D-010 | [原生层](domains/native.md) | 按住 Fn 说话 / 轻按免手持 / 选中即改写 / Fn+空格 提问 / Fn+Shift 翻译 / 底部小胶囊 | 2026-10-14 |
| D-011 | [听写管线](domains/pipeline.md) | 麦克风保持就绪默认开启（60 秒、0.3 秒内存预录，可关闭） | 2026-10-15 |
| D-012 | [全局](domains/general.md) | 自动词典：写入后追踪修改（只读插入那段）+ 常用专有名词；有限放宽 D-002 | 2026-10-15 |
| D-013 | [听写管线](domains/pipeline.md) | 实时转写：停顿即识别、限频预览、24 秒定稿、单请求在途、引擎降优先级 | 2026-10-15 |
| D-014 | [听写管线](domains/pipeline.md) | 最长录音默认 20 分钟，最后 1 分钟倒计时，到时自动结束并写入；长音频分段识别 | 2026-10-15 |
| D-015 | [会议模式](domains/meeting.md) | 会议模式：只用麦克风，按句转写 + 本地说话人区分，会后每人总结与纪要，会议中暂停 Fn 听写 | 2026-10-15 |
| D-016 | [全局](domains/general.md) | 会议录音临时落盘（纪要后删除）、命名后保存声纹；有限放宽 D-002 | 2026-10-15 |
| D-017 | [界面与存储](domains/ui.md) | 主窗口改版：左侧导航、首页概览、设置分组，与会议模式一起交付 | 2026-10-15 |
| D-018 | [全局](domains/general.md) | 给说话人改名时默认记住声音（可取消勾选）；修订 D-016 | 2026-10-15 |
| D-030 | [全局](domains/general.md) | 以个人名义 MIT 开源到 GitHub（cjx157791216/MyTypeless），保留名称；不含逆向资料，历史从清理后快照开始 | 2026-10-17 |
| D-031 | [全局](domains/general.md) | 代码管理迁到 GitHub（公开），main 只经 PR + CI 合并；GitLab 仓库只做私有存档 | 2026-10-17 |
| D-019 | [会议模式](domains/meeting.md) | 句内换人检测 + 自动区分说话人、随时点名字改名、结束时选择生成纪要或只保存记录 | 2026-10-15 |
| D-020 | [会议模式](domains/meeting.md) | 参会人数随时可改并立即重新区分；逐句声纹随会议保存；自动模式与已知人数的归类规则 | 2026-10-15 |
| D-021 | [会议模式](domains/meeting.md) | 只按参会人数区分说话人（开会必选人数、默认 2 人），去掉自动判断人数 | 2026-10-15 |
| D-022 | [会议模式](domains/meeting.md) | 声纹认人用整组声音（≥ 2 句）、按声纹自身一致度衡量（≥ 0.65），一个声纹只给一个人 | 2026-10-15 |
| D-023 | [听写管线](domains/pipeline.md) | 说话时默认只显示波形、不显示文字（设置项 `showLiveText`，默认关）；停顿时后台识别不变 | 2026-10-15 |
| D-027 | [听写管线](domains/pipeline.md) | 中文/英文内置识别默认 FireRedASR2 + 标点模型（会议错字 18% → 5%），其他语言用 Whisper | 2026-10-15 |
| D-024 | [会议模式](domains/meeting.md) | 会议边录边降噪（GTCRN）用于分句、识别用原始录音并音量归一；不采用降噪后识别与上一句提示词 | 2026-10-15 |
| D-025 | [会议模式](domains/meeting.md) | 已区分出各人后，句内按 1.5 秒窗口与各人比较找换人位置 | 2026-10-15 |
| D-026 | [会议模式](domains/meeting.md) | 声纹模型换成 ERes2NetV2，门槛按真实会议重标定；旧模型声纹删除、旧会议不认声纹 | 2026-10-15 |
| D-028 | [打包发布](domains/release.md) | 在线更新：检查新版本 → 提示 → 确认后应用内下载 → 提示重启更新；发布地址见 D-029 | 2026-10-17 |
| D-029 | [打包发布](domains/release.md) | 在线更新的发布地址改为 GitHub 公开仓库 cjx157791216/mytypeless-releases（修订 D-028） | 2026-10-17 |
| D-033 | [会议模式](domains/meeting.md) | 线上会议：声音来源三选一（麦克风 / 麦克风 + 会议软件 / 只用会议软件），现场与线上分两路各自区分说话人，麦克风去掉外放回声；开会前完成「录制系统音频」授权（修订 D-015） | 2026-10-17 |
| D-032 | [打包发布](domains/release.md) | 版本发布到代码仓库自己的 Releases（标签打在已合并的提交上）；旧发布仓库只同步版本说明（修订 D-029） | 2026-10-17 |

## 默认架构

已接受的技术默认方案。偏离时新增 ADR（模板见 [templates/adr.md](../templates/adr.md)），不静默修改。

| ID | 默认方案 |
| --- | --- |
| A-001 | Electron 33 + TypeScript，electron-vite 构建；渲染端为无框架的原生 TS + CSS，三个窗口（浮动条/主窗口/回答浮卡） |
| A-002 | 原生能力用 Swift 编译的独立 CLI 助手（`mt-hotkey`/`mt-inject`/`mt-focus`），主进程以子进程调用（实际实现与早期方案中的 koffi + dylib 不同，以本条为准） |
| A-003 | 本地存储：better-sqlite3 v11（历史、词典），设置为 userData 下的 JSON，API Key 用 Electron `safeStorage` 加密 |
| A-004 | 云端 ASR/LLM 统一走 OpenAI 兼容 HTTP 协议（见 [外部服务契约](../contracts/external-services.md)） |
| A-005 | 打包：electron-builder，arm64 DMG + zip，原生助手经 `extraResources` 随包；本机/内部测试用本地自签名证书签名（`scripts/setup-signing.sh` + `scripts/sign-app.cjs`），使系统授权在重新打包后保留；对外分发须换 Developer ID（GAP-009） |
| A-006 | 测试：Node 原生 test runner 直接运行 TS（`test/*.test.ts`），不引入测试框架依赖；被测模块不能用 TS 参数属性（Node 只剥离类型） |
| A-007 | 内置识别引擎：whisper.cpp v1.9.5 的 `whisper-server` 静态编译（Metal 内嵌）为 `mt-whisper`，主进程以子进程按需启动、闲置退出（见 [原生助手契约](../contracts/native-helpers.md)） |
| A-008 | 在线更新：electron-updater（generic 源，关闭自动下载与差分下载）+ Electron 自带的 Squirrel.Mac 安装；版本说明由 `scripts/publish.cjs` 生成，与安装包一起发布为 GitHub Release（D-028、D-029） |

## 变更规则

更换 Electron 大版本、存储方案、原生调用方式、打包签名方式，或任何触及 D-001/D-002 的改动，必须新增 ADR。产品规则变更写入对应领域决策、需求与验收，并注明确认人和日期。
