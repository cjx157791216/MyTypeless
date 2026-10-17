# 术语词汇表

状态：`active`。统一业务讨论、文档、代码评审和 AI 输出的用词：同一概念只用一个名称。本表只做用词索引，不创设业务规则；与权威文档冲突时按 `AGENTS.md` 的事实优先级修正本表。

## 使用规则

1. 文档和页面文案使用“术语”列的中文名；代码、接口、数据库对象使用“标识”列的英文名。新建代码标识前先查本表，没有则先登记。
2. 每条只写一行定义，并注明权威来源（需求文档或 `D-xxx`）；规则细节留在来源文档。
3. 术语全表唯一（`npm run docs:check` 校验）。概念改名时更新原行，并把旧说法登记到“废弃说法”。
4. 发现文档之间用词或口径冲突时登记到 [open-questions.md](open-questions.md)，不静默选边。

## 治理

| 术语 | 标识 | 定义 | 来源 |
| --- | --- | --- | --- |
| 决策 | `D-xxx` | 已由人确认的业务或架构决定，原文在 `docs/decisions/domains/` | [决策登记](decisions/decision-register.md) |
| 未决事项 | `B-xxx` | 会改变业务结果、尚待人工裁决的问题 | [open-questions.md](open-questions.md) |
| 功能缺口 | `GAP-xxx` | 需求到验收通过之间待完成的工作项 | [gap-ledger.md](implementation/gap-ledger.md) |
| 默认架构 | `A-xxx` | 已接受的技术默认方案，偏离需写 ADR | [决策登记](decisions/decision-register.md) |
| 模块说明 | `AGENTS.md` | 代码目录内给 AI 的结构、范例、不变量与测试说明 | [AGENTS.md](../AGENTS.md) |
| 人工门禁 | — | 必须暂停并由人确认的事项 | [AGENTS.md](../AGENTS.md) |

## 听写管线

| 术语 | 标识 | 定义 | 来源 |
| --- | --- | --- | --- |
| 会话 | `DictationSessionManager` | 一次从开始录音到结果投递的完整过程，同一时刻只有一个 | [pipeline.md](requirements/pipeline.md) |
| 模式 | `FeatureMode` | 会话类型：听写、翻译、改写选中、语音提问 | [pipeline.md](requirements/pipeline.md) |
| 听写 | `dictation` | 口述 → 润色 → 写入光标的默认模式 | [pipeline.md](requirements/pipeline.md) |
| 翻译 | `translate` | 用母语说，输出目标语言并写入 | [pipeline.md](requirements/pipeline.md) |
| 改写选中 | `rewrite` | 按口述指令改写选中文本并替换选区 | [pipeline.md](requirements/pipeline.md) |
| 语音提问 | `ask` | 口述问题，回答显示在回答浮卡，不自动写入 | [pipeline.md](requirements/pipeline.md) |
| 语音识别 | `asr`、`AsrProvider` | 把音频转成原话文本；内置本地引擎、云端或自建 whisper.cpp 服务 | D-004 |
| 内置引擎 | `builtin`、`mt-whisper`、`WhisperEngine` | 随包分发的本地识别引擎（whisper.cpp），默认识别方式 | D-009 |
| 语音模型 | `ModelSpec`、`builtinModel` | 内置引擎使用的 whisper 模型文件，首次使用时下载到 userData/models | D-009 |
| 识别语言 | `asr.language` | 内置引擎的识别语言；跟随系统 / 自动检测 / 指定语言 | [pipeline.md](requirements/pipeline.md) |
| 中文输出 | `asr.chineseScript` | 内置引擎中文结果的字形：跟随系统 / 简体 / 繁体 / 不转换 | [pipeline.md](requirements/pipeline.md) |
| 原话 | `rawText` | 语音识别直接输出、未经处理的文本 | [ipc.md](contracts/ipc.md) |
| 润色 | `polish`、`LlmPolisher` | 用 LLM 把原话整理成书面文字（含翻译、改写、提问的 LLM 调用） | [pipeline.md](requirements/pipeline.md) |
| 本地清理 | `localPreClean` | 不调用 LLM 的规则清理：去填充词、保守的改口折叠 | [pipeline.md](requirements/pipeline.md) |
| 结果 | `polishedText` | 会话最终投递的文本（润色、译文、改写结果或回答） | [ipc.md](contracts/ipc.md) |
| 个人词典 | `dict_words` | 用户维护的专有名词表，用于识别提示和润色约束 | [pipeline.md](requirements/pipeline.md) |
| 实时转写 | `LiveTranscriber` | 说话时边识别边显示；停顿即识别、限频预览、长段定稿 | D-013 |
| 窗口 / 定稿 | `windowStart`、`frozenText` | 窗口是自上次定稿以来的音频；定稿后的部分不再重复识别 | D-013 |
| 最长录音时长 | `maxRecordingMs` | 单次录音的上限，默认 20 分钟；最后 1 分钟倒计时，到时自动结束并写入 | D-014 |
| 个人模式 / 会议模式 | `AppMode`（`personal` / `meeting`） | 主窗口侧栏顶部的切换；个人模式为听写相关页面，会议模式为会议工作区 | D-015、D-017 |
| 会议 | `MeetingManager`、`meetings` 表 | 一次线下会议的录制、转写、说话人区分与纪要 | D-015 |
| 一句话（分句） | `UtteranceSegmenter`、`Utterance` | 会议转写与说话人区分的单位：停顿 0.6 秒切句，最长约 20 秒 | D-015 |
| 说话人 | `MeetingSpeaker`、`meeting_speakers` 表 | 会议中区分出的一个人，默认名「说话人 N」，可改名 | D-015 |
| 声音特征 | embedding、`centroid` | 声纹模型从一句话算出的向量（不是录音，无法还原声音）；说话人的中心是其各句特征的平均 | D-016 |
| 声纹 | `Voiceprint`、`voiceprints` 表 | 用户命名并勾选“记住这个声音”后保存的声音特征，用于下次会议自动认出 | D-016 |
| 重新归类 | `recluster` | 会议结束时用整场声音特征重新判定说话人：合并重复、吸收零散、逐句重归 | D-015 |
| 句内换人检测 | `turns`、`splitByTurns`、`turnsInUtterance` | 一句话内部找出换人的位置并按人切开（带前 8 秒参考录音）；切开后同一人的相邻段合回（`mergeAdjacentParts`） | D-019 |
| 中文高精度识别 | `firered2-aed-int8`、`fireredEngine`、`fixAsrCase` | 内置识别的 FireRedASR2 + 标点模型，由 mt-diarize 运行；英文大小写按词典与常见缩写恢复 | D-027 |
| 声纹模型标识 | `EMBED_MODEL`、`meetings.embed_model`、`voiceprints.model` | 不同声纹模型的向量不可比较；会议与声纹记下所用模型 | D-026 |
| 按窗口找换人 | `splitByWindows`、`WINDOW_MS` | 已区分出各人后，句内每 0.5 秒取 1.5 秒与各人比较，在归属变化处切开 | D-025 |
| 边录边降噪 | `denoiser`、`dnfeed`、`MEETING_VAD_DENOISED` | 会议录音用 GTCRN 流式降噪，降噪后的声音只用于分句（识别、声纹用原始录音） | D-024 |
| 音量归一 | `normalizeLoudness` | 识别前把一句话放大到正常说话的音量（最多 30 dB、不削顶） | D-024 |
| 声纹匹配分 | `printScore`、`identifySpeakers`、`PRINT_MATCH` | 一组声音与已保存声纹的平均相似度 ÷ 声纹自身的一致度；≥ 0.65 且至少 2 句才认，一个声纹在一场会议只给一个人 | D-022 |
| 平均相似度（平均链接） | `SAME_SPEAKER`、`regroup` | 一段与某人每段声纹相似度的平均值，“是不是同一个人”统一用它判断（门槛 0.55）；会议中定期与结束时用它按参会人数整体重新归类 | D-019、D-021 |
| 会议纪要 | `minutes` | 会后由 LLM 生成的 Markdown：头部本地生成，正文五节 | D-015 |
| 临时录音 | `meetings.audio_path`（`userData/meetings/*.pcm`） | 会议期间保存在本机的录音，整理完删除 | D-016 |
| 在线更新 | `updater.ts`、`UpdateState`、`autoCheckUpdates` | 检查发布地址的新版本 → 提示 → 用户确认后应用内下载 → 重启更新 | D-028 |
| 发布地址 | `DEFAULT_UPDATE_URL`、`MT_UPDATE_URL` | 存放版本说明与安装包的公开地址（代码仓库 cjx157791216/MyTypeless 的最新 Release；旧版本读取 mytypeless-releases） | D-032 |
| 版本说明 | `latest-mac.yml` | 发布地址上描述最新版本的文件：版本号、构建号、zip 地址与 sha512、更新内容；由 `npm run release` 生成上传 | D-028 |
| 构建号 | `MT_BUILD`、`AppInfo.build` | 每次打包的时间 `YYYYMMDD.HHmm`，写在安装包文件名、CFBundleVersion 与应用内版本显示里；开发运行为 dev | [release.md](requirements/release.md) |
| 自动学习 | `learner.ts`、`countLearned` | 从写入后的修改与常用专有名词中自动收录词典（词条来源 `auto`，标 *） | D-012 |
| 冲刷 | `captureFlush`、`audioFinal` | 停止录音前把浮动条缓冲中的尾音送到主进程的握手 | [ipc.md](contracts/ipc.md) |
| 静音自动停止 | `autoStopMs` | 触发式录音在持续静音后自动结束；按住说话不启用 | [ipc.md](contracts/ipc.md) |

## 原生层

| 术语 | 标识 | 定义 | 来源 |
| --- | --- | --- | --- |
| 原生助手 | `mt-hotkey`、`mt-inject`、`mt-focus` | Swift 编译的独立命令行进程，提供快捷键、写入、前台应用能力 | [native-helpers.md](contracts/native-helpers.md) |
| 快捷键绑定 | `bindings` | 模式到组合键的映射，如 `fn`、`fn+space` | [native.md](requirements/native.md) |
| 主键 | `bindings.dictation` | 听写用的快捷键（默认 Fn），同时用来结束免手持和提问/翻译 | D-010 |
| 按住说话 | `hold` | 按住主键录音，松开结束并写入 | D-010 |
| 免手持 | `handsFree`、`enterHandsFree` | 轻按主键（或按提问/翻译键）开始，不用一直按着，再按一下结束 | D-010 |
| 选中即改写 | `getSelectedTextAX` | 按主键时若有选中文字，本次会话自动按改写处理 | D-010 |
| 悬浮胶囊 | `floating-bar` 的 `.pill` | 屏幕底部居中的录音指示，取代原来的大浮动条 | D-010 |
| 单修饰键触发 | `modifierOnly` | 只用一个修饰键（如右 Option、fn）作为按住说话的快捷键 | [native-helpers.md](contracts/native-helpers.md) |
| 兜底模式 | `globalShortcut` 回退 | 原生快捷键助手不可用时改用 Electron 全局快捷键（主键为 Fn 时改用 ⌥+空格），只能按一下开始、再按一下结束 | [native.md](requirements/native.md) |
| 写入 | `inject`、`injectText` | 把结果送进前台应用光标处（键入或粘贴） | [native.md](requirements/native.md) |
| 写入降级链 | `injectMethod` | 键入 → 粘贴 → osascript 粘贴的逐级回退 | [native.md](requirements/native.md) |
| 前台应用 | `FrontAppInfo` | 会话开始时处于前台的应用（名称、bundleId、pid） | [native-helpers.md](contracts/native-helpers.md) |

## 界面与存储

| 术语 | 标识 | 定义 | 来源 |
| --- | --- | --- | --- |
| 浮动条 | `floating-bar` | 录音时出现的悬浮条，负责麦克风采集与状态展示 | [ui.md](requirements/ui.md) |
| 主窗口 | `hub` | 设置、词典、历史与权限状态窗口 | [ui.md](requirements/ui.md) |
| 回答浮卡 | `answer-card` | 显示语音提问回答的浮窗 | [ui.md](requirements/ui.md) |
| 历史 | `history`、`HistoryRecord` | 本地 sqlite 中的会话记录 | [ui.md](requirements/ui.md) |
| 设置 | `Settings`、`settings.json` | 用户偏好；API Key 不在其中 | [ipc.md](contracts/ipc.md) |
| API Key | `keys.bin`、`getKey` | 经 `safeStorage` 加密存放的 ASR / LLM 密钥 | D-002 |

## 打包发布

| 术语 | 标识 | 定义 | 来源 |
| --- | --- | --- | --- |
| 打包版 | `release/`、`npm run dist` | electron-builder 产出的 DMG / zip | [release.md](requirements/release.md) |
| adhoc 签名 | `identity: null` | 不使用开发者证书的本机签名，每次打包都会变化 | [release.md](requirements/release.md) |

## 易混淆对照

| 容易混用的说法 | 区别 | 来源 |
| --- | --- | --- |
| 原话 / 结果 | 原话是识别输出（`rawText`）；结果是最终投递的文本（`polishedText`），在提问模式下是回答 | [ipc.md](contracts/ipc.md) |
| 写入 / 注入 | 同一概念：界面和文档用“写入”，代码标识用 `inject` | [native.md](requirements/native.md) |
| 润色 / 本地清理 | 润色调用 LLM；本地清理只用规则，在未配置 LLM 或润色失败时使用 | [pipeline.md](requirements/pipeline.md) |
| 内置引擎 / 自建 whisper.cpp 服务 | 内置引擎由应用自带并自动管理；自建服务是用户自己运行、填写地址的 whisper.cpp（高级选项） | [external-services.md](contracts/external-services.md) |
| 免手持 / 兜底模式 | 免手持是用户轻按主键主动选择的；兜底模式是原生助手不可用时的被动退化 | [native.md](requirements/native.md) |

## 废弃说法

`npm run docs:check` 会提示事实文档中仍在使用的废弃说法（`docs/_history/`、决策原文与本表除外）。

| 废弃说法 | 现行说法 | 依据 |
| --- | --- | --- |
| 触发模式 | 免手持 | D-010：不再有“按住/触发”二选一设置，轻按主键即免手持 |
