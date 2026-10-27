import { open, stat } from 'fs/promises'
import { SAMPLE_RATE } from '../live.ts'

/**
 * 导入录音（D-046）：把 WAV 文件转成会议临时录音的格式（16kHz 单声道 s16le）。支持整数 PCM（8/16/24/32 位）与浮点（32/64 位），
 * 任意采样率、声道数（下混成单声道）；按块读写，几小时的录音也不占用大量内存。纯逻辑（只用 fs），被 test/ 导入。
 */

export interface WavInfo {
  format: 'int' | 'float'
  channels: number
  rate: number
  bits: number
  dataOffset: number
  dataBytes: number
  /** 时长（毫秒） */
  durationMs: number
}

const HEAD_BYTES = 1 << 20 // data 块之前的元数据（LIST、bext 等）最多读这么多
const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

/** 解析 WAV 头；不是 WAV 或格式不支持时抛出带说明的错误。fileSize 用于修正流式写入时没填好的 data 长度 */
export function parseWavHeader(head: Buffer, fileSize: number): WavInfo {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件（目前只能导入 .wav 录音）')
  }
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataBytes' | 'durationMs'> | null = null
  let pos = 12
  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4)
    const size = head.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ' && body + 16 <= head.length) {
      let tag = head.readUInt16LE(body)
      const channels = head.readUInt16LE(body + 2)
      const rate = head.readUInt32LE(body + 4)
      const bits = head.readUInt16LE(body + 14)
      // WAVE_FORMAT_EXTENSIBLE：真正的格式在子格式 GUID 的前两个字节
      if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= head.length) tag = head.readUInt16LE(body + 24)
      const format = tag === WAVE_FORMAT_PCM ? 'int' : tag === WAVE_FORMAT_FLOAT ? 'float' : null
      if (!format) throw new Error('不支持这种 WAV 编码（只支持未压缩的 PCM / 浮点）')
      if ((format === 'int' && ![8, 16, 24, 32].includes(bits)) || (format === 'float' && ![32, 64].includes(bits))) {
        throw new Error(`不支持 ${bits} 位的 WAV`)
      }
      if (channels < 1 || channels > 32 || rate < 4000 || rate > 768_000) throw new Error('WAV 的声道数或采样率不正确')
      fmt = { format, channels, rate, bits }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV 文件头不完整')
      const frame = fmt.channels * (fmt.bits / 8)
      // 流式写入的录音常把长度写成 0 或 0xFFFFFFFF；超过 4GB 的也截断了：都按文件实际大小算
      const rest = Math.max(0, fileSize - body)
      const bytes = size === 0 || size === 0xffffffff || size > rest ? rest : size
      const dataBytes = bytes - (bytes % frame)
      return { ...fmt, dataOffset: body, dataBytes, durationMs: Math.round(((dataBytes / frame) * 1000) / fmt.rate) }
    }
    pos = body + size + (size % 2) // 块按偶数字节对齐
  }
  throw new Error(fmt ? 'WAV 文件里没有找到录音数据' : 'WAV 文件头不完整')
}

export async function readWavInfo(path: string): Promise<WavInfo> {
  const size = (await stat(path)).size
  const f = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size))
    const { bytesRead } = await f.read(head, 0, head.length, 0)
    return parseWavHeader(head.subarray(0, bytesRead), size)
  } finally {
    await f.close()
  }
}

/** 交错的多声道样本 → 单声道 float（-1..1，各声道取平均） */
export function decodeFrames(buf: Buffer, info: Pick<WavInfo, 'format' | 'channels' | 'bits'>): Float32Array {
  const bytes = info.bits / 8
  const ch = info.channels
  const frames = Math.floor(buf.length / (bytes * ch))
  const out = new Float32Array(frames)
  const read =
    info.format === 'float'
      ? bytes === 4
        ? (o: number) => buf.readFloatLE(o)
        : (o: number) => buf.readDoubleLE(o)
      : bytes === 1
        ? (o: number) => (buf[o] - 128) / 128
        : bytes === 2
          ? (o: number) => buf.readInt16LE(o) / 32768
          : bytes === 3
            ? (o: number) => buf.readIntLE(o, 3) / 8388608
            : (o: number) => buf.readInt32LE(o) / 2147483648
  for (let i = 0, o = 0; i < frames; i++) {
    let s = 0
    for (let c = 0; c < ch; c++, o += bytes) s += read(o)
    out[i] = s / ch
  }
  return out
}

/**
 * 任意采样率 → 16kHz：加窗 sinc 低通（7.6kHz，降采样时防混叠）+ 256 相位插值表，分数位置跨块保留（按块送入与一次送入结果相同）。
 * 输入已是 16kHz 时原样转成 Int16
 */
export class Resampler {
  static readonly HALF = 16
  static readonly PHASES = 256
  private readonly step: number
  private readonly table: Float32Array | null
  private history: Float32Array
  private pos: number

  constructor(rate: number) {
    const half = Resampler.HALF
    const phases = Resampler.PHASES
    this.step = rate / SAMPLE_RATE
    this.history = new Float32Array(rate === SAMPLE_RATE ? 0 : half)
    this.pos = half
    if (rate === SAMPLE_RATE) {
      this.table = null
      return
    }
    // 截止频率取 7.6kHz 与输入奈奎斯特频率中较低者（升采样时不削掉原有的高频）
    const cutoff = (2 * Math.min(7600, rate * 0.475)) / rate
    const table = new Float32Array((phases + 1) * 2 * half)
    for (let ph = 0; ph <= phases; ph++) {
      const frac = ph / phases
      for (let k = 1 - half; k <= half; k++) {
        const x = k - frac
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / half) // Hann 窗
        const t = Math.PI * cutoff * x
        table[ph * 2 * half + k + half - 1] = Math.abs(x) < 1e-9 ? cutoff : ((cutoff * Math.sin(t)) / t) * w
      }
    }
    this.table = table
  }

  process(mono: Float32Array): Int16Array {
    if (!this.table) return toInt16(mono)
    const half = Resampler.HALF
    const merged = new Float32Array(this.history.length + mono.length)
    merged.set(this.history)
    merged.set(mono, this.history.length)
    const out = new Int16Array(Math.max(0, Math.ceil((merged.length - half - this.pos) / this.step) + 1))
    let n = 0
    while (Math.floor(this.pos) + half < merged.length) {
      const i0 = Math.floor(this.pos)
      const base = Math.round((this.pos - i0) * Resampler.PHASES) * 2 * half
      let sum = 0
      for (let k = 0; k < 2 * half; k++) sum += merged[i0 - half + 1 + k] * this.table[base + k]
      out[n++] = clamp16(sum)
      this.pos += this.step
    }
    const drop = Math.floor(this.pos) - half
    this.history = drop > 0 ? merged.slice(drop) : merged
    if (drop > 0) this.pos -= drop
    return out.subarray(0, n)
  }
}

const clamp16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))

function toInt16(mono: Float32Array): Int16Array {
  const out = new Int16Array(mono.length)
  for (let i = 0; i < mono.length; i++) out[i] = clamp16(mono[i])
  return out
}

/**
 * 把 WAV 转成 16kHz 单声道 s16le 写到 dest（覆盖）；返回写入的样本数。onProgress(已读字节, 总字节) 每块调用一次。
 * 16 位单声道 16kHz（MyTypeless 保存的会议录音）直接拷贝数据，结果逐位相同
 */
export async function convertWav(src: string, dest: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const info = await readWavInfo(src)
  const frame = info.channels * (info.bits / 8)
  const block = frame * Math.max(1, Math.round(info.rate * 10)) // 每次读 10 秒
  const same = info.format === 'int' && info.bits === 16 && info.channels === 1 && info.rate === SAMPLE_RATE
  const resampler = new Resampler(info.rate)
  const input = await open(src, 'r')
  let out: Awaited<ReturnType<typeof open>> | null = null
  let written = 0
  try {
    out = await open(dest, 'w')
    for (let done = 0; done < info.dataBytes; ) {
      const buf = Buffer.alloc(Math.min(block, info.dataBytes - done))
      const { bytesRead } = await input.read(buf, 0, buf.length, info.dataOffset + done)
      if (!bytesRead) break
      done += bytesRead
      const data = buf.subarray(0, bytesRead - (bytesRead % frame))
      const pcm = same ? new Int16Array(data.buffer, data.byteOffset, data.length / 2) : resampler.process(decodeFrames(data, info))
      if (pcm.length) await out.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      written += pcm.length
      onProgress?.(done, info.dataBytes)
    }
    return written
  } finally {
    await out?.close().catch(() => undefined)
    await input.close().catch(() => undefined)
  }
}
