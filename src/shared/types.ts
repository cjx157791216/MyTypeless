// MyTypeless 共享类型与 IPC 通道定义（main/preload/renderer 共用）

export type DictationState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'polishing'
  | 'injecting'
  | 'done'
  | 'error'

export type FeatureMode = 'dictation' | 'translate' | 'rewrite' | 'ask'

export interface HistoryRecord {
  id: string
  createdAt: number
  durationMs: number
  rawText: string // ASR 原文（听写=口述内容；改写=指令；ask=问题）
  polishedText: string // 润色/翻译/改写结果；ask=AI 回答
  appName?: string // 焦点应用名（仅本地展示）
  appBundleId?: string
  mode: FeatureMode
  status: 'completed' | 'error' | 'cancelled'
  error?: string
  sourceText?: string // rewrite 模式的选中文本
}

export interface AsrProviderConfig {
  // builtin=内置本地引擎（随包 whisper.cpp，默认）；openai=云端 OpenAI 兼容；local-whisper=用户自建的 whisper.cpp 服务
  provider: 'builtin' | 'openai' | 'local-whisper'
  baseUrl: string // openai / local-whisper 使用
  model: string // openai 使用
  builtinModel: string // 内置引擎使用的模型 ID（见 src/main/whisper/catalog.ts）；空 = 按识别语言推荐
  language: string // 识别语言：'system' 跟随系统 / 'auto' 自动检测 / ISO-639-1（如 'zh'）；用于本地引擎
  chineseScript: 'system' | 'hans' | 'hant' | 'off' // 本地引擎中文输出：跟随系统 / 简体 / 繁体 / 不转换
  apiKeyMasked?: string
  hasApiKey?: boolean
}

export interface ModelInfo {
  id: string
  label: string
  description: string
  sizeBytes: number
  recommended: boolean
  installed: boolean
}

export interface ModelProgress {
  id: string
  state: 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled'
  receivedBytes: number
  totalBytes: number
  bytesPerSec?: number
  error?: string
}

export interface LlmProviderConfig {
  baseUrl: string
  model: string
  hasApiKey?: boolean
  apiKeyMasked?: string
}

export interface PolishOptions {
  enabled: boolean
  appCategoryHint?: string
  outputLanguage?: 'auto' | string
}

export interface Settings {
  hotkeyMode: 'hold' | 'toggle' // 已废弃：现在按住=按住说话、轻按=免手持（D-010），保留字段兼容旧设置
  hotkeyKey: string // 听写快捷键，如 "opt+space"
  hotkeyToggle: string // globalShortcut 兜底加速键（兼容保留）
  bindings: {
    dictation: string
    translate: string
    rewrite: string
    ask: string
  }
  translateTarget: string // 翻译目标语言
  autoStopSilenceMs: number // 静音自动停止（0=关闭）
  maxRecordingMs: number
  polishEnabled: boolean
  injectMethod: 'auto' | 'type' | 'paste' // auto=键入优先粘贴兜底
  asr: AsrProviderConfig
  llm: LlmProviderConfig
  launchAtLogin: boolean
  keepMicWarm: boolean // 用完后麦克风保持就绪 60 秒：期间再开口不丢开头（菜单栏会显示麦克风图标）
  micDeviceId: string // 麦克风 deviceId；空 = 自动（跳过虚拟输入设备，采到纯静音时自动换到真实麦克风）
  livePreview: boolean // 已废弃：由 showLiveText 取代（旧设置里多为保存时写入的 true，无法区分是否用户选择，D-023），保留字段兼容旧设置
  showLiveText: boolean // 说话时在胶囊上方显示识别中的文字；默认关（说话时只显示波形，松手后出结果；停顿时仍在后台识别以缩短等待，D-023）
  learnFromEdits: boolean // 写入后追踪修改、学习改正的词（只读刚插入的那段，D-012）
  learnFrequentTerms: boolean // 统计常用英文专有名词并加入词典（D-012）
  polishContext: boolean // 润色时参考光标前已有的文字（最多 300 字，随润色请求发给所配置的 LLM，D-039）；默认关
  learnStyle: boolean // 风格学习：保存写入后被改过的结果，润色时作为示例（D-040）；默认关
  styleNote: string // 个人风格说明：用户手写的润色要求（D-040）
  appMode: AppMode // 主窗口当前模式：个人（听写）/ 会议（D-015、D-017）
  meetingSpeakers: number // 上次开会选的参会人数（托盘开会也用它；D-021）；麦克风 + 应用声音时为现场人数
  meetingSource: MeetingSource // 上次开会选的声音来源（D-033）
  meetingApp: string // 上次截取声音的应用 bundleId；空 = 全部系统声音
  meetingRemoteSpeakers: number // 上次选的线上人数（应用声音里有几个人）
  autoCheckUpdates: boolean // 启动后与每 6 小时检查一次新版本（只读发布地址的版本说明，D-028）
}

export type AppMode = 'personal' | 'meeting'

/** 会议的声音来源（D-033）：只用麦克风 / 麦克风 + 会议软件的声音 / 只用会议软件的声音 */
export type MeetingSource = 'mic' | 'mixed' | 'app'
/** 会议录音的一路：0 = 麦克风（现场），1 = 应用声音（线上） */
export type MeetingTrack = 0 | 1

/** 可截取声音的正在运行的应用（mt-audiotap --apps） */
export interface AudioApp {
  bundleId: string
  name: string
  audio: boolean // 已连接音频（开过声音）
  output: boolean // 此刻正在发声
}

/** 应用版本信息：version 来自 package.json；build 为打包时间 YYYYMMDD.HHmm（开发运行为 dev）；commit 为 git 短哈希 */
export interface AppInfo {
  version: string
  build: string
  commit: string
}

/** 在线更新（D-028）：发现新版本 → 用户确认后应用内下载 → 下载完提示重启更新 */
export interface UpdateState {
  state: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  version?: string // 新版本号
  build?: string // 新版本构建号
  notes?: string // 更新内容
  dmgUrl?: string // 安装包下载地址（自动安装失败时手动下载；Windows 解压即用版为 Release 页面）
  manual?: boolean // Windows 解压即用版（zip）：只提示新版本，用户手动下载（D-036）
  percent?: number // 下载进度 0～100
  bytesPerSec?: number
  error?: string
  checkedAt?: number // 上次检查完成时间
}

// —— 会议模式（D-015）——

/** recording/paused：进行中；processing：结束后整理中；done：已完成；interrupted：异常中断待整理 */
export type MeetingStatus = 'recording' | 'paused' | 'processing' | 'done' | 'interrupted'

export interface MeetingSpeaker {
  id: number
  label: number // 「说话人 N」的 N（每一路各自编号）
  track: MeetingTrack
  name: string | null // 用户起的名字或声纹认出的名字
  voiceprintId: number | null // 已保存的声纹（记住这个声音）
  displayName: string // name ?? 说话人 N
  segmentCount: number
}

export interface MeetingSegment {
  id: number
  speakerId: number | null // null = 尚未区分
  track: MeetingTrack
  startMs: number // 会议录音时间线（暂停不计；两路对齐到同一时间线）
  endMs: number
  text: string
  locked: boolean // 用户手动指定过说话人
}

export interface MeetingSummary {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  durationMs: number
  status: MeetingStatus
  speakers: string[]
  hasMinutes: boolean
}

export interface MeetingDetail extends MeetingSummary {
  source: MeetingSource
  appName: string | null // 截取声音的应用（全部系统声音时为“系统声音”）
  expectedSpeakers: number | null // 麦克风这一路（现场）的人数
  expectedRemote: number | null // 应用声音这一路（线上）的人数
  speakerList: MeetingSpeaker[]
  segments: MeetingSegment[]
  minutes: string | null // Markdown
  minutesError: string | null
}

/** 当前会议的实时状态（main → 浮动条/主窗口） */
export interface MeetingLive {
  state: 'idle' | 'recording' | 'paused' | 'processing'
  meetingId?: string
  title?: string
  elapsedMs?: number // 发出时已录时长（暂停不计）
  running?: boolean // 正在计时（recording）
  stage?: string // processing 时的步骤说明
  notice?: string // 一次性提示（如即将到达时长上限、声纹模型下载中）
  speakerModel?: 'ready' | 'missing' | 'downloading' | 'error'
  speakerModelProgress?: number // 0..1
}

export interface MeetingStartOptions {
  title?: string
  expectedSpeakers?: number | null // 现场（麦克风）人数
  source?: MeetingSource
  appBundleId?: string // 空 = 全部系统声音
  appName?: string
  expectedRemote?: number | null // 线上（应用声音）人数
}

/** 风格学习的一条修改记录（D-040）：写入的结果 → 用户改后的样子 */
export interface StyleSample {
  id: number
  createdAt: number
  appName?: string
  before: string
  after: string
}

export interface Voiceprint {
  id: number
  name: string
  samples: number // 累计参与的句子数
  createdAt: number
  updatedAt: number
}

export interface HistoryStats {
  count: number
  totalDurationMs: number
  totalChars: number
  weekCount: number
  todayChars: number
}

export interface SessionProgress {
  state: DictationState
  mode?: FeatureMode
  level?: number // 0..1 麦克风电平
  elapsedMs?: number
  rawText?: string
  polishedText?: string
  error?: string
  errorCode?: string // 需要界面配合处理的错误（如 LOCAL_MODEL_MISSING → 打开主窗口下载模型）
  notice?: string // 非致命提示（如 LLM 失败已回退本地清理、结果已复制到剪贴板）
  autoStopMs?: number // recording 时下发：渲染端静音自动停止阈值（0=关闭）
  handsFree?: boolean // recording 时：免手持（轻按开始，再按结束）；false 为按住说话
  keepMicWarm?: boolean // recording 时下发：结束后麦克风是否保持就绪一段时间（预录开头）
  micDeviceId?: string // recording 时下发：指定麦克风（空 = 自动：跳过虚拟设备，无声自动换）
  liveText?: string // 实时转写的文字（定稿部分 + 当前窗口预览，D-013）
  maxRecordingMs?: number // recording 时下发：最长录音时长，浮动条据此在最后 1 分钟倒计时（D-014）
}

// IPC 通道名（统一前缀 mt:）
export const IPC = {
  // 录音控制（renderer floating-bar → main）
  sessionStart: 'mt:session-start', // (mode?: FeatureMode)
  sessionStop: 'mt:session-stop',
  sessionCancel: 'mt:session-cancel',
  sessionGetState: 'mt:session-get-state', // 渲染端加载时拉取当前会话状态
  sessionAudioChunk: 'mt:session-audio-chunk', // 浮动条 → main：16kHz mono Int16 PCM 分片（约 250ms 一片）
  sessionAudioFinal: 'mt:session-audio-final', // 渲染端回应 captureFlush：尾部音频已全部送达
  captureFlush: 'mt:capture-flush', // main → floating-bar：停止前请冲刷 worklet 缓冲

  // 状态广播（main → renderers）
  stateChanged: 'mt:state-changed',
  answerCardUpdate: 'mt:answer-card-update', // ask 结果推送
  answerInsert: 'mt:answer-insert', // 浮卡"插入到光标"

  // 设置
  settingsGet: 'mt:settings-get',
  settingsSet: 'mt:settings-set',
  settingsSetKey: 'mt:settings-set-key', // { which: 'asr'|'llm', key: string }
  asrHealth: 'mt:asr-health', // 本地 whisper.cpp server 健康检查

  // 内置引擎模型
  modelList: 'mt:model-list',
  modelDownload: 'mt:model-download',
  modelCancel: 'mt:model-cancel',
  modelRemove: 'mt:model-remove',
  modelProgress: 'mt:model-progress', // main → hub：下载进度

  // 历史
  historyList: 'mt:history-list',
  historyDelete: 'mt:history-delete',
  historyCopy: 'mt:history-copy',
  historyClear: 'mt:history-clear',

  // 词典
  dictList: 'mt:dict-list',
  dictAdd: 'mt:dict-add',
  dictRemove: 'mt:dict-remove',
  dictChanged: 'mt:dict-changed', // main → hub：自动学习收录了新词

  // 系统
  openPermissionSettings: 'mt:open-permission-settings',
  checkPermissions: 'mt:check-permissions',
  windowClose: 'mt:window-close',
  openKeyboardSettings: 'mt:open-keyboard-settings',
  resetAccessibility: 'mt:reset-accessibility', // 清除本应用在“辅助功能”里的旧授权记录（旧签名），再引导重新授权
  barInteractive: 'mt:bar-interactive', // floating-bar → main：鼠标进入/离开胶囊（其余透明区域点击穿透）
  navigate: 'mt:navigate', // main → hub：切换到指定标签页（如 '#history'）
  historyStats: 'mt:history-stats', // 首页使用概览
  appInfo: 'mt:app-info', // 版本、构建号、提交
  updateGetState: 'mt:update-get-state',
  updateCheck: 'mt:update-check', // 手动检查新版本
  updateDownload: 'mt:update-download', // 用户确认后下载
  updateCancel: 'mt:update-cancel', // 取消下载
  updateInstall: 'mt:update-install', // 重启并安装（会议或听写进行中时拒绝）
  updateOpenDownload: 'mt:update-open-download', // 用浏览器打开安装包下载地址（自动安装失败时）
  updateState: 'mt:update-state', // main → hub：UpdateState

  // 会议模式（D-015）
  meetingStart: 'mt:meeting-start', // (opts: MeetingStartOptions)
  meetingPause: 'mt:meeting-pause',
  meetingResume: 'mt:meeting-resume',
  meetingStop: 'mt:meeting-stop', // ({ minutes?: boolean })：false = 只保存记录
  meetingRequestStop: 'mt:meeting-request-stop', // 浮动条：弹出系统对话框选择「生成纪要 / 只保存记录 / 取消」
  meetingGetLive: 'mt:meeting-get-live',
  meetingLive: 'mt:meeting-live', // main → 浮动条/主窗口：MeetingLive
  meetingChanged: 'mt:meeting-changed', // main → 主窗口：某场会议的内容有变化（meetingId）
  meetingCapture: 'mt:meeting-capture', // main → 浮动条：{ on: boolean, micDeviceId }
  meetingAudioChunk: 'mt:meeting-audio-chunk', // 浮动条 → main：会议录音分片（16kHz mono Int16）
  meetingList: 'mt:meeting-list',
  meetingGet: 'mt:meeting-get',
  meetingDelete: 'mt:meeting-delete',
  meetingSetTitle: 'mt:meeting-set-title',
  meetingRenameSpeaker: 'mt:meeting-rename-speaker', // (meetingId, speakerId, name, remember)
  meetingAssignSegment: 'mt:meeting-assign-segment', // (meetingId, segmentId, speakerId)
  meetingMergeSpeakers: 'mt:meeting-merge-speakers', // (meetingId, fromId, intoId)
  meetingSaveMinutes: 'mt:meeting-save-minutes',
  meetingRegenerate: 'mt:meeting-regenerate', // 重新生成纪要
  meetingSetExpected: 'mt:meeting-set-expected', // (id, n, track?)：改参会人数（现场 / 线上）并立即按新人数重新区分说话人
  meetingAudioApps: 'mt:meeting-audio-apps', // → { supported, apps }：可截取声音的应用（D-033）
  meetingPrepareAppAudio: 'mt:meeting-prepare-app-audio', // → 'ready' | 'waiting' | 'unsupported'：开会前先完成「录制系统音频」授权
  meetingFinish: 'mt:meeting-finish', // 整理异常中断的会议（id, { minutes?: boolean }）
  meetingExport: 'mt:meeting-export', // 导出 Markdown（保存对话框）
  voiceprintList: 'mt:voiceprint-list',
  voiceprintRename: 'mt:voiceprint-rename',
  voiceprintDelete: 'mt:voiceprint-delete',
  styleSampleList: 'mt:style-sample-list',
  styleSampleDelete: 'mt:style-sample-delete',
  styleSampleClear: 'mt:style-sample-clear',
  speakerModelAction: 'mt:speaker-model-action' // 设置页：声纹模型 download / cancel / remove
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
