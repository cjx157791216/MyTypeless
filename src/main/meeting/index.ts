import { app, powerMonitor } from 'electron'
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import type { MeetingLive, MeetingSource, MeetingStartOptions, MeetingTrack } from '../../shared/types'
import { markSpeakerNames } from '../../shared/speaker-mentions'
import { getKey, hasKey, loadSettings, saveSettings } from '../config'
import { listWords } from '../history'
import { SAMPLE_RATE } from '../live'
import { LlmPolisher } from '../polish'
import { createAsrProvider, type AsrProvider } from '../providers/asr'
import { isHallucination } from '../text'
import { pcm16ToWav } from '../wav'
import { builtinReady, createBuiltinAsr, prewarmBuiltin } from '../whisper'
import {
  AUTO_SPEAKERS,
  MIN_EMBED_MS,
  OnlineClusterer,
  PRINT_KEEP,
  PRINT_MATCH,
  PRINT_MIN_SEGMENTS,
  WINDOW_HOP_MS,
  WINDOW_MIN_PART_MS,
  WINDOW_MS,
  blendVoiceprint,
  identifySpeakers,
  mergeAdjacentParts,
  printScore,
  regroup,
  splitByWindows,
  type ClusterItem,
  type VoicedPart
} from './cluster'
import { AppAudioCapture, appAudioSupported, appAudioUnsupportedHint, prepareAppAudio, type AppAudioEvent } from './app-audio'
import { denoiser, diarizer, speakerModel } from './diarizer'
import { ECHO_AHEAD_FRAMES, ECHO_LEAD_FRAMES, removeEcho } from './echo'
import { normalizeLoudness } from './enhance'
import { buildTranscript, cleanMinutesBody, generateMinutesBody, minutesHeader } from './minutes'
import {
  MEETING_VAD,
  denoiseLagging,
  overloaded,
  MEETING_VAD_DENOISED,
  UtteranceSegmenter,
  alignPad,
  planFeed,
  samplesToMs,
  splitByTurns,
  turnsInUtterance,
  type Part,
  type Utterance
} from './segmenter'
import * as store from './store'

/**
 * 会议编排（D-015、D-016）：
 * 录音（浮动条采集）→ 写入临时文件 + 边录边降噪（D-024）→ 按停顿分句 → 每句：本地识别（降噪后的声音，音量归一；串行，与听写共用引擎）
 * + 声纹（原始录音，mt-diarize，串行）
 * → 在线归类说话人 → 定稿即落库 → 结束时整场重新归类 → LLM 生成纪要 → 删除临时录音。
 * 识别与声纹各自同一时刻只有一个请求；声纹进程低优先级，不影响其他工作。
 * 线上会议（D-033）：声音来源可选只用麦克风 / 麦克风 + 会议软件的声音 / 只用会议软件的声音。每一路（Track）各自写临时录音、
 * 分句、区分说话人（各有人数），两路对齐到同一条时间线（alignPad）；麦克风那一路先去掉外放的回声（removeEcho）再识别。
 */

const MAX_MEETING_MS = 4 * 3600_000
const WARN_BEFORE_MS = 5 * 60_000
const NOTICE_TTL_MS = 6000
/** 短于此的句子不做句内换人检测（容不下两个各 1 秒以上的发言） */
const MIN_SPLIT_MS = 2000
const DENOISE_BATCH = SAMPLE_RATE / 2 // 每攒够 0.5 秒送去降噪一次
const KNOWN_MIN_SEGMENTS = 2 // 每人至少说过这么多句，才按窗口与各人比较找换人位置
/** 会议进行中整体重新区分说话人的间隔 */
const REGROUP_EVERY_MS = 20_000
const MAX_SPEAKERS = 10 // 参会人数选项的上限（与主窗口的选择框一致）
/** 句内换人检测带上的参考录音长度（8 秒：真人录音实测与 10、15 秒结果相同，更省 CPU） */
const TURN_CONTEXT_SAMPLES = SAMPLE_RATE * 8
const ECHO_LEAD = ECHO_LEAD_FRAMES * (SAMPLE_RATE / 50)
const ECHO_AHEAD = ECHO_AHEAD_FRAMES * (SAMPLE_RATE / 50)

/** 会议录音的一路（D-033）：麦克风（现场，track 0）或应用声音（线上，track 1） */
interface Track {
  track: MeetingTrack
  audioPath: string
  fd: number
  written: number // 已写入的样本数（= 会议时间线位置）
  segmenter: UtteranceSegmenter
  clusterer: OnlineClusterer
  denoise: boolean // 本路是否边录边降噪（只有麦克风；开会时降噪模型已就绪）
  denoiseStopped?: boolean // 降噪跟不上、会议中途改用原始录音分句（之前分出的句子仍是降噪后的声音）
  dnChain: Promise<void> // 降噪与分句（按录音顺序串行）
  dnSent: number // 已送去降噪的样本数
  segFed: number // 已送入分句的样本数（降噪输出或原始录音）
  expected: number // 这一路的人数：会中最多分出这么多人（D-021）；AUTO_SPEAKERS = 按声音判断（D-042）
  autoCap: number // 自动人数时会中在线归类最多分出的人数：上次整体归类的人数 + 1（新来的人先单独成组，等下次整体归类确认）
  failed: Array<[number, number]> // 识别失败的句子（结束时重试）
  lastSpeaker: number | null
  newSegments: number // 上次整体重新归类之后新增的段数
  capture: AppAudioCapture | null // 应用声音的截取进程（只有 track 1）
}

interface Active {
  id: string
  title: string
  source: MeetingSource
  appName: string
  tracks: Track[]
  prints: Array<{ id: number; name: string; samples: number; vector: Float32Array }>
  embeddings: Map<number, Float32Array> // 句子 id → 声音特征（只在内存，整理完丢弃）
  asr: AsrProvider
  words: string[]
  asrChain: Promise<void>
  diarChain: Promise<unknown>
  paused: boolean
  elapsedBefore: number // 之前各段的录音时长
  runningSince: number // 本段开始的时间（暂停时为 0）
  warned: boolean
  ticker: NodeJS.Timeout
  lastRegroupAt: number
  embedOk: number // 声纹计算成功 / 失败次数：一直失败时提示，不再悄悄全部“未区分”
  embedFailed: number
  echoNoticed: boolean // 已提示过外放回声
  pending: number // 已分出、还没识别完的句子数（积压）
  overloadNoticed: boolean // 已提示过电脑忙、降级处理
}

export interface MeetingHooks {
  /** 实时状态（浮动条、主窗口） */
  onLive(live: MeetingLive): void
  /** 某场会议内容有变化（主窗口刷新） */
  onChanged(meetingId: string): void
  /** 开/关浮动条的会议采集 */
  setCapture(on: boolean, micDeviceId: string): void
}

export class MeetingManager {
  private active: Active | null = null
  private processing: { id: string; stage: string } | null = null
  /** 纪要已完成的请求结果（按会议）：生成失败后重试只补没完成的段；生成成功或删除会议时清掉 */
  private minutesCache = new Map<string, Map<string, string>>()
  private notice: { text: string; until: number } | null = null
  private hooks: MeetingHooks

  constructor(hooks: MeetingHooks) {
    this.hooks = hooks
    speakerModel.onChange = () => this.emit()
    powerMonitor.on('on-battery', () => {
      if (this.active) this.flash('正在使用电池：长时间会议建议接上电源')
    })
  }

  /** 会议录音中（含暂停）：期间 Fn 听写暂停 */
  isActive(): boolean {
    return !!this.active
  }

  live(): MeetingLive {
    const model = speakerModel.state()
    const base = { speakerModel: model, speakerModelProgress: model === 'downloading' ? speakerModel.progress : undefined }
    const notice = this.notice && this.notice.until > Date.now() ? this.notice.text : undefined
    const a = this.active
    if (a) {
      return {
        ...base,
        state: a.paused ? 'paused' : 'recording',
        meetingId: a.id,
        title: a.title,
        elapsedMs: this.elapsed(a),
        running: !a.paused,
        notice
      }
    }
    if (this.processing) return { ...base, state: 'processing', meetingId: this.processing.id, stage: this.processing.stage, notice }
    return { ...base, state: 'idle', notice }
  }

  private starting = false

  async start(opts: MeetingStartOptions = {}): Promise<{ ok: boolean; error?: string; meetingId?: string }> {
    if (this.active || this.starting) return { ok: false, error: '已有会议在进行中' }
    this.starting = true
    try {
      return await this.startNow(opts)
    } finally {
      this.starting = false
    }
  }

  private async startNow(opts: MeetingStartOptions): Promise<{ ok: boolean; error?: string; meetingId?: string }> {
    if (this.processing) return { ok: false, error: '上一场会议还在整理中，请稍候' }
    const settings = loadSettings()
    const source: MeetingSource = opts.source ?? settings.meetingSource ?? 'mic'
    if (source !== 'mic' && !appAudioSupported()) return { ok: false, error: `${appAudioUnsupportedHint()}；可以改为只用麦克风` }
    // 先完成「录制系统音频」授权（允许后系统会重新打开 MyTypeless，不能等到会议中途）
    if (source !== 'mic' && (await prepareAppAudio()) === 'waiting') {
      return { ok: false, error: '请先在系统弹出的对话框里允许 MyTypeless 录制系统音频（允许后 MyTypeless 会自动重新打开），然后再开始会议' }
    }
    let asr: AsrProvider
    if (settings.asr.provider === 'builtin') {
      if (!builtinReady(settings)) return { ok: false, error: '还没有下载语音识别模型：请先在设置 → 语音识别里下载' }
      asr = createBuiltinAsr(settings)
      prewarmBuiltin(settings)
    } else {
      asr = createAsrProvider(settings, getKey('asr'))
    }
    const models = speakerModel.ensure() // 首次开会时下载声纹模型；下载完成前的句子之后补做
    // 已有声纹模型、只缺降噪模型（约 0.5MB，D-024）：等一会儿，下好了本场就能边录边降噪
    if (source !== 'app' && speakerModel.ready() && !speakerModel.denoiserReady()) await Promise.race([models, new Promise((r) => setTimeout(r, 5000))])

    const dir = join(app.getPath('userData'), 'meetings')
    mkdirSync(dir, { recursive: true })
    const startedAt = Date.now()
    const title = opts.title?.trim() || defaultTitle(startedAt)
    const expected = speakerCount(opts.expectedSpeakers ?? settings.meetingSpeakers)
    const expectedRemote = speakerCount(opts.expectedRemote ?? settings.meetingRemoteSpeakers)
    const appBundleId = source === 'mic' ? '' : (opts.appBundleId ?? settings.meetingApp ?? '')
    const appName = source === 'mic' ? '' : opts.appName?.trim() || (appBundleId ? appBundleId : '系统声音')
    saveSettings({
      meetingSource: source,
      ...(source !== 'app' ? { meetingSpeakers: expected } : {}),
      ...(source !== 'mic' ? { meetingRemoteSpeakers: expectedRemote, meetingApp: appBundleId } : {})
    })
    const micPath = source !== 'app' ? join(dir, `${startedAt}.pcm`) : null
    const appPath = source !== 'mic' ? join(dir, `${startedAt}-app.pcm`) : null
    const id = store.createMeeting({
      title,
      startedAt,
      expectedSpeakers: source !== 'app' ? expected : null,
      audioPath: micPath,
      source,
      appAudioPath: appPath,
      appName: appName || null,
      expectedRemote: source !== 'mic' ? expectedRemote : null
    })
    const denoise = speakerModel.denoiserReady()
    const newTrack = (track: MeetingTrack, path: string, n: number): Track => ({
      track,
      audioPath: path,
      fd: openSync(path, 'a'),
      written: 0,
      // 应用声音是会议软件解码后的干净人声，不降噪（流式降噪器只有一个状态，留给麦克风）
      segmenter: new UtteranceSegmenter(track === 0 && denoise ? MEETING_VAD_DENOISED : MEETING_VAD),
      clusterer: new OnlineClusterer(),
      denoise: track === 0 && denoise,
      dnChain: Promise.resolve(),
      dnSent: 0,
      segFed: 0,
      expected: n,
      autoCap: 2,
      failed: [],
      lastSpeaker: null,
      newSegments: 0,
      capture: null
    })
    const tracks: Track[] = []
    if (micPath) tracks.push(newTrack(0, micPath, expected))
    if (appPath) tracks.push(newTrack(1, appPath, expectedRemote))
    const a: Active = {
      id,
      title,
      source,
      appName,
      tracks,
      prints: store.voiceprintVectors(),
      embeddings: new Map(),
      asr,
      words: listWords().map((w) => w.word),
      asrChain: Promise.resolve(),
      diarChain: Promise.resolve(),
      paused: false,
      elapsedBefore: 0,
      runningSince: Date.now(),
      warned: false,
      ticker: setInterval(() => this.tick(), 1000),
      lastRegroupAt: Date.now(),
      embedOk: 0,
      embedFailed: 0,
      echoNoticed: false,
      pending: 0,
      overloadNoticed: false
    }
    this.active = a
    this.startCapture(a, appBundleId)
    if (source === 'mixed') this.flash('建议戴耳机：外放时对方的声音会被麦克风再录一遍（重复的部分会自动去掉）', 10_000)
    else if (powerMonitor.isOnBatteryPower()) this.flash('正在使用电池：长时间会议建议接上电源')
    this.emit()
    this.hooks.onChanged(id)
    return { ok: true, meetingId: id }
  }

  /** 开始 / 继续采集：麦克风经浮动条，应用声音经 mt-audiotap */
  private startCapture(a: Active, appBundleId?: string): void {
    if (this.track(a, 0)) this.hooks.setCapture(true, loadSettings().micDeviceId ?? '')
    const t = this.track(a, 1)
    if (!t) return
    const bundle = appBundleId ?? (a.source === 'mic' ? '' : loadSettings().meetingApp ?? '')
    t.capture = new AppAudioCapture(bundle, (pcm) => this.pushTrack(a, t, pcm), (e) => this.onAppAudio(a, e))
    t.capture.start()
  }

  private stopCapture(a: Active): void {
    if (this.track(a, 0)) this.hooks.setCapture(false, '')
    const t = this.track(a, 1)
    t?.capture?.stop()
    if (t) t.capture = null
  }

  private onAppAudio(a: Active, e: AppAudioEvent): void {
    if (this.active !== a) return
    const name = a.appName === '系统声音' ? '系统' : `「${a.appName}」`
    if (e.type === 'waiting-permission') this.flash(`请在系统弹出的对话框里允许 MyTypeless 录制系统音频，才能转写${name}里对方的声音`, 30_000)
    else if (e.type === 'ready' && this.notice?.text.includes('录制系统音频')) this.notice = null
    else if (e.type === 'silent')
      this.flash(process.platform === 'darwin' ? `一直没有收到${name}的声音：如果对方在说话，请到 系统设置 → 隐私与安全性 → 录屏与系统录音，在「仅系统录音」里允许 MyTypeless` : `一直没有收到${name}的声音：如果对方在说话，请确认${name}正在播放声音、没有被静音（Windows 截取的是它播放出来的声音）`, 20_000)
    else if (e.type === 'failed') this.flash(`无法截取${name}的声音（${e.error}）${a.source === 'mixed' ? '，本场先只用麦克风' : ''}`, 15_000)
    this.emit()
  }

  private track(a: Active, track: MeetingTrack): Track | undefined {
    return a.tracks.find((t) => t.track === track)
  }

  /** 浮动条送来的麦克风录音分片 */
  pushAudio(pcm: Int16Array): void {
    const a = this.active
    const t = a && this.track(a, 0)
    if (a && t) this.pushTrack(a, t, pcm)
  }

  /** 某一路的录音分片：写入临时录音 → 降噪（麦克风）/ 直接分句 */
  private pushTrack(a: Active, t: Track, pcm: Int16Array): void {
    if (this.active !== a || a.paused || !pcm.length) return
    // 两路时：按真实时间对齐到同一条时间线（采集晚到、进程重启的缺口补静音）
    if (a.tracks.length > 1) {
      const pad = alignPad(t.written, pcm.length, Math.round((this.elapsed(a) / 1000) * SAMPLE_RATE))
      if (pad > 0) this.writeTrack(t, new Int16Array(pad))
    }
    this.writeTrack(t, pcm)
  }

  private writeTrack(t: Track, pcm: Int16Array): void {
    const a = this.active!
    try {
      writeSync(t.fd, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    } catch (err) {
      console.warn('[meeting] write audio failed:', err)
    }
    t.written += pcm.length
    if (t.denoise && denoiseLagging(t.written, t.segFed)) this.stopDenoising(a, t)
    if (!t.denoise) {
      if (t.segFed + pcm.length === t.written) {
        for (const u of t.segmenter.push(pcm)) this.onUtterance(a, t, u)
        t.segFed = t.written
      } else {
        // 降噪排队中途停用：接在队尾、从临时录音读原始音频送入分句，保证时间线顺序
        const upTo = t.written
        t.dnChain = t.dnChain.then(() => this.feedSegmenter(a, t, null, upTo))
      }
      return
    }
    if (t.written - t.dnSent >= DENOISE_BATCH) this.sendToDenoiser(a, t)
  }

  /**
   * 降噪（低优先级）跟不上录音：这一路改用原始录音分句（换回原始录音的 VAD 门槛），排队中还没降噪的部分也直接用原始录音。
   * 慢 CPU 上开会时 CPU 被识别与会议软件占满，降噪进程分不到时间，整路分不出句子、实时转写停住，结束后还要补完全部积压
   */
  private stopDenoising(a: Active, t: Track): void {
    t.denoise = false
    t.denoiseStopped = true
    t.segmenter.useVad(MEETING_VAD)
    console.warn('[meeting] denoiser lagging, track', t.track, 'falls back to raw audio')
    this.noticeOverload(a)
  }

  private noticeOverload(a: Active): void {
    if (a.overloadNoticed) return
    a.overloadNoticed = true
    this.flash('电脑较忙：已简化降噪与说话人细分，优先保证实时转写', 10_000)
  }

  /** 把还没送出的录音送去降噪，结果按顺序送入分句（D-024） */
  private sendToDenoiser(a: Active, t: Track): void {
    const start = t.dnSent
    const count = t.written - start
    if (count <= 0) return
    t.dnSent = t.written
    t.dnChain = t.dnChain.then(async () =>
      this.feedSegmenter(a, t, t.denoise ? await denoiser.denoiseFeed(t.audioPath, start, count).catch(() => null) : null, start + count)
    )
  }

  /** 暂停、结束：送出剩余录音、取回降噪器里剩下的部分、结束正在说的一句；返回分出的句子都已交给 onUtterance 的 Promise */
  private drainSegmenter(a: Active): Promise<void> {
    return Promise.all(
      a.tracks.map((t) => {
        if (t.denoise) {
          this.sendToDenoiser(a, t)
          t.dnChain = t.dnChain.then(async () => this.feedSegmenter(a, t, await denoiser.denoiseFlush().catch(() => null), t.dnSent))
        }
        t.dnChain = t.dnChain.then(() => {
          for (const u of t.segmenter.flush()) this.onUtterance(a, t, u)
        })
        return t.dnChain
      })
    ).then(() => undefined)
  }

  /** 降噪输出按录音时间线接入分句；失败或有缺口时用临时文件里的原始录音补上（planFeed） */
  private feedSegmenter(a: Active, t: Track, r: { at: number; pcm: Int16Array } | null, upTo: number): void {
    const push = (pcm: Int16Array) => {
      for (const u of t.segmenter.push(pcm)) this.onUtterance(a, t, u)
      t.segFed += pcm.length
    }
    for (const step of planFeed(t.segFed, r, upTo)) {
      if ('pcm' in step) push(step.pcm)
      else readPcm(t.audioPath, step.raw[0], step.raw[1] - step.raw[0], push)
    }
  }

  pause(): void {
    const a = this.active
    if (!a || a.paused) return
    this.stopCapture(a)
    void this.drainSegmenter(a)
    a.elapsedBefore = this.elapsed(a)
    a.runningSince = 0
    a.paused = true
    store.updateMeeting(a.id, { status: 'paused', durationMs: a.elapsedBefore })
    this.emit()
  }

  resume(): void {
    const a = this.active
    if (!a || !a.paused) return
    a.paused = false
    a.runningSince = Date.now()
    store.updateMeeting(a.id, { status: 'recording' })
    this.startCapture(a)
    this.emit()
  }

  /** 结束会议：停止录音 → 等待识别与声纹完成 → 整理；minutes = false 时只保存记录，不生成纪要 */
  async stop(opts: { minutes?: boolean } = {}): Promise<void> {
    const a = this.active
    if (!a) return
    this.stopCapture(a)
    clearInterval(a.ticker)
    const drained = this.drainSegmenter(a)
    const durationMs = this.elapsed(a)
    this.active = null
    this.processing = { id: a.id, stage: '正在完成转写…' }
    store.updateMeeting(a.id, { status: 'processing', durationMs, endedAt: Date.now() })
    this.emit()
    await drained
    await a.asrChain
    await a.diarChain
    for (const t of a.tracks) {
      try {
        closeSync(t.fd)
      } catch {
        /* noop */
      }
    }
    // 识别失败过的句子再试一次（录音在临时文件里）
    for (const t of a.tracks) for (const [s, e] of t.failed) await this.transcribeRange(a.id, t.track, t.audioPath, s, e, a.asr, a.words, null)
    await this.organize(a.id, a.embeddings, a.prints, opts.minutes !== false)
  }

  /** 整理异常中断的会议：补转写临时录音里还没转写的尾部，然后照常整理 */
  async finish(meetingId: string, opts: { minutes?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    if (this.active?.id === meetingId || this.processing) return { ok: false, error: '正在处理其他会议' }
    const row = store.getMeetingRow(meetingId)
    if (!row) return { ok: false, error: '会议不存在' }
    this.processing = { id: meetingId, stage: '正在恢复会议录音…' }
    store.updateMeeting(meetingId, { status: 'processing' })
    this.emit()
    const settings = loadSettings()
    const paths = store.trackPaths(row)
    const appPath = row.source === 'mixed' ? row.app_audio_path : null
    let duration = 0
    for (const [track, path] of paths) {
      if (!path || !existsSync(path)) continue
      try {
        const asr = settings.asr.provider === 'builtin' ? createBuiltinAsr(settings) : createAsrProvider(settings, getKey('asr'))
        const words = listWords().map((w) => w.word)
        const last = store.listSegments(meetingId).filter((s) => s.track === track).reduce((m, s) => Math.max(m, s.endSample), 0)
        const total = Math.floor(statSync(path).size / 2)
        duration = Math.max(duration, total)
        const seg = new UtteranceSegmenter()
        const utterances: Utterance[] = []
        readPcm(path, last, total - last, (chunk) => utterances.push(...seg.push(chunk)))
        utterances.push(...seg.flush())
        for (const u of utterances) {
          // 麦克风那一路同样去掉外放回声
          const parts = track === 0 && appPath && existsSync(appPath) ? echoFree(path, appPath, u.start + last, u.end + last) : [{ start: u.start + last, end: u.end + last }]
          for (const p of parts) await this.transcribeRange(meetingId, track, path, p.start, p.end, asr, words, null)
        }
      } catch (err) {
        console.warn('[meeting] recover tail failed:', err)
      }
    }
    if (duration) store.updateMeeting(meetingId, { durationMs: samplesToMs(duration) }) // 录音时间线即会议时长（暂停不计）
    if (!row.ended_at) store.updateMeeting(meetingId, { endedAt: Date.now() })
    await this.organize(meetingId, new Map(), store.voiceprintVectors(), opts.minutes !== false)
    return { ok: true }
  }

  /** 重新生成纪要（改名、改归属后） */
  async regenerate(meetingId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.processing) return { ok: false, error: '正在整理其他会议，请稍候' }
    this.processing = { id: meetingId, stage: '正在生成会议纪要…' }
    this.emit()
    try {
      return await this.generateMinutes(meetingId)
    } finally {
      this.processing = null
      this.emit()
      this.hooks.onChanged(meetingId)
    }
  }

  /** 改名（可选“记住这个声音”）；返回是否保存了声纹（没有声音特征时无法保存） */
  renameSpeaker(meetingId: string, speakerId: number, name: string, remember: boolean): { remembered: boolean } {
    const sp = store.getSpeaker(speakerId)
    if (!sp || sp.meeting_id !== meetingId) return { remembered: false }
    let remembered = false
    const clean = name.trim() || null
    store.updateSpeaker(speakerId, { name: clean, autoNamed: false }) // 用户改过名：不再按声纹复核（D-042）
    // 旧声纹模型的会议：声纹与当前声纹库不可比，只改名不保存声纹（D-026）
    if (clean && remember && store.usesCurrentModel(meetingId)) {
      const v = this.speakerVector(meetingId, sp.track, speakerId)
      if (v) {
        const n = Math.max(1, store.listSegments(meetingId).filter((s) => s.speakerId === speakerId).length)
        const existing = store.voiceprintVectors().find((p) => p.id === sp.voiceprint_id) ?? store.voiceprintVectors().find((p) => p.name === clean)
        const vector = existing ? blendVoiceprint(existing.vector, existing.samples, v, n) : v
        const id = store.saveVoiceprint({ id: existing?.id, name: clean, vector, samples: (existing?.samples ?? 0) + n })
        store.updateSpeaker(speakerId, { voiceprintId: id })
        if (this.active) this.active.prints = store.voiceprintVectors()
        remembered = true
      }
    } else if (!remember && sp.voiceprint_id && clean !== sp.name) {
      store.updateSpeaker(speakerId, { voiceprintId: null })
    }
    this.hooks.onChanged(meetingId)
    return { remembered }
  }

  assignSegment(meetingId: string, segmentId: number, speakerId: number | 'new'): void {
    const seg = store.listSegments(meetingId).find((s) => s.id === segmentId)
    if (!seg) return
    // 说话人只在同一路之间改（现场的话不能归给线上的人）
    if (speakerId !== 'new' && store.getSpeaker(speakerId)?.track !== seg.track) return
    const target = speakerId === 'new' ? store.addSpeaker(meetingId, seg.track) : speakerId
    store.setSegmentSpeaker(segmentId, target, true)
    store.pruneSpeakers(meetingId)
    this.hooks.onChanged(meetingId)
  }

  mergeSpeakers(meetingId: string, from: number, into: number): void {
    if (from === into) return
    const a = store.getSpeaker(from)
    const b = store.getSpeaker(into)
    if (!a || !b || a.track !== b.track) return
    store.mergeSpeakers(from, into)
    if (this.active?.id === meetingId) this.track(this.active, a.track)?.clusterer.merge(from, into)
    this.hooks.onChanged(meetingId)
  }

  /** 设置页管理声纹模型：download / cancel / remove（会议进行或整理中不能删除） */
  speakerModelAction(action: 'download' | 'cancel' | 'remove'): { ok: boolean; error?: string } {
    if (action === 'download') void speakerModel.ensure()
    else if (action === 'cancel') speakerModel.cancel()
    else {
      if (this.active || this.processing) return { ok: false, error: '会议进行或整理中，不能删除声纹模型' }
      diarizer.stop()
      denoiser.stop()
      speakerModel.remove()
    }
    this.emit()
    return { ok: true }
  }

  /** 改某一路（0 = 现场 / 1 = 线上）的人数（AUTO_SPEAKERS = 自动）：会议中或会后都立即按新人数重新区分这一路的说话人（D-020、D-033、D-042） */
  setExpected(meetingId: string, count: number, track: MeetingTrack = 0): { ok: boolean; error?: string } {
    const n = speakerCount(count)
    const row = store.getMeetingRow(meetingId)
    if (row?.source === 'app') track = 1
    else if (row?.source !== 'mixed') track = 0
    store.setExpectedSpeakers(meetingId, n, track)
    saveSettings(track === 1 ? { meetingRemoteSpeakers: n } : { meetingSpeakers: n })
    const live = this.active?.id === meetingId ? this.active : null
    const liveTrack = live ? this.track(live, track) : undefined
    if (liveTrack) liveTrack.expected = n
    const embeddings = live ? live.embeddings : store.segmentEmbeddings(meetingId)
    const trackSegs = new Set(store.listSegments(meetingId).filter((s) => s.track === track).map((s) => s.id))
    if (![...embeddings.keys()].some((id) => trackSegs.has(id))) {
      this.hooks.onChanged(meetingId)
      return { ok: false, error: '这场会议没有保存逐句声纹（较早的会议），无法自动重新区分；可以手动合并说话人' }
    }
    const prints = live ? live.prints : store.voiceprintVectors()
    this.applyRegroup(meetingId, track, embeddings, prints, n, liveTrack ?? null)
    if (!live) store.relabelSpeakers(meetingId)
    this.hooks.onChanged(meetingId)
    return { ok: true }
  }

  /** 删除会议（进行中的会议不能删） */
  delete(meetingId: string): boolean {
    if (this.active?.id === meetingId || this.processing?.id === meetingId) return false
    for (const path of store.deleteMeeting(meetingId)) removeFile(path)
    this.minutesCache.delete(meetingId)
    return true
  }

  /** 启动时：上次异常退出留下的会议标为“异常中断”，等用户点“继续整理” */
  markInterrupted(): void {
    for (const row of store.unfinishedMeetings()) store.updateMeeting(row.id, { status: 'interrupted' })
  }

  // —— 内部 ——

  private elapsed(a: Active): number {
    return a.elapsedBefore + (a.runningSince ? Date.now() - a.runningSince : 0)
  }

  private tick(): void {
    const a = this.active
    if (!a || a.paused) return
    const e = this.elapsed(a)
    if (!a.warned && e >= MAX_MEETING_MS - WARN_BEFORE_MS) {
      a.warned = true
      this.flash('会议还有 5 分钟到达 4 小时上限，到时自动结束并整理')
    }
    if (e >= MAX_MEETING_MS) void this.stop()
    // 会议进行中定期整体重新区分说话人：纠正早期在线归类的错误（不必等到会议结束）
    if (a.tracks.some((t) => t.newSegments > 0) && Date.now() - a.lastRegroupAt >= REGROUP_EVERY_MS) {
      a.lastRegroupAt = Date.now()
      let changed = false
      for (const t of a.tracks) {
        if (!t.newSegments) continue
        t.newSegments = 0
        try {
          if (this.applyRegroup(a.id, t.track, a.embeddings, a.prints, t.expected, t).changed) changed = true
        } catch (err) {
          console.warn('[meeting] live regroup failed:', err)
        }
      }
      if (changed) this.hooks.onChanged(a.id)
    }
  }

  private flash(text: string, ttl = NOTICE_TTL_MS): void {
    this.notice = { text, until: Date.now() + ttl }
    this.emit()
  }

  private emit(): void {
    this.hooks.onLive(this.live())
  }

  /** 麦克风一路（麦克风 + 应用声音时）：先去掉外放的回声，剩下的部分各按一句处理 */
  private onUtterance(a: Active, t: Track, u: Utterance): void {
    const app = t.track === 0 ? this.track(a, 1) : undefined
    if (!app) return this.processUtterance(a, t, u)
    const parts = echoFree(t.audioPath, app.audioPath, u.start, u.end)
    if (parts.length === 1 && parts[0].start === u.start && parts[0].end === u.end) return this.processUtterance(a, t, u)
    if (!a.echoNoticed) {
      a.echoNoticed = true
      this.flash('检测到外放的回声：麦克风录到的对方声音已自动去掉；戴耳机效果更好', 10_000)
    }
    for (const p of parts) this.processUtterance(a, t, { start: p.start, end: p.end, pcm: u.pcm.subarray(p.start - u.start, p.end - u.start) })
  }

  /**
   * 一句话：先找句内换人的位置（真人对话常常不停顿就接话），按人切成几段；
   * 每段的声纹（mt-diarize，串行）与识别（串行）并行进行，两者都完成后落库。
   */
  private processUtterance(a: Active, t: Track, u: Utterance): void {
    const whole: Part[] = [{ start: u.start, end: u.end }]
    let canSplit = t.expected !== 1 && speakerModel.ready() && samplesToMs(u.end - u.start) >= MIN_SPLIT_MS
    // 积压太多（电脑忙）：只算整句声纹，不做句内换人切分，让识别先跟上
    if (canSplit && overloaded(a.pending)) {
      canSplit = false
      this.noticeOverload(a)
    }
    a.pending++
    // 已经区分出几个人（各至少说过 KNOWN_MIN_SEGMENTS 句）：按窗口与各人比较找换人位置（D-025）；
    // 会议刚开始还不知道各人的声音：用分段模型，带上句子前面一段录音做参考（分段模型在几秒的短片段里分不清人）
    const byWindows = canSplit && t.clusterer.countWith(KNOWN_MIN_SEGMENTS) >= 2
    const ctxStart = Math.max(0, u.start - TURN_CONTEXT_SAMPLES)
    const partsReady: Promise<Part[]> = !canSplit
      ? Promise.resolve(whole)
      : byWindows
        ? (a.diarChain = a.diarChain.then(() => this.splitWithWindows(t, u)).catch(() => whole)) as Promise<Part[]>
        : (a.diarChain = a.diarChain
            .then(() => diarizer.turns(t.audioPath, ctxStart, u.end - ctxStart))
            .then((r) => (r ? splitByTurns(u.start, u.end, turnsInUtterance(ctxStart, u.start, u.end, r)) : whole))
            .catch(() => whole)) as Promise<Part[]>
    // 切好后立刻排队算每段声纹；分段模型切出的同一人相邻段合回一段再识别（按窗口切的已按人分好，不再合）
    const planned: Promise<VoicedPart[]> = partsReady.then(async (parts) => {
      const voiced = await Promise.all(
        parts.map(async (p) => ({
          ...p,
          v:
            samplesToMs(p.end - p.start) >= MIN_EMBED_MS
              ? ((await (a.diarChain = a.diarChain.then(() => diarizer.embed(t.audioPath, p.start, p.end - p.start)).catch(() => null))) as Float32Array | null)
              : null
        }))
      )
      return parts.length > 1 && !byWindows ? mergeAdjacentParts(voiced) : voiced
    })
    a.asrChain = a.asrChain.then(async () => {
      try {
        await this.transcribeParts(a, t, u, await planned)
      } finally {
        a.pending--
      }
    })
    // 声纹模型在会议中途下载完成：补做之前没有说话人的句子
    if (speakerModel.ready()) void a.asrChain.then(() => this.backfillIfNeeded(a))
  }

  /** 识别一句话切出的各段并落库（会议 asrChain 串行调用） */
  private async transcribeParts(a: Active, t: Track, u: Utterance, parts: VoicedPart[]): Promise<void> {
    for (const p of parts) {
      // 识别用原始录音（降噪后的声音只用于分句：弱的人声会被一起削掉，D-024），音量归一后识别
      // 降噪中途停用前分出的句子仍是降噪后的声音：同样从临时录音读原始音频
      const pcm = normalizeLoudness(t.denoise || t.denoiseStopped ? readRange(t.audioPath, p.start, p.end) : u.pcm.subarray(p.start - u.start, p.end - u.start))
      let text: string
      try {
        text = (await a.asr.transcribe(pcm16ToWav(pcm, SAMPLE_RATE, 1), { vocabulary: a.words })).text.trim()
      } catch (err) {
        console.warn('[meeting] transcribe failed:', err)
        t.failed.push([p.start, p.end])
        continue
      }
      if (!text || isHallucination(text)) continue
      const v = p.v
      if (v) a.embedOk++
      else if (speakerModel.ready() && samplesToMs(p.end - p.start) >= MIN_EMBED_MS && ++a.embedFailed === 3 && !a.embedOk) {
        this.flash('说话人区分暂时不可用（声纹计算失败），本场会议先只转写；结束后可手动标注说话人')
      }
      const speakerId = v ? this.assignSpeaker(a, t, v) : t.lastSpeaker
      const id = store.addSegment(a.id, { speakerId, startSample: p.start, endSample: p.end, text, embedding: v, track: t.track })
      if (v) a.embeddings.set(id, v)
      t.lastSpeaker = speakerId
      t.newSegments++
      this.hooks.onChanged(a.id)
    }
  }

  private backfilling = false
  private async backfillIfNeeded(a: Active): Promise<void> {
    if (this.backfilling) return
    const pending = store.listSegments(a.id).filter((s) => s.speakerId === null && !a.embeddings.has(s.id))
    if (!pending.length) return
    this.backfilling = true
    try {
      for (const s of pending) {
        const t = this.track(a, s.track)
        if (!t || samplesToMs(s.endSample - s.startSample) < MIN_EMBED_MS) continue
        const v = await (a.diarChain = a.diarChain.then(() => diarizer.embed(t.audioPath, s.startSample, s.endSample - s.startSample)).catch(() => null))
        if (!(v instanceof Float32Array)) continue
        a.embeddings.set(s.id, v)
        store.setSegmentEmbedding(s.id, v)
        store.setSegmentSpeaker(s.id, this.assignSpeaker(a, t, v))
      }
      this.hooks.onChanged(a.id)
    } finally {
      this.backfilling = false
    }
  }

  /** 按窗口找句内换人位置（在 diarChain 内调用）：每 0.5 秒取 1.5 秒算声纹，与已区分出的各人比较（splitByWindows） */
  private async splitWithWindows(t: Track, u: Utterance): Promise<Part[]> {
    const w = (SAMPLE_RATE * WINDOW_MS) / 1000
    const hop = (SAMPLE_RATE * WINDOW_HOP_MS) / 1000
    const vecs: Array<{ center: number; v: Float32Array }> = []
    for (let s = u.start; s + w <= u.end + hop / 2; s += hop) {
      const st = Math.min(s, u.end - w)
      const v = await diarizer.embed(t.audioPath, st, w)
      if (v) vecs.push({ center: st + w / 2, v })
    }
    const keys = vecs.length ? t.clusterer.scores(vecs[0].v, KNOWN_MIN_SEGMENTS).map((x) => x.key) : []
    if (keys.length < 2) return [{ start: u.start, end: u.end }]
    const wins = vecs.map(({ center, v }) => {
      const sc = new Map(t.clusterer.scores(v, KNOWN_MIN_SEGMENTS).map((x) => [x.key, x.sim]))
      return { center, scores: keys.map((k) => sc.get(k) ?? -1) }
    })
    return splitByWindows(u.start, u.end, wins, (SAMPLE_RATE * WINDOW_MIN_PART_MS) / 1000)
  }

  /** 在线归类（名字由定期整体归类时按声纹库认出，见 applyRegroup） */
  private assignSpeaker(a: Active, t: Track, v: Float32Array): number {
    return t.clusterer.assign(v, () => store.addSpeaker(a.id, t.track), t.expected === AUTO_SPEAKERS ? t.autoCap : t.expected).key
  }

  private async transcribeRange(
    meetingId: string,
    track: MeetingTrack,
    audioPath: string,
    start: number,
    end: number,
    asr: AsrProvider,
    words: string[],
    speakerId: number | null
  ): Promise<void> {
    try {
      const pcm = normalizeLoudness(readRange(audioPath, start, end))
      const text = (await asr.transcribe(pcm16ToWav(pcm, SAMPLE_RATE, 1), { vocabulary: words })).text.trim()
      if (text && !isHallucination(text)) store.addSegment(meetingId, { speakerId, startSample: start, endSample: end, text, track })
    } catch (err) {
      console.warn('[meeting] retry transcribe failed:', err)
    }
  }

  /** 整理：整场重新归类说话人 →（可选）生成纪要 → 删除临时录音 */
  private async organize(meetingId: string, embeddings: Map<number, Float32Array>, prints: Active['prints'], withMinutes: boolean): Promise<void> {
    this.processing = { id: meetingId, stage: '正在整理说话人…' }
    this.emit()
    try {
      await this.reclusterMeeting(meetingId, embeddings, prints)
    } catch (err) {
      console.warn('[meeting] recluster failed:', err)
    }
    this.hooks.onChanged(meetingId)
    if (withMinutes) {
      this.processing = { id: meetingId, stage: '正在生成会议纪要…' }
      this.emit()
      await this.generateMinutes(meetingId)
    }
    const row = store.getMeetingRow(meetingId)
    removeFile(row?.audio_path ?? null)
    removeFile(row?.app_audio_path ?? null)
    store.updateMeeting(meetingId, { status: 'done', audioPath: null, appAudioPath: null })
    this.processing = null
    this.emit()
    this.hooks.onChanged(meetingId)
  }

  private async reclusterMeeting(meetingId: string, embeddings: Map<number, Float32Array>, prints: Active['prints']): Promise<void> {
    let row = store.getMeetingRow(meetingId)
    if (!row) return
    const paths = store.trackPaths(row)
    const hasAudio = paths.some(([, p]) => p && existsSync(p))
    // 旧声纹模型录的会议（升级前异常中断）：临时录音还在就用当前模型重算全部声纹，否则不与声纹库比较（D-026）
    if (!store.usesCurrentModel(meetingId)) {
      if (hasAudio && speakerModel.ready()) {
        store.resetEmbeddings(meetingId)
        embeddings.clear()
        row = store.getMeetingRow(meetingId)!
      } else prints = []
    }
    for (const [id, v] of store.segmentEmbeddings(meetingId)) if (!embeddings.has(id)) embeddings.set(id, v)
    const segments = store.listSegments(meetingId)
    // 缺声纹的句子（异常恢复、模型下载较晚）从临时录音补算
    if (speakerModel.ready()) {
      for (const s of segments) {
        const path = paths.find(([tr]) => tr === s.track)?.[1]
        if (!path || !existsSync(path) || embeddings.has(s.id) || samplesToMs(s.endSample - s.startSample) < MIN_EMBED_MS) continue
        const v = await diarizer.embed(path, s.startSample, s.endSample - s.startSample)
        if (v) {
          embeddings.set(s.id, v)
          store.setSegmentEmbedding(s.id, v)
        }
      }
    }
    if (!embeddings.size) return
    // 同一声纹被认出两次（同一路里）：先合并
    const byPrint = new Map<string, number>()
    for (const sp of store.listSpeakers(meetingId)) {
      if (!sp.voiceprint_id) continue
      const key = `${sp.track}:${sp.voiceprint_id}`
      const first = byPrint.get(key)
      if (first) store.mergeSpeakers(sp.id, first)
      else byPrint.set(key, sp.id)
    }
    const counts = new Map<number, number>()
    for (const s of store.listSegments(meetingId)) if (s.speakerId !== null && embeddings.has(s.id)) counts.set(s.speakerId, (counts.get(s.speakerId) ?? 0) + 1)
    for (const [track] of paths) {
      const expected = store.expectedOf(row, track)
      // 还没有说话人的句子先在线归类，再整体重新归类（每一路各自进行）
      const online = new OnlineClusterer()
      const trackSegs = segments.filter((s) => s.track === track)
      for (const s of trackSegs) {
        const v = embeddings.get(s.id)
        if (v && s.speakerId !== null) online.seed(s.speakerId, v)
      }
      for (const s of trackSegs) {
        const v = embeddings.get(s.id)
        if (v && s.speakerId === null) {
          const { key } = online.assign(v, () => store.addSpeaker(meetingId, track), expected || Infinity)
          store.setSegmentSpeaker(s.id, key)
          s.speakerId = key
        }
      }
      const means = this.applyRegroup(meetingId, track, embeddings, prints, expected ?? null, null)
      // 保存每人的声音特征（D-016：用于会后“记住这个声音”）；已关联声纹的人顺带更新声纹
      for (const sp of store.listSpeakers(meetingId)) {
        const c = means.get(sp.id)
        if (!c || sp.track !== track) continue
        store.updateSpeaker(sp.id, { centroid: c })
        if (sp.voiceprint_id && sp.name) {
          const vp = prints.find((p) => p.id === sp.voiceprint_id)
          const n = counts.get(sp.id) ?? 0
          // 自动认出的人只在整场声音仍然很像时才更新声纹，免得认错一次把声纹带偏（D-042）
          if (vp && n && (!sp.auto_named || printScore(c, vp.vector) >= PRINT_MATCH)) store.saveVoiceprint({ id: vp.id, name: vp.name, vector: blendVoiceprint(vp.vector, vp.samples, c, n), samples: vp.samples + n })
        }
      }
    }
    store.relabelSpeakers(meetingId) // 「说话人 N」按出场顺序重新编号
  }

  /**
   * 整体重新区分某一路的说话人并写回：段的归属、被合并的说话人、按声纹库认名字；live 时同步重建这一路的在线归类器。
   * 返回每个说话人的平均向量；有改动时返回值的 changed 标记见调用方（live 用于决定是否刷新界面）。
   */
  private applyRegroup(
    meetingId: string,
    track: MeetingTrack,
    embeddings: Map<number, Float32Array>,
    prints: Active['prints'],
    expected: number | null,
    live: Track | null
  ): Map<number, Float32Array> & { changed?: boolean } {
    const segs = store.listSegments(meetingId).filter((s) => s.track === track)
    // 用户起过名的人是约束（不被并掉、句子不挪走）；声纹自动认出的名字不算——让整体归类能纠正，名字随后复核（D-042）
    const named = new Set(store.listSpeakers(meetingId).filter((s) => s.name && !s.auto_named && s.track === track).map((s) => s.id))
    const items: ClusterItem[] = segs.map((s) => ({
      id: s.id,
      speaker: s.speakerId,
      v: embeddings.get(s.id) ?? null,
      durMs: samplesToMs(s.endSample - s.startSample),
      locked: s.locked
    }))
    const result = regroup(items, { expected, named, create: () => store.addSpeaker(meetingId, track) })
    let changed = false
    for (const s of segs) {
      const target = result.assign.get(s.id)
      if (target !== undefined && target !== s.speakerId) {
        store.setSegmentSpeaker(s.id, target)
        changed = true
      }
    }
    store.pruneSpeakers(meetingId)
    if (!store.usesCurrentModel(meetingId)) prints = [] // 旧声纹模型的会议不认（D-026）
    // 声纹自动认出的名字先复核：组里的人变了、分数掉到 PRINT_KEEP 以下就撤掉，下面重新认（D-042）
    for (const sp of store.listSpeakers(meetingId)) {
      if (sp.track !== track || !sp.auto_named || !sp.voiceprint_id) continue
      const mean = result.means.get(sp.id)
      const vp = prints.find((p) => p.id === sp.voiceprint_id)
      // 这一组可用的声纹太少（短句为主）、声纹已被删除：保留原名
      if (!mean || !vp || (result.sizes.get(sp.id) ?? 0) < PRINT_MIN_SEGMENTS || printScore(mean, vp.vector) >= PRINT_KEEP) continue
      store.updateSpeaker(sp.id, { name: null, voiceprintId: null, autoNamed: false })
      changed = true
    }
    // 还没有名字的人：用整组声音按声纹库认（D-022；本场已用过的声纹不再给别人，两路一起算）
    let speakers = store.listSpeakers(meetingId)
    const taken = new Set(speakers.flatMap((sp) => (sp.voiceprint_id ? [sp.voiceprint_id] : [])))
    const groups = speakers.flatMap((sp) => {
      const mean = result.means.get(sp.id)
      return !sp.name && sp.track === track && mean ? [{ key: sp.id, mean, n: result.sizes.get(sp.id) ?? 0 }] : []
    })
    for (const [key, id] of identifySpeakers(groups, prints, taken)) {
      const vp = prints.find((p) => p.id === id)
      if (!vp) continue
      store.updateSpeaker(key, { name: vp.name, voiceprintId: vp.id, autoNamed: true })
      changed = true
    }
    // 自动人数：同一个声纹的人被拆成了两组（还没名字的一组也很像这一路里已认出的某人，且最像的就是他）——并回去（D-042）
    const moved = new Map<number, number>()
    if (expected === AUTO_SPEAKERS) {
      speakers = store.listSpeakers(meetingId)
      const holders = speakers.filter((sp) => sp.track === track && sp.voiceprint_id && result.means.has(sp.id))
      for (const sp of speakers) {
        const mean = result.means.get(sp.id)
        const n = result.sizes.get(sp.id) ?? 0
        if (sp.track !== track || sp.name || !mean || n < PRINT_MIN_SEGMENTS) continue
        if (segs.some((s) => s.locked && result.assign.get(s.id) === sp.id)) continue // 用户手动指定过句子的人不动
        let best: { id: number; s: number } | null = null
        for (const p of prints) {
          const s = printScore(mean, p.vector)
          if (!best || s > best.s) best = { id: p.id, s }
        }
        const holder = best && best.s >= PRINT_MATCH ? holders.find((h) => h.voiceprint_id === best!.id) : undefined
        if (!holder) continue
        store.mergeSpeakers(sp.id, holder.id)
        moved.set(sp.id, holder.id)
        const hm = result.means.get(holder.id)!
        const hn = result.sizes.get(holder.id) ?? 0
        result.means.set(holder.id, blendVoiceprint(hm, hn, mean, n))
        result.sizes.set(holder.id, hn + n)
        result.means.delete(sp.id)
        result.sizes.delete(sp.id)
        changed = true
      }
    }
    const finalOf = (sp: number | undefined) => (sp === undefined ? sp : (moved.get(sp) ?? sp))
    if (live) {
      live.clusterer.clear()
      for (const s of segs) {
        const v = embeddings.get(s.id)
        const sp = finalOf(result.assign.get(s.id))
        if (v && sp !== undefined) live.clusterer.seed(sp, v)
      }
      const last = segs.at(-1)
      if (last) live.lastSpeaker = finalOf(result.assign.get(last.id)) ?? live.lastSpeaker
      live.autoCap = Math.max(2, result.means.size + 1)
    }
    return Object.assign(result.means, { changed })
  }

  private speakerVector(meetingId: string, track: MeetingTrack, speakerId: number): Float32Array | null {
    if (this.active?.id === meetingId) {
      const c = this.track(this.active, track)?.clusterer.centroid(speakerId)
      if (c) return c
    }
    return store.getSpeaker(speakerId)?.centroid ?? null
  }

  private async generateMinutes(meetingId: string): Promise<{ ok: boolean; error?: string }> {
    const detail = store.getMeetingDetail(meetingId)
    if (!detail) return { ok: false, error: '会议不存在' }
    const settings = loadSettings()
    const key = hasKey('llm') ? getKey('llm') : ''
    if (!key) {
      const error = '未配置 LLM：在设置 → 润色 LLM 里填写 API Key 后，点「生成纪要」'
      store.updateMeeting(meetingId, { minutesError: error })
      return { ok: false, error }
    }
    const names = new Map(detail.speakerList.map((s) => [s.id, s.displayName]))
    const lines = buildTranscript(detail.segments.map((s) => ({ startMs: s.startMs, speaker: (s.speakerId !== null && names.get(s.speakerId)) || '未区分', text: s.text })))
    if (!lines.length) {
      const error = '没有转写内容，无法生成纪要'
      store.updateMeeting(meetingId, { minutesError: error })
      return { ok: false, error }
    }
    try {
      // 流式接收：连续 3 分钟没有任何输出（含思考过程）才算超时（GLM-5.3 等强制深度思考，长转写稿要先想几分钟）
      const llm = new LlmPolisher(settings, key, 180_000)
      const speakers = detail.speakerList.map((s) => s.displayName)
      let cache = this.minutesCache.get(meetingId)
      if (!cache) this.minutesCache.set(meetingId, (cache = new Map()))
      // 长会议：均分成段、最多 3 段同时整理、提要太多时逐层合并（minutes.ts 的 generateMinutesBody）
      const body = await generateMinutesBody(lines, speakers, {
        complete: (system, user) => llm.complete(system, user),
        cache,
        progress: (stage) => {
          this.processing = { id: meetingId, stage }
          this.emit()
        }
      })
      // 正文里的说话人名字在本地加粗（复制、导出也带着），不交给模型
      const minutes = `${minutesHeader({ title: detail.title, startedAt: detail.startedAt, durationMs: detail.durationMs, speakers })}\n${markSpeakerNames(cleanMinutesBody(body), speakers)}\n`
      store.updateMeeting(meetingId, { minutes, minutesError: null })
      this.minutesCache.delete(meetingId)
      return { ok: true }
    } catch (err) {
      // 转写稿已完整保存（D-008 的会议版），只记录纪要失败的原因
      const error = `纪要生成失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`
      store.updateMeeting(meetingId, { minutesError: error })
      return { ok: false, error }
    }
  }
}

/** 参会人数：1～MAX_SPEAKERS，或 AUTO_SPEAKERS（按声音判断，D-042）；无效时取自动 */
function speakerCount(n: number | null | undefined): number {
  return n && Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SPEAKERS) : AUTO_SPEAKERS
}

function defaultTitle(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 的会议`
}

/**
 * 麦克风一路 [start, end) 去掉外放回声后保留的段（D-033）：与应用声音同一时刻（前后各多取一点，容许延迟与两路误差）比较。
 * 应用声音还没写到的部分按无声处理。
 */
function echoFree(micPath: string, appPath: string, start: number, end: number): Part[] {
  try {
    const mic = readRange(micPath, start, end)
    const from = start - ECHO_LEAD
    const appPcm = new Int16Array(end + ECHO_AHEAD - from)
    const got = readRange(appPath, Math.max(0, from), end + ECHO_AHEAD)
    appPcm.set(got.subarray(0, appPcm.length - Math.max(0, -from)), Math.max(0, -from))
    return removeEcho(start, start + mic.length, mic, appPcm).keep
  } catch (err) {
    console.warn('[meeting] echo check failed:', err)
    return [{ start, end }]
  }
}

/** 读出临时录音 [start, end) 这段（文件比 end 短时只返回已有部分） */
function readRange(path: string, start: number, end: number): Int16Array {
  const pcm = new Int16Array(Math.max(0, end - start))
  let off = 0
  readPcm(path, start, end - start, (c) => {
    pcm.set(c, off)
    off += c.length
  })
  return pcm.subarray(0, off)
}

function readPcm(path: string, start: number, count: number, onChunk: (pcm: Int16Array) => void): void {
  if (count <= 0) return
  const fd = openSync(path, 'r')
  try {
    const CHUNK = SAMPLE_RATE * 10
    let pos = start
    const end = start + count
    while (pos < end) {
      const n = Math.min(CHUNK, end - pos)
      const buf = Buffer.alloc(n * 2)
      const got = readSync(fd, buf, 0, buf.length, pos * 2)
      if (got <= 0) break
      onChunk(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (got - (got % 2)))))
      pos += Math.floor(got / 2)
    }
  } finally {
    closeSync(fd)
  }
}

function removeFile(path: string | null): void {
  if (!path) return
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch (err) {
    console.warn('[meeting] remove audio failed:', err)
  }
}

export { store as meetingStore }
