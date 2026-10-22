// 带 .ts 扩展名：被 test/ 直接导入（Node 原生剥离类型，不解析无扩展名的路径）
import { SAMPLE_RATE, Vad, type VadOptions } from '../live.ts'

/**
 * 会议录音分句（D-015）。纯逻辑，不依赖 electron。
 * 会议以“一句话”为单位转写和区分说话人：停顿 PAUSE_MS 视为一句结束；
 * 一直不停顿时在 MAX_MS 附近最安静处切开（单句识别不超过 whisper 的 30 秒窗口）。
 * 输出的样本下标是会议录音时间线上的位置（暂停期间不计入）。
 */

const FRAME = 1600 // 100ms
const PAUSE_FRAMES = 6 // 600ms 静音视为一句结束（比听写长：会议里句中短停顿很常见）
const MIN_SPEECH_FRAMES = 3 // 至少 300ms 语音才算一句（过滤咳嗽、碰撞声）
const PRE_PAD = 2 * FRAME // 句首多留 200ms，避免吃掉第一个字
const POST_PAD = 3 * FRAME // 句尾多留 300ms
const MAX_FRAMES = 200 // 20 秒
const CUT_SEARCH_FRAMES = 30 // 超长时在最后 3 秒内找最安静的帧切开
export const MEETING_VAD: VadOptions = { floor: 250, ratio: 3 } // 会议用原始录音分句时（没有降噪模型）
// 会议用降噪后的录音分句时（D-024）：降噪把底噪压到原来的 1/4，远处人声才能放宽门槛而不误触发——
// 模拟远处说话（小 18 dB、带混响）在偏吵的房间里，原始录音 + 原参数漏掉一半的句子，降噪后 + 此参数没有整句漏掉
export const MEETING_VAD_DENOISED: VadOptions = { floor: 60, ratio: 2 }

/**
 * 电脑忙不过来时的降级（慢 CPU 上开会，识别、声纹、降噪加上会议软件把 CPU 占满）：
 * - 降噪（低优先级进程）落后录音超过 DENOISE_MAX_LAG：这一路改用原始录音分句（MEETING_VAD）。降噪只用于分句（D-024），
 *   跟不上时整路分不出句子，实时转写停住，结束后还要把积压的录音全部降噪一遍
 * - 排队等声纹与识别的句子超过 OVERLOAD_PENDING：新句子不再做句内换人切分（D-025 的窗口比较 / 分段模型），只算整句声纹
 */
export const DENOISE_MAX_LAG = 8 * SAMPLE_RATE
export const OVERLOAD_PENDING = 3

export function denoiseLagging(written: number, segFed: number): boolean {
  return written - segFed > DENOISE_MAX_LAG
}

export function overloaded(pending: number): boolean {
  return pending > OVERLOAD_PENDING
}

export interface Utterance {
  start: number // 样本下标（含）
  end: number // 样本下标（不含）
  pcm: Int16Array
}

export class UtteranceSegmenter {
  private vad: Vad
  private pending = new Int16Array(0)
  private total = 0 // 已过 VAD 的样本数（时间线位置）
  /** 保留的音频：从 bufStart 开始（只保留当前句及句首前的一小段） */
  private buf: Int16Array[] = []
  private bufStart = 0
  private bufLen = 0
  private speechStart = -1 // 当前句第一帧语音的位置；-1 = 不在句中
  private lastSpeechEnd = 0
  private speechFrames = 0
  private frameEnergy: number[] = [] // 当前句每帧能量（找切点用）
  private continued = false // 当前句是上一句被强制切开后的延续（句首不再多留，避免重复）

  constructor(vad: VadOptions = MEETING_VAD) {
    this.vad = new Vad(vad)
  }

  /** 推入音频，返回已结束的句子 */
  push(pcm: Int16Array): Utterance[] {
    const out: Utterance[] = []
    const merged = new Int16Array(this.pending.length + pcm.length)
    merged.set(this.pending)
    merged.set(pcm, this.pending.length)
    let off = 0
    for (; off + FRAME <= merged.length; off += FRAME) {
      const u = this.onFrame(merged.slice(off, off + FRAME))
      if (u) out.push(u)
    }
    this.pending = merged.slice(off)
    return out
  }

  /** 结束（暂停、停止）：把正在说的这一句也输出 */
  flush(): Utterance[] {
    const out: Utterance[] = []
    if (this.pending.length) {
      const frame = new Int16Array(FRAME)
      frame.set(this.pending)
      this.pending = new Int16Array(0)
      const u = this.onFrame(frame)
      if (u) out.push(u)
    }
    if (this.speechStart >= 0) {
      const u = this.emit(this.lastSpeechEnd)
      if (u) out.push(u)
    }
    this.vad.silentRun = 0
    return out
  }

  /** 换 VAD 门槛（降噪跟不上、改用原始录音分句时）；时间线位置与正在说的句子保持不变 */
  useVad(vad: VadOptions): void {
    this.vad = new Vad(vad)
  }

  /** 当前时间线位置（样本） */
  position(): number {
    return this.total + this.pending.length
  }

  private onFrame(frame: Int16Array): Utterance | null {
    const start = this.total
    this.total += frame.length
    this.append(frame)
    let energy = 0
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i]
    const speech = this.vad.isSpeech(frame)

    if (this.speechStart < 0) {
      if (speech) {
        this.speechStart = start
        this.lastSpeechEnd = this.total
        this.speechFrames = 1
        this.frameEnergy = [energy]
      } else {
        this.trim(this.total - PRE_PAD) // 句外只保留句首前的一小段
      }
      return null
    }

    this.frameEnergy.push(energy)
    if (speech) {
      this.speechFrames++
      this.lastSpeechEnd = this.total
    }
    if (!speech && this.vad.silentRun >= PAUSE_FRAMES) return this.emit(this.lastSpeechEnd)
    if (this.frameEnergy.length >= MAX_FRAMES) {
      // 一直不停：在最后几秒里最安静的帧中间切开，剩下的部分作为下一句的开头
      const n = this.frameEnergy.length
      let best = n - 1
      for (let k = n - 1; k >= n - CUT_SEARCH_FRAMES; k--) if (this.frameEnergy[k] < this.frameEnergy[best]) best = k
      const cut = this.speechStart + best * FRAME + FRAME / 2
      return this.emit(cut, true)
    }
    return null
  }

  /** 输出 [speechStart - PRE_PAD, end + POST_PAD) 一句；continued = 被强制切开、后面紧接着还在说 */
  private emit(end: number, continued = false): Utterance | null {
    const enough = this.speechFrames >= MIN_SPEECH_FRAMES
    const from = Math.max(this.bufStart, this.speechStart - (this.continued ? 0 : PRE_PAD))
    const to = continued ? end : Math.min(this.total, end + POST_PAD)
    const u = enough ? { start: from, end: to, pcm: this.slice(from, to) } : null
    if (continued) {
      // 切点之后的帧留给下一句
      const keepFrames = this.frameEnergy.length - Math.floor((end - this.speechStart) / FRAME)
      this.speechStart = end
      this.speechFrames = keepFrames
      this.frameEnergy = this.frameEnergy.slice(-keepFrames)
      this.continued = true
      this.trim(end)
    } else {
      this.continued = false
      this.speechStart = -1
      this.speechFrames = 0
      this.frameEnergy = []
      this.trim(this.total - PRE_PAD)
    }
    return u
  }

  private append(frame: Int16Array): void {
    this.buf.push(frame)
    this.bufLen += frame.length
  }

  /** 丢掉 pos 之前的音频（按帧粒度） */
  private trim(pos: number): void {
    while (this.buf.length && this.bufStart + this.buf[0].length <= pos) {
      this.bufStart += this.buf[0].length
      this.bufLen -= this.buf[0].length
      this.buf.shift()
    }
  }

  private slice(from: number, to: number): Int16Array {
    const out = new Int16Array(Math.max(0, to - from))
    let pos = this.bufStart
    let written = 0
    for (const c of this.buf) {
      const cEnd = pos + c.length
      if (cEnd > from && pos < to) {
        const a = Math.max(from, pos) - pos
        const b = Math.min(to, cEnd) - pos
        out.set(c.subarray(a, b), written)
        written += b - a
      }
      pos = cEnd
    }
    return out.subarray(0, written)
  }
}

export const samplesToMs = (n: number): number => Math.round((n / SAMPLE_RATE) * 1000)

export interface Part {
  start: number
  end: number
}

/**
 * 按一句话内部的说话人轮次（mt-diarize turns，相对这句话的样本下标）把这句话切成几段，尽量每段只有一个人：
 * 1) 相邻且局部标签相同的轮次合并；2) 短于 minMs 的轮次并入前一段（第一个则并入后一段）——
 *    之后不再按标签重新合并：句内的局部标签并不可靠，宁可多切一刀，再由每段的声纹做全局归属；
 * 3) 切点取两段之间空隙的中点（重叠时取后一段开始处）。只有一段时返回整句。
 */
export function splitByTurns(start: number, end: number, turns: Array<[number, number, number]>, minMs = 1000): Part[] {
  const minLen = (minMs / 1000) * SAMPLE_RATE
  const groups: Array<{ a: number; b: number; spk: number }> = []
  for (const [a, b, spk] of [...turns].sort((x, y) => x[0] - y[0])) {
    const last = groups.at(-1)
    if (last && last.spk === spk) last.b = Math.max(last.b, b)
    else groups.push({ a, b, spk })
  }
  const kept: typeof groups = []
  for (const g of groups) {
    const last = kept.at(-1)
    if (last && g.b - g.a < minLen) last.b = Math.max(last.b, g.b)
    else kept.push({ ...g })
  }
  if (kept.length > 1 && kept[0].b - kept[0].a < minLen) {
    kept[1].a = kept[0].a
    kept.shift()
  }
  if (kept.length <= 1) return [{ start, end }]
  // 切点；切出来短于 minLen 的段不切（并入前一段）
  const cuts: number[] = []
  let from = start
  for (let i = 0; i < kept.length - 1; i++) {
    const cut = kept[i].b <= kept[i + 1].a ? Math.round((kept[i].b + kept[i + 1].a) / 2) : kept[i + 1].a
    const abs = Math.min(end, start + cut)
    if (abs - from >= minLen && end - abs >= minLen) {
      cuts.push(abs)
      from = abs
    }
  }
  const bounds = [start, ...cuts, end]
  return bounds.slice(0, -1).map((a, i) => ({ start: a, end: bounds[i + 1] }))
}

const SNAP_FRAME = SAMPLE_RATE / 100 // 10ms
export const SNAP_RADIUS_MS = 250 // 窗口每 0.5 秒一个，切点与真正换人处最多差半个间隔

/**
 * 句内切点挪到前后 radiusMs 内最安静的 10ms 处（pcm 是这句话的录音，从时间线 start 开始）：按窗口找到的切点只精确到 0.5 秒，
 * 常落在字中间，切开的字两边都认不错；能量相同时取离原切点最近的。挪动后每段仍不短于原来最短一段的一半。
 */
export function snapCuts(parts: Part[], pcm: Int16Array, start: number, radiusMs = SNAP_RADIUS_MS): Part[] {
  if (parts.length < 2) return parts
  const radius = (radiusMs / 1000) * SAMPLE_RATE
  const minLen = Math.min(...parts.map((p) => p.end - p.start)) / 2
  const out = parts.map((p) => ({ ...p }))
  for (let i = 0; i < out.length - 1; i++) {
    const cut = out[i].end
    const lo = Math.max(cut - radius, out[i].start + minLen) - start
    const hi = Math.min(cut + radius, out[i + 1].end - minLen) - start
    let best = cut
    let bestE = Infinity
    for (let f = Math.max(0, Math.ceil(lo / SNAP_FRAME) * SNAP_FRAME); f + SNAP_FRAME <= Math.min(hi, pcm.length); f += SNAP_FRAME) {
      let e = 0
      for (let j = f; j < f + SNAP_FRAME; j++) e += pcm[j] * pcm[j]
      const at = start + f + SNAP_FRAME / 2
      if (e < bestE || (e === bestE && Math.abs(at - cut) < Math.abs(best - cut))) {
        bestE = e
        best = at
      }
    }
    out[i].end = best
    out[i + 1].start = best
  }
  return out
}

/**
 * 句内换人检测时带上句子前面的一段录音做参考（分段模型在几秒的短片段里分不清人）：
 * 把对 [ctxStart, end) 检测出的轮次换算成相对句子开头的位置，只保留与句子重叠的部分。
 */
export function turnsInUtterance(ctxStart: number, start: number, end: number, turns: Array<[number, number, number]>): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  for (const [a, b, spk] of turns) {
    const s0 = Math.max(start, ctxStart + a)
    const e0 = Math.min(end, ctxStart + b)
    if (e0 > s0) out.push([s0 - start, e0 - start, spk])
  }
  return out
}

export type FeedStep = { raw: [number, number] } | { pcm: Int16Array }

/**
 * 降噪输出接入分句（D-024）：fed = 已送入分句的位置；r = 降噪输出（at 为其在录音时间线上的起点，null = 失败或不可用）；
 * upTo = 这批对应的录音结尾。与已送入部分重叠、超出录音结尾的输出丢掉；缺口（降噪失败、进程重启后输出从新位置开始）用原始录音补上，
 * 保证分句看到的时间线连续、与录音对齐。
 */
export function planFeed(fed: number, r: { at: number; pcm: Int16Array } | null, upTo: number): FeedStep[] {
  if (!r) return upTo > fed ? [{ raw: [fed, upTo] }] : []
  const steps: FeedStep[] = []
  if (r.at > fed) {
    steps.push({ raw: [fed, r.at] })
    fed = r.at
  }
  // 收尾时降噪器会补出一小段空白（比输入长）：不超过录音结尾，否则暂停后再继续时会吃掉新录音的开头
  const end = Math.min(r.at + r.pcm.length, upTo)
  if (end > fed) steps.push({ pcm: r.pcm.subarray(fed - r.at, end - r.at) })
  return steps
}

/** 两路录音（麦克风 + 应用声音，D-033）允许落后会议时间线的样本数：超过才补静音 */
export const ALIGN_TOLERANCE = SAMPLE_RATE / 4

/**
 * 两路录音对齐到同一条会议时间线：target = 按真实时间此刻应录到的样本数（暂停不计）。
 * 这一路写入 chunk 后仍落后超过 tolerance（刚开始或继续时采集晚到、应用声音进程重启）时，返回先补的静音样本数。
 */
export function alignPad(written: number, chunk: number, target: number, tolerance = ALIGN_TOLERANCE): number {
  const behind = target - (written + chunk)
  return behind > tolerance ? Math.round(behind) : 0
}
