// preload 暴露给渲染端的 API 类型（与 src/preload/index.ts 保持一致）
import type {
  AppInfo,
  AudioApp,
  FeatureMode,
  HistoryRecord,
  HistoryStats,
  MeetingDetail,
  MeetingLive,
  MeetingStartOptions,
  MeetingSummary,
  MeetingTrack,
  ModelInfo,
  ModelProgress,
  UpdateState,
  SessionProgress,
  Settings,
  Voiceprint
} from './types'

export interface AnswerPayload {
  question: string
  answer: string
  pending?: boolean
  error?: string
}

export interface PermissionStatus {
  accessibility: boolean
  microphone: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | string
  nativeHotkey: boolean // 原生快捷键助手是否在运行（否则为 globalShortcut 兜底，按住说话不可用）
  permissionHost?: string // 开发模式下实际持有系统权限的应用（启动 npm run dev 的终端），打包版为空
  fnKeyConflict: boolean // 快捷键用到 Fn，但系统「按下 🌐 键时」不是「无操作」（会弹表情面板/切输入法）
}

export interface MyTypelessBridge {
  platform: string // process.platform：darwin / win32 …
  session: {
    start(mode?: FeatureMode): Promise<void>
    stop(): Promise<void>
    cancel(): Promise<void>
    getState(): Promise<SessionProgress>
    pushAudio(buf: ArrayBuffer): Promise<void>
    audioFinal(): Promise<void>
    onFlush(cb: () => void): () => void
    onStateChanged(cb: (p: SessionProgress) => void): () => void
    onAnswer(cb: (a: AnswerPayload) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    setKey(which: 'asr' | 'llm', key: string): Promise<{ ok: boolean; masked: string }>
    asrHealth(baseUrl?: string): Promise<{ ok: boolean; detail?: string }>
    /** 测试 LLM 设置是否连通：apiKey 为空时用已保存的 Key → 成功时 ms 为到第一段输出的耗时，失败时 error 为原因 */
    llmTest(cfg: { baseUrl: string; model: string; apiKey?: string }): Promise<{ ok: boolean; ms?: number; error?: string }>
  }
  models: {
    list(): Promise<ModelInfo[]>
    download(id: string): Promise<void>
    cancel(id: string): Promise<void>
    remove(id: string): Promise<ModelInfo[]>
    onProgress(cb: (p: ModelProgress) => void): () => void
  }
  history: {
    list(limit?: number, offset?: number): Promise<HistoryRecord[]>
    remove(id: string): Promise<void>
    copy(id: string): Promise<boolean>
    clear(): Promise<void>
    stats(): Promise<HistoryStats>
  }
  dict: {
    list(): Promise<Array<{ word: string; source: string }>>
    add(word: string): Promise<Array<{ word: string; source: string }>>
    remove(word: string): Promise<Array<{ word: string; source: string }>>
    onChanged(cb: (terms: string[]) => void): () => void
  }
  meeting: {
    start(opts?: MeetingStartOptions): Promise<{ ok: boolean; error?: string; meetingId?: string }>
    pause(): Promise<void>
    resume(): Promise<void>
    stop(opts?: { minutes?: boolean }): Promise<void>
    requestStop(): Promise<void>
    getLive(): Promise<MeetingLive>
    pushAudio(buf: ArrayBuffer): Promise<void>
    list(): Promise<MeetingSummary[]>
    get(id: string): Promise<MeetingDetail | null>
    remove(id: string): Promise<boolean>
    setTitle(id: string, title: string): Promise<void>
    renameSpeaker(id: string, speakerId: number, name: string, remember: boolean): Promise<{ remembered: boolean }>
    assignSegment(id: string, segmentId: number, speakerId: number | 'new'): Promise<void>
    mergeSpeakers(id: string, from: number, into: number): Promise<void>
    saveMinutes(id: string, markdown: string): Promise<void>
    regenerate(id: string): Promise<{ ok: boolean; error?: string }>
    finish(id: string, opts?: { minutes?: boolean }): Promise<{ ok: boolean; error?: string }>
    /** 改某一路（0 = 现场 / 1 = 线上，默认 0）的人数并立即重新区分说话人 */
    setExpected(id: string, n: number, track?: MeetingTrack): Promise<{ ok: boolean; error?: string }>
    /** 可截取声音的应用（D-033）；supported = false 表示系统低于 macOS 14.2 */
    audioApps(): Promise<{ supported: boolean; apps: AudioApp[] }>
    /** 开会前先完成「录制系统音频」授权；waiting = 系统授权框还没回应 */
    prepareAppAudio(): Promise<'ready' | 'waiting' | 'unsupported'>
    exportMarkdown(id: string): Promise<boolean>
    onLive(cb: (live: MeetingLive) => void): () => void
    onChanged(cb: (meetingId: string) => void): () => void
    onCapture(cb: (c: { on: boolean; micDeviceId: string }) => void): () => void
  }
  voiceprints: {
    list(): Promise<Voiceprint[]>
    rename(id: number, name: string): Promise<Voiceprint[]>
    remove(id: number): Promise<Voiceprint[]>
    /** 声纹模型：下载 / 取消 / 删除；状态经 meeting.onLive 的 speakerModel 推送 */
    model(action: 'download' | 'cancel' | 'remove'): Promise<{ ok: boolean; error?: string }>
  }
  system: {
    checkPermissions(): Promise<PermissionStatus>
    appInfo(): Promise<AppInfo>
    openPermissionSettings(): Promise<void>
    closeWindow(): void
    openKeyboardSettings(): Promise<void>
    resetAccessibility(): Promise<boolean>
    setBarInteractive(interactive: boolean): void
    answerInsert(text: string): Promise<boolean>
    onNavigate(cb: (anchor: string) => void): () => void
  }
  /** 在线更新（D-028）：状态经 onState 推送 */
  update: {
    getState(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    cancel(): Promise<UpdateState>
    /** 重启并安装；会议或听写进行中时返回 { ok: false, error } */
    install(): Promise<{ ok: boolean; error?: string }>
    openDownload(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
}

declare global {
  interface Window {
    mytypeless: MyTypelessBridge
  }
}

export {}
