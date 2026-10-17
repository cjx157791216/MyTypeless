import { BrowserWindow, clipboard, powerMonitor } from 'electron'
import { IPC, type SessionProgress, type FeatureMode } from '../shared/types'
import { createAsrProvider } from './providers/asr'
import { hasSpokenContent, LlmPolisher, llmTimeoutMs, localPreClean, type PolishTask } from './polish'
import { pcm16ToWav } from './wav'
import { getKey, loadSettings } from './config'
import { appendHistory, newRecord, listWords } from './history'
import { injectText, captureSelectedText } from './inject'
import { getFrontApp, getSelectedTextAX, type FrontAppInfo } from './native'
import { builtinReady, createBuiltinAsr, prewarmBuiltin } from './whisper'
import { LiveTranscriber, splitForTranscription } from './live'
import { isHallucination, joinText } from './text'
import { learnFrequentTerms, trackEdits } from './learner'
import { pasteShortcut } from '../shared/platform'

/**
 * 多模式会话状态机（M3）：
 * dictation  听写：口述 → 润色 → 注入光标
 * translate  翻译：说母语 → 译文 → 注入光标
 * rewrite    改写：抓选中文本 → 口述指令 → 改写结果替换选区
 * ask        提问：语音提问 → AI 回答 → 浮卡展示（不注入）
 *
 * 阶段：idle → starting(仅改写抓选区) → recording → stopping(等渲染端冲刷尾音) → processing → idle
 * 非 idle 时拒绝新会话，避免两次会话的状态/选区/音频互相串扰。
 * 注入前任意阶段都可取消（generation 失效后后续步骤静默放弃）。
 */

export type SessionEventSink = (progress: SessionProgress) => void

type Phase = 'idle' | 'starting' | 'recording' | 'stopping' | 'processing'

const SAMPLE_RATE = 16000
const MIN_SAMPLES = SAMPLE_RATE * 0.3
const FLUSH_TIMEOUT_MS = 700
/** 整段峰值低于此值视为没说话（约 -42 dBFS），避免把静音送去识别 */
const SILENCE_PEAK = 260

export class DictationSessionManager {
  private phase: Phase = 'idle'
  private gen = 0
  private mode: FeatureMode = 'dictation'
  private sourceText: string | null = null
  private handsFree = false
  private live: LiveTranscriber | null = null
  private liveText = ''
  private showLiveText = false // 本次录音是否在胶囊上显示识别中的文字（D-023）
  private front: Promise<FrontAppInfo> = Promise.resolve({})
  private startedAt = 0
  private pcmChunks: Int16Array[] = []
  private totalSamples = 0
  private maxTimer: NodeJS.Timeout | null = null
  private hitLimit = false
  private maxRecordingMs = 0
  private idleTimer: NodeJS.Timeout | null = null
  private flushWaiter: (() => void) | null = null
  private sink: SessionEventSink = () => {}
  private blocker: () => string | null = () => null
  lastProgress: SessionProgress = { state: 'idle' }

  onProgress(sink: SessionEventSink): void {
    this.sink = sink
  }

  /** 暂时不允许开始新会话（如会议进行中）：返回提示文字；null = 允许 */
  setBlocker(blocker: () => string | null): void {
    this.blocker = blocker
  }

  /** 正在录音（可被停止） */
  isActive(): boolean {
    return this.phase === 'recording'
  }

  /** 会话进行中（含抓选区/冲刷/识别/润色/注入），此时不接受新会话 */
  isBusy(): boolean {
    return this.phase !== 'idle'
  }

  /** 最近一次会话开始时的前台应用（ask 浮卡“插入到光标”时用来归还焦点） */
  frontApp(): Promise<FrontAppInfo> {
    return this.front
  }

  activeMode(): FeatureMode | null {
    return this.phase === 'starting' || this.phase === 'recording' ? this.mode : null
  }

  async start(mode: FeatureMode = 'dictation'): Promise<void> {
    if (this.phase !== 'idle') return
    const blocked = this.blocker()
    if (blocked) {
      this.emit({ state: 'error', error: blocked, mode })
      this.settleToIdle(2000)
      return
    }
    const gen = ++this.gen
    this.clearIdleTimer()
    this.phase = 'starting'
    this.mode = mode
    this.sourceText = null

    // 内置引擎：模型没下载就别让用户白说一段；已下载则趁说话期间预热引擎
    const startSettings = loadSettings()
    if (startSettings.asr.provider === 'builtin') {
      if (!builtinReady(startSettings)) {
        this.phase = 'idle'
        this.emit({ state: 'error', error: friendlyError(new Error('LOCAL_MODEL_MISSING')), errorCode: 'LOCAL_MODEL_MISSING', mode })
        this.settleToIdle(3000)
        return
      }
      prewarmBuiltin(startSettings)
    }
    // 前台应用在开口时就确定（后续用户切走窗口也不影响风格判断与历史归属）
    this.front = getFrontApp()

    // 改写模式：先抓选中文本（选中区在注入前一直保持）
    if (mode === 'rewrite') {
      const selected = await captureSelectedText()
      if (gen !== this.gen) return
      if (!selected) {
        this.phase = 'idle'
        this.emit({ state: 'error', error: '未捕获到选中文本：请先选中要改写的内容', mode })
        this.settleToIdle(2500)
        return
      }
      this.sourceText = selected
    }

    const settings = loadSettings()
    this.phase = 'recording'
    this.handsFree = false
    this.pcmChunks = []
    this.totalSamples = 0
    this.startedAt = Date.now()
    this.hitLimit = false
    // 先按“按住说话”开始：松键即结束，不做静音自动停止；轻按松开后由热键层切到免手持
    this.liveText = ''
    this.showLiveText = settings.showLiveText === true
    this.live = settings.asr.provider === 'builtin' ? this.createLive(gen, settings) : null
    this.maxRecordingMs = settings.maxRecordingMs
    this.emit({ state: 'recording', elapsedMs: 0, mode, autoStopMs: 0, handsFree: false, keepMicWarm: settings.keepMicWarm, micDeviceId: settings.micDeviceId ?? '', maxRecordingMs: this.maxRecordingMs })
    // 到达最长录音时长：照常结束并写入（浮动条在最后 1 分钟倒计时提醒）
    this.maxTimer = setTimeout(() => {
      this.hitLimit = true
      void this.stop()
    }, settings.maxRecordingMs)

    // 选中即改写（D-010）：与录音并行读取选区，不增加开口延迟；有选中文字则本次按改写处理
    if (mode === 'dictation') {
      void getSelectedTextAX().then((selected) => {
        if (!selected || gen !== this.gen || this.phase !== 'recording' || this.mode !== 'dictation') return
        this.mode = 'rewrite'
        this.sourceText = selected
        this.emitRecording()
      })
    }
  }

  /** 轻按开始：进入免手持（不用一直按着，再按一下结束）；只在录音中生效 */
  enterHandsFree(): void {
    if (this.phase !== 'recording' || this.handsFree) return
    this.handsFree = true
    this.emitRecording()
  }

  isHandsFree(): boolean {
    return this.phase === 'recording' && this.handsFree
  }

  private emitRecording(): void {
    // 只有免手持才可能启用静音自动停止（设置项，默认关）
    const autoStopMs = this.handsFree ? loadSettings().autoStopSilenceMs : 0
    this.emit({
      state: 'recording',
      elapsedMs: Date.now() - this.startedAt,
      mode: this.mode,
      autoStopMs,
      handsFree: this.handsFree,
      liveText: this.showLiveText ? this.liveText : '',
      maxRecordingMs: this.maxRecordingMs
    })
  }

  /** 实时转写（D-013）：边说边识别，停顿即识别，松手时多数情况下已有结果 */
  private createLive(gen: number, settings: ReturnType<typeof loadSettings>): LiveTranscriber {
    const words = listWords().map((w) => w.word)
    const asr = createBuiltinAsr(settings)
    // 说话不停时的限频预览只为显示文字；不显示时只在停顿处识别（松手等待同样很短）
    const previewGapMs = settings.showLiveText ? (powerMonitor.isOnBatteryPower() ? 4000 : 2500) : 0
    return new LiveTranscriber({
      previewGapMs,
      join: joinText,
      transcribe: async (pcm) => {
        const res = await asr.transcribe(pcm16ToWav(pcm, SAMPLE_RATE, 1), { vocabulary: words })
        const text = res.text.trim()
        return isHallucination(text) ? '' : text
      },
      onText: (text) => {
        if (gen !== this.gen || text === this.liveText) return
        this.liveText = text
        if (this.phase === 'recording' && this.showLiveText) this.emitRecording()
      }
    })
  }

  pushAudio(pcm: Int16Array): void {
    if (this.phase !== 'recording' && this.phase !== 'stopping') return
    this.pcmChunks.push(pcm)
    this.totalSamples += pcm.length
    this.live?.push(pcm)
  }

  /** 渲染端回应 captureFlush：尾部音频已全部送达 */
  audioFinal(): void {
    this.flushWaiter?.()
  }

  async stop(): Promise<void> {
    if (this.phase !== 'recording') return
    const gen = this.gen
    this.phase = 'stopping'
    this.cleanupTimer()
    const durationMs = Date.now() - this.startedAt

    // 让渲染端把 worklet 里不足一个分片的尾音送过来，否则最后几百毫秒（常是最后一个词）会丢
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, FLUSH_TIMEOUT_MS)
      this.flushWaiter = () => {
        clearTimeout(t)
        resolve()
      }
      this.broadcast(IPC.captureFlush)
    })
    this.flushWaiter = null
    if (gen !== this.gen) return

    const chunks = this.pcmChunks
    const total = this.totalSamples
    this.pcmChunks = []
    this.totalSamples = 0
    this.phase = 'processing'
    await this.process(gen, chunks, total, durationMs)
    if (gen === this.gen) this.phase = 'idle'
  }

  cancel(): void {
    if (this.phase === 'idle') return
    const mode = this.mode
    this.gen++
    this.phase = 'idle'
    this.cleanupTimer()
    this.flushWaiter?.()
    this.flushWaiter = null
    this.pcmChunks = []
    this.totalSamples = 0
    this.live = null
    this.liveText = ''
    this.emit({ state: 'idle', mode })
  }

  private async process(gen: number, chunks: Int16Array[], total: number, durationMs: number): Promise<void> {
    const mode = this.mode
    const sourceText = this.sourceText
    const stale = () => gen !== this.gen

    if (total < MIN_SAMPLES) {
      this.emit({ state: 'idle', mode })
      return
    }
    const merged = new Int16Array(total)
    let offset = 0
    let peak = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
      for (let i = 0; i < c.length; i++) {
        const v = c[i] < 0 ? -c[i] : c[i]
        if (v > peak) peak = v
      }
    }
    if (peak < SILENCE_PEAK) {
      this.emit({ state: 'error', error: '没有检测到声音：请检查麦克风或靠近一点说', mode })
      this.settleToIdle(2000)
      return
    }

    try {
      const settings = loadSettings()
      const words = listWords().map((w) => w.word)

      // 1) ASR
      const live = this.live
      this.live = null
      // 整段识别：长录音切成不超过 5 分钟的若干段（云端上传有大小限制，本地单次请求也不会超时）
      const wholeFile = async () => {
        const builtin = settings.asr.provider === 'builtin'
        const asr = builtin ? createBuiltinAsr(settings) : createAsrProvider(settings, getKey('asr'))
        const once = ([a, b]: [number, number]) => asr.transcribe(pcm16ToWav(merged.subarray(a, b), SAMPLE_RATE, 1), { vocabulary: words }).then((r) => r.text)
        const parts = splitForTranscription(merged)
        // 本地引擎一次只能算一段（并发只会排队超时）；云端各段并行
        const texts = builtin ? await sequential(parts, once) : await Promise.all(parts.map(once))
        return texts.reduce(joinText, '')
      }
      let rawText: string
      if (live) {
        // 最后一句在停顿时已识别过则无需等待；否则只补识别当前窗口
        if (live.finalRequestNeeded()) this.emit({ state: 'transcribing', elapsedMs: durationMs, mode, liveText: this.showLiveText ? this.liveText : '' })
        rawText = await live.finish().catch(wholeFile)
      } else {
        this.emit({ state: 'transcribing', elapsedMs: durationMs, mode })
        rawText = await wholeFile()
      }
      if (stale()) return
      // 没有实际内容（空、幻觉、只有语气词）时不调用 LLM，也不写入
      if (!rawText || isHallucination(rawText) || !hasSpokenContent(rawText)) {
        this.emit({ state: 'error', error: '没有识别到内容', mode })
        this.settleToIdle(1800)
        return
      }

      const front = await this.front
      const category = guessAppCategory(front.name ?? front.bundleId)
      // 只有确实要调用 LLM 时才读 Key（读 Key 会访问钥匙串）
      const needsLlm = mode !== 'dictation' || settings.polishEnabled
      const polisher = new LlmPolisher(settings, needsLlm ? getKey('llm') : '', llmTimeoutMs(rawText.length))

      // 2) 按模式处理
      let finalText = rawText
      let notice: string | undefined
      // 到达上限自动结束只是提示，不算出错（不写进历史的错误信息）
      const limitNotice = this.hitLimit ? `已到最长录音时长（${Math.round(this.maxRecordingMs / 60_000)} 分钟），已自动结束` : undefined
      this.emit({ state: 'polishing', rawText, elapsedMs: durationMs, mode })
      if (mode === 'dictation') {
        if (settings.polishEnabled) {
          try {
            finalText = await polisher.dispatch(rawText, { task: 'polish', appCategoryHint: category, words })
          } catch (err) {
            // 听写绝不因润色失败而丢字：回退本地清理继续写入
            finalText = localPreClean(rawText)
            notice = `润色失败，已使用本地清理（${friendlyError(err)}）`
          }
        }
      } else {
        if (!polisher.hasKey()) throw new Error('LLM_API_KEY_MISSING')
        let task: PolishTask
        if (mode === 'translate') task = { task: 'translate', targetLanguage: settings.translateTarget, words }
        else if (mode === 'rewrite') task = { task: 'rewrite', sourceText: sourceText ?? '', appCategoryHint: category, words }
        else task = { task: 'ask' }
        finalText = await polisher.dispatch(rawText, task)
      }
      if (stale()) return

      // 3) 结果投递
      if (mode === 'ask') {
        this.emit({ state: 'done', polishedText: finalText, rawText, elapsedMs: durationMs, mode, notice: limitNotice })
        this.record({ mode, rawText, finalText, durationMs, front })
        this.settleToIdle(limitNotice ? 2500 : 1200)
        return
      }

      this.emit({ state: 'injecting', polishedText: finalText, elapsedMs: durationMs, mode })
      const injectRes = await injectText(finalText, settings.injectMethod)
      let error: string | undefined
      if (!injectRes.ok) {
        // 写入失败时结果留在剪贴板，用户可以手动粘贴，内容不丢
        clipboard.writeText(finalText)
        error = `写入失败，结果已复制到剪贴板（${pasteShortcut(process.platform)} 粘贴）`
      }
      this.record({ mode, rawText, finalText, durationMs, front, sourceText: sourceText ?? undefined, error: error ?? notice })
      if (injectRes.ok && (mode === 'dictation' || mode === 'rewrite')) this.learn(finalText, front, settings)
      this.emit({
        state: injectRes.ok ? 'done' : 'error',
        polishedText: finalText,
        rawText,
        elapsedMs: durationMs,
        mode,
        error,
        notice: [limitNotice, notice].filter(Boolean).join('；') || undefined
      })
      // 写入成功后浮动条尽快消失（D-010）；有提示或出错时多停留一会儿
      this.settleToIdle(notice || limitNotice ? 2500 : injectRes.ok ? 350 : 3000)
    } catch (err) {
      if (stale()) return
      const code = err instanceof Error ? err.message.match(/^[A-Z_]+/)?.[0] : undefined
      this.emit({ state: 'error', error: friendlyError(err), errorCode: code, mode })
      this.settleToIdle(3000)
    }
  }

  /** 自动词典（D-012）：常用专有名词计数；写入后追踪修改 */
  private learn(finalText: string, front: FrontAppInfo, settings: ReturnType<typeof loadSettings>): void {
    const notify = (terms: string[]) => this.broadcast(IPC.dictChanged, terms)
    try {
      if (settings.learnFrequentTerms) {
        const learned = learnFrequentTerms(finalText)
        if (learned.length) notify(learned)
      }
      if (settings.learnFromEdits) trackEdits(finalText, front.pid, notify)
    } catch (err) {
      console.warn('[learn] failed:', err)
    }
  }

  private record(r: {
    mode: FeatureMode
    rawText: string
    finalText: string
    durationMs: number
    front: FrontAppInfo
    sourceText?: string
    error?: string
  }): void {
    try {
      appendHistory(
        newRecord({
          durationMs: r.durationMs,
          rawText: r.rawText,
          polishedText: r.finalText,
          appName: r.front.name,
          appBundleId: r.front.bundleId,
          mode: r.mode,
          status: r.error ? 'error' : 'completed',
          error: r.error,
          sourceText: r.sourceText
        })
      )
    } catch (err) {
      console.warn('[history] append failed:', err)
    }
  }

  /** 结果展示一会儿后回到 idle（期间若开始了新会话则不打扰） */
  private settleToIdle(ms: number): void {
    this.clearIdleTimer()
    const gen = this.gen
    this.idleTimer = setTimeout(() => {
      if (gen === this.gen && this.phase === 'idle') this.emit({ state: 'idle', mode: this.mode })
    }, ms)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private cleanupTimer(): void {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
  }

  private broadcast(channel: string, payload?: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  private emit(progress: SessionProgress): void {
    this.lastProgress = progress
    this.sink(progress)
    this.broadcast(IPC.stateChanged, progress)
  }
}

/** 把内部错误码翻译成用户看得懂的提示 */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''
  if (msg.startsWith('ASR_API_KEY_MISSING')) return '未配置语音识别 API Key（主窗口 → 设置）'
  if (msg.startsWith('LOCAL_MODEL_MISSING')) return '尚未下载语音模型：已打开主窗口，点击“下载”即可（只需一次）'
  if (msg.startsWith('LOCAL_ENGINE_MISSING')) return '内置识别引擎缺失，请重新安装 MyTypeless'
  if (msg.startsWith('LOCAL_ENGINE_TIMEOUT')) return '本地识别引擎启动超时，请重试'
  if (msg.startsWith('LOCAL_ENGINE_FAILED')) return `本地识别引擎启动失败：${msg.replace(/^LOCAL_ENGINE_FAILED:\s*/, '').slice(0, 120)}`
  if (msg.startsWith('LLM_API_KEY_MISSING')) return '该功能需要配置润色 LLM 的 API Key（主窗口 → 设置）'
  if (name === 'TimeoutError' || /timeout|timed out/i.test(msg)) return '请求超时：请检查网络或服务地址'
  if (name === 'AbortError') return '请求被中止'
  const http = msg.match(/^(LOCAL_ASR|ASR|LLM)_HTTP_(\d{3})/)
  if (http) {
    const who = http[1] === 'LLM' ? '润色服务' : http[1] === 'LOCAL_ASR' ? '本地识别引擎' : '语音识别服务'
    const code = Number(http[2])
    if (code === 401 || code === 403) return `${who}：API Key 无效或无权限（${code}）`
    if (code === 404) return `${who}：地址或模型名不正确（404）`
    if (code === 429) return `${who}：请求过于频繁或额度不足（429）`
    if (code >= 500) return `${who}暂时不可用（${code}）`
    return `${who}请求失败（${code}）`
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(msg)) {
    return '无法连接服务：请检查网络，或确认本地引擎已启动'
  }
  if (msg === 'LLM_EMPTY_RESPONSE') return '润色服务返回了空结果'
  return msg.slice(0, 160)
}

export function guessAppCategory(appName?: string): string | undefined {
  if (!appName) return undefined
  const n = appName.toLowerCase()
  const table: Array<[RegExp, string]> = [
    [/code|cursor|zed|xcode|sublime|nova|fleet|terminal|iterm|warp|ghostty|jetbrains|intellij|pycharm|webstorm/, 'code'],
    [/slack|wechat|微信|qq|telegram|whatsapp|discord|钉钉|dingtalk|飞书|lark|teams|messages|信息/, 'im'],
    [/mail|outlook|spark|邮件/, 'email'],
    [/notion|obsidian|word|pages|docs|typora|bear|ulysses|notes|备忘录|craft|logseq/, 'docs']
  ]
  for (const [re, cat] of table) if (re.test(n)) return cat
  return undefined
}

async function sequential<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (const item of items) out.push(await fn(item))
  return out
}
