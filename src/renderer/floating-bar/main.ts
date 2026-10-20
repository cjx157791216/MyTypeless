import type { MeetingLive, SessionProgress } from '../../shared/types'
import { micPermissionHint } from '../../shared/platform'

/**
 * 浮动条渲染端（事件驱动版）：
 * - 主进程 state 事件驱动采集生命周期：
 *   recording → 启动 capture；离开 recording → 停止 capture
 * - 音频：getUserMedia → AudioWorklet(内联 Blob) → 重采样 16k mono Int16 → 分片 IPC → main
 * - 能量 VAD：静音超过主进程下发的 autoStopMs 自动停止（按住说话时为 0，不自动停）
 * - 停止握手：主进程 captureFlush → 冲刷 worklet 尾音 → audioFinal，保证最后一个词不丢
 * - 加载时先拉取当前状态，避免窗口复用时失步
 */

const api = window.mytypeless
const TARGET_RATE = 16000

const pill = document.getElementById('pill')!
const waveEl = document.getElementById('wave')!
const chipEl = document.getElementById('mode-chip')!
const errorEl = document.getElementById('error')!
const liveEl = document.getElementById('live')!
const remainEl = document.getElementById('remain')!

// 波形：9 根条，中间高两边低；用最近几次电平做轻微的错位动画
const WAVE_BARS = 9
const waveShape = [0.45, 0.6, 0.78, 0.92, 1, 0.92, 0.78, 0.6, 0.45]
const waveBars: HTMLElement[] = []
for (let i = 0; i < WAVE_BARS; i++) waveBars.push(waveEl.appendChild(document.createElement('i')))
let wavePhase = 0
function renderWave(level: number): void {
  wavePhase += 0.9
  for (let i = 0; i < WAVE_BARS; i++) {
    const wobble = 0.65 + 0.35 * Math.abs(Math.sin(wavePhase + i * 1.3))
    waveBars[i].style.height = `${Math.round(4 + 14 * level * waveShape[i] * wobble)}px`
  }
}
const btnCancel = document.getElementById('btn-cancel')!
const btnStop = document.getElementById('btn-stop')!
const meetingTimeEl = document.getElementById('meeting-time')!
const btnMeetingPause = document.getElementById('btn-meeting-pause')!
const btnMeetingStop = document.getElementById('btn-meeting-stop')!

let audioCtx: AudioContext | null = null
let mediaStream: MediaStream | null = null
let workletNode: AudioWorkletNode | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let capturing = false
let lastVoiceAt = 0
let startedAt = 0
let autoStopMs = 0
let keepMicWarm = true
/** 设置里指定的麦克风（空 = 自动） */
let micDeviceSetting = ''
/** 自动模式本次运行选定的设备（设备插拔后重新选择） */
let autoDeviceId: string | null = null
let openedDeviceId = ''
let openedDeviceLabel = ''
let micOpenedAt = 0
let sawSignal = false
let fallbackTried = false
/** 会议录音中（D-015）：分片送往会议而不是听写会话 */
let meetingCapturing = false
let meetingPush: Promise<void> = Promise.resolve()
let meetingLive: MeetingLive = { state: 'idle' }
let meetingLiveAt = 0

/** 常见的虚拟输入设备：没有软件往里送声音时输出纯静音（如变声器 Screaming Bee、BlackHole、会议软件的虚拟设备） */
const VIRTUAL_INPUT = /screaming bee|blackhole|soundflower|loopback audio|vb-cable|vb-audio|zoomaudiodevice|zoom audio|teams audio|aggregate|聚集设备|多输出|multi-output|background music|eqmac/i
const isBuiltIn = (label: string) => /built-in|内建|内置|macbook/i.test(label)
/** 开麦后这么久全是纯零（真实麦克风总有底噪），判定为无声设备 */
const SILENT_DEVICE_MS = 600
let autoStopFired = false
let currentState: SessionProgress['state'] = 'idle'
let pendingPush: Promise<void> = Promise.resolve()
let flushResolve: (() => void) | null = null
let releaseTimer: number | null = null
/** 麦克风保持就绪期间，最近一小段音频（预录），下次开口时补在最前面，避免按键瞬间说的字被截掉 */
let preRoll: ArrayBuffer[] = []

const PREROLL_CHUNKS = 3 // × 100ms
const WARM_MS = 60_000

// AudioContext 直接以 16kHz 运行（浏览器内部高质量重采样），step 通常为 1；
// 若系统不支持 16kHz 上下文，退化为按比例窗口取平均。
// 每 100ms 发一个分片（预录按分片保留）；电平每 4 个块上报一次；flush 时把不足一个分片的尾音立即送出
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = ${TARGET_RATE} / sampleRate;
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
    this.buf = [];
    this.levelSum = 0;
    this.levelCount = 0;
    this.blocks = 0;
    this.port.onmessage = (e) => { if (e.data === 'flush') this.emitPcm(true); };
  }
  emitPcm(final) {
    const i16 = new Int16Array(this.buf.length);
    for (let i = 0; i < this.buf.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(this.buf[i] * 32767)));
    this.buf = [];
    this.port.postMessage({ type: 'pcm', data: i16, final }, [i16.buffer]);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.levelSum += v * v;
      this.acc += v;
      this.n++;
      this.pos += this.step;
      if (this.pos >= 1) {
        this.pos -= 1;
        this.buf.push(Math.max(-1, Math.min(1, this.acc / this.n)));
        this.acc = 0;
        this.n = 0;
      }
    }
    this.levelCount += ch.length;
    if (++this.blocks >= 4) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelSum / this.levelCount) });
      this.blocks = 0;
      this.levelSum = 0;
      this.levelCount = 0;
    }
    if (this.buf.length >= ${TARGET_RATE} / 10) this.emitPcm(false);
    return true;
  }
}
registerProcessor('mt-capture', CaptureProcessor);
`

/** AudioContext + worklet 模块常驻（不占用麦克风），每次会话只需打开麦克风，缩短开口延迟 */
async function ensureAudioContext(): Promise<AudioContext> {
  if (audioCtx && audioCtx.state !== 'closed') {
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    return audioCtx
  }
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' })
  } catch {
    ctx = new AudioContext()
  }
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  audioCtx = ctx
  return ctx
}

function onWorkletMessage(e: MessageEvent): void {
  const msg = e.data
  if (msg.type === 'level') {
    if (msg.rms > 0) sawSignal = true
    if (!capturing && !meetingCapturing) return
    if (!sawSignal && !fallbackTried && performance.now() - micOpenedAt > SILENT_DEVICE_MS) {
      fallbackTried = true
      void switchFromSilentDevice()
    }
    const level = Math.min(1, msg.rms * 6)
    renderWave(level)
    if (currentState === 'recording') {
      const now = performance.now()
      if (msg.rms > 0.015) lastVoiceAt = now
      if (autoStopMs > 0 && !autoStopFired && now - lastVoiceAt > autoStopMs && now - startedAt > 1200) {
        autoStopFired = true
        void api.session.stop() // 状态事件会接管 UI 与采集清理
      }
    }
  } else if (msg.type === 'pcm') {
    if (msg.data.length) {
      const buf = msg.data.buffer as ArrayBuffer
      if (meetingCapturing) {
        meetingPush = meetingPush.then(() => api.meeting.pushAudio(buf)).catch(() => undefined)
      } else if (capturing) {
        pendingPush = pendingPush.then(() => api.session.pushAudio(buf)).catch(() => undefined)
      } else {
        // 保持就绪：只在内存里留最近一小段，不上传、不落盘
        preRoll.push(buf)
        if (preRoll.length > PREROLL_CHUNKS) preRoll.shift()
      }
    }
    if (msg.final) {
      void pendingPush.then(() => {
        flushResolve?.()
        flushResolve = null
      })
    }
  }
}

async function audioInputs(): Promise<MediaDeviceInfo[]> {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
}

/** 选择麦克风：设置指定 > 本次自动选定 > 系统默认（若是虚拟设备则改用真实麦克风，优先内置） */
async function pickDeviceId(): Promise<string | undefined> {
  if (micDeviceSetting) return micDeviceSetting
  if (autoDeviceId) return autoDeviceId
  const inputs = await audioInputs()
  const def = inputs.find((d) => d.deviceId === 'default')
  const defLabel = (def?.label ?? '').replace(/^(Default|默认)\s*-\s*/, '')
  if (!def || !VIRTUAL_INPUT.test(defLabel)) return undefined
  const real = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && !VIRTUAL_INPUT.test(d.label))
  const pick = real.find((d) => isBuiltIn(d.label)) ?? real[0]
  if (pick) autoDeviceId = pick.deviceId
  return pick?.deviceId
}

/** 打开麦克风并接入 worklet；已处于保持就绪状态且设备未变时直接复用 */
async function ensureMic(): Promise<boolean> {
  const wantId = await pickDeviceId()
  const live = mediaStream && mediaStream.getAudioTracks().some((t) => t.readyState === 'live') && workletNode
  if (live && (!wantId || wantId === openedDeviceId)) return true
  releaseMic()
  const [ctx, stream] = await Promise.all([
    ensureAudioContext(),
    navigator.mediaDevices.getUserMedia({
      // 识别用：不做通话降噪（会损伤语音细节）与回声消除，保留自动增益
      audio: {
        ...(wantId ? { deviceId: { exact: wantId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      }
    })
  ])
  mediaStream = stream
  const track = stream.getAudioTracks()[0]
  openedDeviceId = track?.getSettings().deviceId ?? wantId ?? ''
  openedDeviceLabel = track?.label ?? ''
  micOpenedAt = performance.now()
  sawSignal = false
  sourceNode = ctx.createMediaStreamSource(stream)
  workletNode = new AudioWorkletNode(ctx, 'mt-capture')
  workletNode.port.onmessage = onWorkletMessage
  sourceNode.connect(workletNode)
  return true
}

/** 当前麦克风只出纯静音：换到下一个真实麦克风（优先内置）并提示；没有可换的就提示去设置里选 */
async function switchFromSilentDevice(): Promise<void> {
  const silentLabel = openedDeviceLabel || '当前麦克风'
  const inputs = await audioInputs()
  const candidates = inputs.filter(
    (d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId !== openedDeviceId && !VIRTUAL_INPUT.test(d.label)
  )
  const next = candidates.find((d) => isBuiltIn(d.label)) ?? candidates[0]
  if (!next) {
    showError(`麦克风「${silentLabel}」没有声音：请在主窗口 → 设置 → 麦克风 里选择正确的设备`)
    return
  }
  autoDeviceId = next.deviceId
  const manual = micDeviceSetting
  micDeviceSetting = '' // 本次改用自动选中的设备
  releaseMic()
  try {
    await ensureMic()
    showError(`麦克风「${silentLabel}」没有声音，已改用「${next.label}」${manual ? '（可在设置中修改）' : ''}`, true)
  } catch {
    showError(`麦克风「${silentLabel}」没有声音：请在主窗口 → 设置 → 麦克风 里选择正确的设备`)
  }
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  autoDeviceId = null // 插拔耳机等：下次开口重新选择
  if (!capturing && !meetingCapturing) releaseMic()
})

/** 释放麦克风（菜单栏麦克风图标消失），清空预录 */
function releaseMic(): void {
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = null
  try {
    workletNode?.disconnect()
    sourceNode?.disconnect()
  } catch {
    /* noop */
  }
  if (workletNode) workletNode.port.onmessage = null
  mediaStream?.getTracks().forEach((t) => t.stop())
  workletNode = null
  sourceNode = null
  mediaStream = null
  preRoll = []
}

async function startCapture(): Promise<void> {
  if (capturing) return
  capturing = true
  fallbackTried = false
  autoStopFired = false
  startedAt = performance.now()
  lastVoiceAt = startedAt
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = null
  // 保持就绪时：先把预录补上（按键前一瞬间开口的字）
  for (const buf of preRoll) pendingPush = pendingPush.then(() => api.session.pushAudio(buf)).catch(() => undefined)
  preRoll = []
  try {
    await ensureMic()
    if (!capturing) scheduleRelease() // 打开麦克风期间会话已结束
  } catch (err) {
    capturing = false
    releaseMic()
    const name = err instanceof DOMException ? err.name : ''
    showError(
      name === 'NotAllowedError'
        ? micPermissionHint(api.platform)
        : '无法访问麦克风：' + (err instanceof Error ? err.message : String(err))
    )
    void api.session.cancel()
  }
}

/** 主进程停止前的冲刷：把 worklet 中剩余的尾音送达后再回应 */
async function flushCapture(): Promise<void> {
  if (capturing && workletNode) {
    await new Promise<void>((resolve) => {
      flushResolve = resolve
      workletNode!.port.postMessage('flush')
      setTimeout(resolve, 500) // worklet 无响应时不阻塞
    })
  }
  await pendingPush
  await api.session.audioFinal()
}

/** 用完后按设置决定：立即释放，或保持就绪一段时间（期间再开口不丢开头） */
function scheduleRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer)
  if (!keepMicWarm) {
    releaseMic()
    return
  }
  releaseTimer = window.setTimeout(releaseMic, WARM_MS)
}

function stopCapture(): void {
  if (!capturing) return
  capturing = false
  flushResolve?.()
  flushResolve = null
  preRoll = []
  if (!meetingCapturing) scheduleRelease()
}

// —— 会议录音（D-015）——
async function startMeetingCapture(deviceId: string): Promise<void> {
  if (meetingCapturing) return
  micDeviceSetting = deviceId
  meetingCapturing = true
  fallbackTried = false
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = null
  preRoll = []
  try {
    await ensureMic()
  } catch (err) {
    meetingCapturing = false
    releaseMic()
    const name = err instanceof DOMException ? err.name : ''
    showError(name === 'NotAllowedError' ? micPermissionHint(api.platform) : '无法访问麦克风，会议已暂停')
    void api.meeting.pause()
  }
}

function stopMeetingCapture(): void {
  if (!meetingCapturing) return
  meetingCapturing = false
  if (!capturing) releaseMic() // 会议录音结束立即释放麦克风（不保持就绪）
}

api.meeting.onCapture((c) => (c.on ? void startMeetingCapture(c.micDeviceId) : stopMeetingCapture()))

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 听写会话空闲时，胶囊显示会议状态 */
function renderMeeting(): void {
  const m = meetingLive
  const show = currentState === 'idle' && m.state !== 'idle'
  pill.classList.toggle('state-meeting', show)
  pill.classList.toggle('meeting-paused', show && m.state === 'paused')
  pill.classList.toggle('meeting-processing', show && m.state === 'processing')
  if (!show) {
    if (currentState === 'idle') pill.classList.add('state-idle')
    return
  }
  pill.classList.remove('state-idle')
  if (m.state === 'processing') meetingTimeEl.textContent = m.stage ?? '正在整理会议纪要…'
  else {
    const elapsed = (m.elapsedMs ?? 0) + (m.running ? Date.now() - meetingLiveAt : 0)
    meetingTimeEl.textContent = `${m.state === 'paused' ? '已暂停' : '会议中'} ${fmtClock(elapsed)}`
  }
  btnMeetingPause.title = m.state === 'paused' ? '继续' : '暂停'
}

let lastMeetingNotice = ''
api.meeting.onLive((live) => {
  meetingLive = live
  meetingLiveAt = Date.now()
  if (live.notice && live.notice !== lastMeetingNotice) showError(live.notice, true)
  lastMeetingNotice = live.notice ?? ''
  renderMeeting()
})
void api.meeting.getLive().then((live) => {
  meetingLive = live
  meetingLiveAt = Date.now()
  renderMeeting()
})
window.setInterval(() => {
  if (meetingLive.state === 'recording') renderMeeting()
}, 1000)
btnMeetingPause.addEventListener('click', () => void (meetingLive.state === 'paused' ? api.meeting.resume() : api.meeting.pause()))
btnMeetingStop.addEventListener('click', () => void api.meeting.requestStop())

const MODE_LABEL: Partial<Record<string, string>> = {
  translate: '翻译',
  rewrite: '改写',
  ask: '提问'
}

let hideToastTimer: number | null = null

// 最长录音时长倒计时（D-014）：按主进程下发的已录时长校准，最后 1 分钟显示
const REMAIN_SHOW_MS = 60_000
let recStartAt = 0
let maxRecordingMs = 0
let remainTimer: number | null = null

function renderRemain(): void {
  const left = maxRecordingMs > 0 ? maxRecordingMs - (Date.now() - recStartAt) : Infinity
  const show = currentState === 'recording' && left <= REMAIN_SHOW_MS
  remainEl.classList.toggle('hidden', !show)
  if (!show) return
  const sec = Math.max(0, Math.ceil(left / 1000))
  remainEl.textContent = `剩 ${sec} 秒`
  remainEl.classList.toggle('urgent', sec <= 10)
}

function syncRemain(p: SessionProgress): void {
  if (p.state === 'recording') {
    if (p.elapsedMs !== undefined) recStartAt = Date.now() - p.elapsedMs
    if (p.maxRecordingMs !== undefined) maxRecordingMs = p.maxRecordingMs
    remainTimer ??= window.setInterval(renderRemain, 250)
  } else if (remainTimer !== null) {
    clearInterval(remainTimer)
    remainTimer = null
  }
  renderRemain()
}

function applyState(p: SessionProgress): void {
  const prev = currentState
  currentState = p.state
  if (p.state === 'recording' && p.autoStopMs !== undefined) autoStopMs = p.autoStopMs
  if (p.state === 'recording' && p.keepMicWarm !== undefined) keepMicWarm = p.keepMicWarm
  if (p.state === 'recording' && p.micDeviceId !== undefined) micDeviceSetting = p.micDeviceId
  const label = p.mode ? MODE_LABEL[p.mode] : undefined
  chipEl.textContent = label ?? ''
  chipEl.classList.toggle('hidden', !label || p.state === 'idle')
  pill.className = `pill state-${p.state}${p.handsFree ? ' hands-free' : ''}`
  // 实时文字：录音与处理中显示，回到空闲清空；只保留末尾，较早的内容自然滚出
  if (p.liveText !== undefined) liveEl.textContent = p.liveText.length > 80 ? `…${p.liveText.slice(-80)}` : p.liveText
  if (p.state === 'idle' || p.state === 'done' || p.state === 'error') liveEl.textContent = ''
  liveEl.classList.toggle('hidden', !liveEl.textContent)
  syncRemain(p)
  renderMeeting()

  if (p.state === 'recording' && prev !== 'recording') {
    renderWave(0)
    void startCapture()
  }
  if (p.state !== 'recording' && prev === 'recording') {
    stopCapture()
  }
  if (p.state === 'error' && p.error) showError(p.error)
  else if (p.notice) showError(p.notice, true)
  else if (p.state !== 'done') hideError()
}

function showError(msg: string, notice = false): void {
  errorEl.textContent = msg
  errorEl.classList.toggle('notice', notice)
  errorEl.classList.remove('hidden')
  if (hideToastTimer) clearTimeout(hideToastTimer)
  // 提示按字数多留一会儿（长提示 2.5 秒读不完）
  hideToastTimer = window.setTimeout(hideError, notice ? Math.max(2500, msg.length * 80) : 3500)
}
function hideError(): void {
  errorEl.classList.add('hidden')
}

api.session.onStateChanged(applyState)
api.session.onFlush(() => void flushCapture())

// 只有胶囊和提示可点；窗口其余透明区域点击穿透到下面的应用
for (const el of [pill, errorEl]) {
  el.addEventListener('mouseenter', () => api.system.setBarInteractive(true))
  el.addEventListener('mouseleave', () => api.system.setBarInteractive(false))
}

btnStop.addEventListener('click', () => void api.session.stop())
btnCancel.addEventListener('click', () => void api.session.cancel())
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void api.session.cancel()
})

// 初始状态同步（窗口复用场景）
void api.session.getState().then(applyState)
