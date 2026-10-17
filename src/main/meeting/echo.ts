// 带 .ts 扩展名：被 test/ 直接导入（Node 原生剥离类型，不解析无扩展名的路径）
import { SAMPLE_RATE } from '../live.ts'
import type { Part } from './segmenter.ts'

/**
 * 外放回声检测（D-033）。纯逻辑，不依赖 electron。
 * 麦克风 + 应用声音一起录时，用户外放会让对方的声音被麦克风再录一遍。对麦克风的每一句，
 * 与同一时刻的应用声音比较能量包络：按 20ms 一帧取对数能量，在 [-AHEAD, LEAD] 的延迟范围内找最相关的对齐，
 * 再按 1.6 秒窗口逐段判断——包络高度相关、且应用声音此时也在发声的窗口算回声，从这句里去掉；
 * 现场的人与对方同时说话时，麦克风里以近处的人声为主，相关性低，整段保留（宁可重复一点，也不丢现场的话）。
 */

const FRAME = SAMPLE_RATE / 50 // 20ms
/** 应用声音窗口比麦克风句子提前的帧数：外放 → 麦克风的声学延迟 + 两路时间线的误差（最多 0.5 秒） */
export const ECHO_LEAD_FRAMES = 25
/** 麦克风可能比应用声音早的帧数（两路时间线误差） */
export const ECHO_AHEAD_FRAMES = 10
const WIN = 80 // 1.6 秒
const HOP = 20 // 0.4 秒
const ACTIVE_DB = 6 // 高出该路底噪（20% 分位）这么多才算在发声
/** 窗口内包络相关系数达到这个值算回声（按模拟外放 + 真人录音标定，见 test/meeting.test.ts 与 D-033） */
export const ECHO_CORR = 0.6
/** 窗口内麦克风发声的帧中，至少这个比例应用声音也在发声 */
const ECHO_COVERAGE = 0.6
const TAIL_FRAMES = 10 // 回声比原声多拖的混响尾巴（0.2 秒）
const MIN_KEEP_MS = 800 // 去掉回声后剩下的段短于此丢掉（只剩零星字）

const NFFT = 512
const BANDS = 16
/** 16 个频带（150Hz～7kHz 按对数等分）在 512 点 FFT 中的下标边界 */
const BAND_EDGES = Array.from({ length: BANDS + 1 }, (_, i) => Math.round((150 * (7000 / 150) ** (i / BANDS) * NFFT) / SAMPLE_RATE))
const HANN = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)))

/** 原地基 2 FFT（re、im 长度为 NFFT） */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
        re[i + k + len / 2] = re[i + k] - ar
        im[i + k + len / 2] = im[i + k] - ai
        re[i + k] += ar
        im[i + k] += ai
      }
    }
  }
}

interface Features {
  db: Float32Array // 每帧总能量（dB），判断是否在发声
  bands: Float32Array // [帧][频带] 对数能量
  frames: number
}

/** 每 20ms 一帧：总能量与 16 个频带的对数能量 */
export function features(pcm: Int16Array): Features {
  const frames = Math.floor(pcm.length / FRAME)
  const db = new Float32Array(frames)
  const bands = new Float32Array(frames * BANDS)
  const re = new Float32Array(NFFT)
  const im = new Float32Array(NFFT)
  for (let f = 0; f < frames; f++) {
    re.fill(0)
    im.fill(0)
    let sum = 0
    for (let i = 0; i < FRAME; i++) {
      const v = pcm[f * FRAME + i]
      sum += v * v
      re[i] = v * HANN[i]
    }
    db[f] = 10 * Math.log10(sum / FRAME + 1)
    fft(re, im)
    for (let b = 0; b < BANDS; b++) {
      let e = 0
      for (let k = BAND_EDGES[b]; k < Math.max(BAND_EDGES[b] + 1, BAND_EDGES[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k]
      bands[f * BANDS + b] = Math.log10(e + 1)
    }
  }
  return { db, bands, frames }
}

function activeMask(db: Float32Array): Uint8Array {
  const sorted = Array.from(db).sort((a, b) => a - b)
  const floor = sorted.length ? sorted[Math.floor(sorted.length * 0.2)] : 0
  // 数字静音（会议软件没人说话时输出全零）：底噪按 0 dB 算，门槛不低于 20 dB（约 ±10 的样本值）
  const th = Math.max(floor + ACTIVE_DB, 20)
  return Uint8Array.from(db, (v) => (v > th ? 1 : 0))
}

/**
 * 麦克风帧 [a, b) 与应用帧（按 lag 对齐）的“时间 × 频带”相关系数：只用任一方在发声的帧，每个频带先减去窗口内均值
 * （房间与扬声器的音色差异是每个频带固定的偏移，减掉均值后不影响；两个不同的人在同一时刻的频谱形状对不上）
 */
function corr(m: Features, mAct: Uint8Array, ap: Features, aAct: Uint8Array, a: number, b: number, lag: number): { r: number; coverage: number } {
  const idx: Array<[number, number]> = []
  let micActive = 0
  let both = 0
  for (let t = a; t < b; t++) {
    const j = t + ECHO_LEAD_FRAMES - lag
    if (j < 0 || j >= ap.frames) continue
    if (mAct[t]) {
      micActive++
      if (aAct[j]) both++
    }
    if (mAct[t] || aAct[j]) idx.push([t, j])
  }
  const coverage = micActive ? both / micActive : 0
  if (idx.length < 10) return { r: 0, coverage }
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let k = 0; k < BANDS; k++) {
    let mx = 0
    let my = 0
    for (const [t, j] of idx) {
      mx += m.bands[t * BANDS + k]
      my += ap.bands[j * BANDS + k]
    }
    mx /= idx.length
    my /= idx.length
    for (const [t, j] of idx) {
      const x = m.bands[t * BANDS + k] - mx
      const y = ap.bands[j * BANDS + k] - my
      sxy += x * y
      sxx += x * x
      syy += y * y
    }
  }
  if (sxx <= 1e-9 || syy <= 1e-9) return { r: 0, coverage }
  return { r: sxy / Math.sqrt(sxx * syy), coverage }
}

export interface EchoResult {
  /** 去掉回声后保留的段（样本下标，与传入的 start 同一时间线） */
  keep: Part[]
  /** 整句最佳对齐时的相关系数（诊断用） */
  corr: number
  /** 被判为回声的时长占比 */
  echoRatio: number
}

/**
 * mic = 麦克风这一句 [start, end)；app = 应用声音 [start - LEAD 帧, end + AHEAD 帧)（不足时可短，缺的部分按无声处理）。
 * 返回去掉回声后保留的段。
 */
export function removeEcho(start: number, end: number, mic: Int16Array, app: Int16Array, threshold = ECHO_CORR): EchoResult {
  const whole: EchoResult = { keep: [{ start, end }], corr: 0, echoRatio: 0 }
  if (mic.length < FRAME * 10 || app.length < FRAME) return whole
  const m = features(mic)
  const ap = features(app)
  const mAct = activeMask(m.db)
  const aAct = activeMask(ap.db)
  // 应用声音这段时间几乎没出声：不可能是回声
  if (aAct.reduce((s, v) => s + v, 0) < 5) return whole
  let best = { r: -1, lag: 0 }
  for (let lag = -ECHO_AHEAD_FRAMES; lag <= ECHO_LEAD_FRAMES; lag++) {
    const { r } = corr(m, mAct, ap, aAct, 0, m.frames, lag)
    if (r > best.r) best = { r, lag }
  }
  // 逐窗口判断（窗口内在最佳对齐附近 ±2 帧再找一次：长句里声学延迟略有变化）
  const echoFrame = new Uint8Array(m.frames)
  const starts: number[] = []
  for (let a = 0; a + WIN <= m.frames; a += HOP) starts.push(a)
  if (!starts.length || starts.at(-1)! + WIN < m.frames) starts.push(Math.max(0, m.frames - WIN))
  for (const a of starts) {
    const b = Math.min(m.frames, a + WIN)
    let w = { r: -1, coverage: 0 }
    for (let d = -2; d <= 2; d++) {
      const c = corr(m, mAct, ap, aAct, a, b, best.lag + d)
      if (c.r > w.r) w = c
    }
    if (w.r < threshold || w.coverage < ECHO_COVERAGE) continue
    // 只去掉窗口里应用声音在发声（含之后约 0.2 秒的混响尾巴）的帧：现场的人在对方开口前说的话不跟着被去掉
    for (let t = a; t < b; t++) {
      const j = t + ECHO_LEAD_FRAMES - best.lag
      for (let k = j - TAIL_FRAMES; k <= j + 2; k++) {
        if (k >= 0 && k < ap.frames && aAct[k]) {
          echoFrame[t] = 1
          break
        }
      }
    }
  }
  // 只有发声的帧才计入回声占比；回声段之间夹着的静音也一起去掉
  let echoActive = 0
  let micActive = 0
  for (let t = 0; t < m.frames; t++) {
    if (!mAct[t]) continue
    micActive++
    if (echoFrame[t]) echoActive++
  }
  if (!echoActive) return { ...whole, corr: best.r }
  const keep: Part[] = []
  let runStart = -1
  const minKeep = (MIN_KEEP_MS / 1000) * SAMPLE_RATE
  const flush = (to: number) => {
    if (runStart < 0) return
    const s = start + runStart * FRAME
    const e = to >= m.frames ? end : start + to * FRAME
    // 只保留含有发声帧、且够长的段
    let voiced = false
    for (let t = runStart; t < Math.min(to, m.frames); t++) if (mAct[t]) voiced = true
    if (voiced && e - s >= minKeep) keep.push({ start: s, end: e })
    runStart = -1
  }
  for (let t = 0; t < m.frames; t++) {
    if (!echoFrame[t]) {
      if (runStart < 0) runStart = t
    } else flush(t)
  }
  flush(m.frames)
  return { keep, corr: best.r, echoRatio: micActive ? echoActive / micActive : 0 }
}
