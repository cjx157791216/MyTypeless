import { open, stat } from 'fs/promises'
import { SAMPLE_RATE } from '../live.ts'

/**
 * 导入录音（D-046）：把 WAV / MP3 文件转成会议临时录音的格式（16kHz 单声道 s16le）。
 * WAV：支持整数 PCM（8/16/24/32 位）与浮点（32/64 位），任意采样率、声道数（下混成单声道）。
 * MP3：MPEG-1/2/2.5 Layer 1/2/3，用 mpg123-decoder（mpg123 编译成的 WASM）流式解码；时长靠逐帧扫帧头累计，VBR 也准确。
 * 都按块读写，几小时的录音也不占用大量内存。纯逻辑（只用 fs），被 test/ 导入。
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

/** 按文件头认格式：WAV（RIFF/WAVE）或 MP3（ID3 标签 / MPEG 帧同步），认不出返回 null */
export function sniffAudio(head: Buffer): 'wav' | 'mp3' | null {
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  if (head.length >= 3 && head.toString('ascii', 0, 3) === 'ID3') return 'mp3'
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3'
  return null
}

async function audioKind(path: string): Promise<'wav' | 'mp3'> {
  const f = await open(path, 'r')
  try {
    const head = Buffer.alloc(12)
    const { bytesRead } = await f.read(head, 0, head.length, 0)
    const kind = sniffAudio(head.subarray(0, bytesRead))
    if (!kind) throw new Error('不是支持的录音格式（目前支持 .wav 与 .mp3）')
    return kind
  } finally {
    await f.close().catch(() => undefined)
  }
}

export interface AudioInfo {
  kind: 'wav' | 'mp3'
  /** 时长（毫秒） */
  durationMs: number
}

/** 读文件类型与时长；认不出或文件损坏时抛出带说明的错误 */
export async function readAudioInfo(path: string): Promise<AudioInfo> {
  const kind = await audioKind(path)
  if (kind === 'wav') return { kind, durationMs: (await readWavInfo(path)).durationMs }
  return { kind, durationMs: (await readMp3Info(path)).durationMs }
}

/** 按块读文件、扫帧头算出的 MP3 信息 */
export interface Mp3Info extends AudioInfo {
  /** 第一帧开始的位置（开头的 ID3v2 等标签不算） */
  dataOffset: number
  /** 最后一帧结束的位置 */
  framesEnd: number
  /** 第一帧的采样率 */
  rate: number
  /** 第一帧的声道数 */
  channels: number
  /** 按帧头累计的样本总数 */
  samples: number
}

interface Mp3Frame {
  /** 整帧字节数（含帧头，有 CRC 时含 CRC） */
  len: number
  samples: number
  rate: number
  channels: number
}

const MP3_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000] // MPEG2.5
}
// 层（MPEG 帧头里的层位：1 = Layer III，2 = Layer II，3 = Layer I）→ 各比特率档（kbps），索引 = 帧头的比特率位
const MP3_BITRATES_V1: Record<number, readonly number[]> = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
}
const MP3_BITRATES_V2: Record<number, readonly number[]> = {
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
}

/** 解析 b[i] 起的帧头；不是帧同步、保留的版本 / 层或无效的比特率 / 采样率档时返回 null */
function parseMp3Frame(b: Buffer, i: number): Mp3Frame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null
  const version = (b[i + 1] >> 3) & 3
  const layer = (b[i + 1] >> 1) & 3
  const rateIdx = (b[i + 2] >> 2) & 3
  const rates = MP3_RATES[version]
  if (!rates || layer === 0 || rateIdx === 3) return null
  const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[layer][(b[i + 2] >> 4) & 15]
  if (!bitrate) return null
  const rate = rates[rateIdx]
  const pad = (b[i + 2] >> 1) & 1
  // 帧长 = floor(槽系数 × 比特率 / 采样率) + 填充位；Layer I 槽系数 12、槽 4 字节，Layer II/III 槽系数 144（Layer III 在 MPEG2/2.5 是 72）
  const slots = layer === 3 ? 12 : layer === 2 || version === 3 ? 144 : 72
  const len = layer === 3 ? (Math.floor((12 * bitrate * 1000) / rate) + pad) * 4 : Math.floor((slots * bitrate * 1000) / rate) + pad
  // 每帧样本数：Layer I 384，Layer II 1152，Layer III 在 MPEG1 是 1152、MPEG2/2.5 是 576
  const samples = layer === 3 ? 384 : layer === 2 || version === 3 ? 1152 : 576
  return { len, samples, rate, channels: ((b[i + 3] >> 6) & 3) === 3 ? 1 : 2 }
}

/**
 * MP3 帧头扫描（纯逻辑）：按帧头逐帧累计样本数得到时长，VBR 也准确；跳过开头的 ID3v2 标签，
 * 帧间垃圾按字节重同步。分块 push 与一次送入结果相同（不完整的帧留到下一块）。
 */
export class Mp3FrameScan {
  dataOffset = -1
  framesEnd = 0
  rate = 0
  channels = 0
  samples = 0

  private buf: Buffer = Buffer.alloc(0)
  private base = 0 // buf[0] 在文件里的绝对位置

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const used = this.scan(false)
    if (used > 0) {
      this.base += used
      this.buf = this.buf.subarray(used)
    }
  }

  end(): void {
    this.scan(true)
    this.base += this.buf.length
    this.buf = Buffer.alloc(0)
  }

  get durationMs(): number {
    return this.rate ? Math.round((this.samples * 1000) / this.rate) : 0
  }

  /** 扫描缓冲，返回可丢弃的前缀长度。非 final 时停在不完整帧前，保住帧头等下一块 */
  private scan(final: boolean): number {
    const b = this.buf
    let i = 0
    // 开头的 ID3v2 标签：10 字节头 + syncsafe 长度（有尾标记再加 10 字节）
    if (this.base === 0 && b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') {
      if (b.length < 10) return final ? b.length : 0
      const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
      const skip = 10 + size + (b[5] & 0x10 ? 10 : 0)
      if (b.length < skip) return final ? b.length : 0
      i = skip
    }
    while (i < b.length) {
      if (b[i] === 0xff) {
        const frame = i + 4 <= b.length ? parseMp3Frame(b, i) : null
        if (frame) {
          if (i + frame.len > b.length && !final) break // 帧还没到齐：保住帧头等下一块
          if (!this.rate) {
            this.rate = frame.rate
            this.channels = frame.channels
            this.dataOffset = this.base + i
          }
          this.samples += frame.samples
          this.framesEnd = this.base + i + frame.len
          i += frame.len
          continue
        }
        // 帧头还没到齐（不足 4 字节）：等下一块
        if (!final && i + 4 > b.length) break
      }
      i++ // 假同步：按字节重同步
    }
    return final ? b.length : i
  }
}

const MP3_SCAN_BLOCK = 1 << 20

/** 块读 MP3、逐帧扫帧头；一帧都没有时抛错（文件可能损坏） */
export async function readMp3Info(path: string): Promise<Mp3Info> {
  const size = (await stat(path)).size
  const f = await open(path, 'r')
  try {
    const scan = new Mp3FrameScan()
    const buf = Buffer.alloc(Math.min(MP3_SCAN_BLOCK, size))
    for (let pos = 0; pos < size; ) {
      const { bytesRead } = await f.read(buf, 0, buf.length, pos)
      if (!bytesRead) break
      pos += bytesRead
      scan.push(buf.subarray(0, bytesRead))
    }
    scan.end()
    if (!scan.rate) throw new Error('不是有效的 MP3 文件（文件可能损坏）')
    return {
      kind: 'mp3',
      durationMs: scan.durationMs,
      dataOffset: scan.dataOffset,
      framesEnd: scan.framesEnd,
      rate: scan.rate,
      channels: scan.channels,
      samples: scan.samples
    }
  } finally {
    await f.close().catch(() => undefined)
  }
}

/** 多声道解码结果 → 单声道 float（各声道取平均） */
function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(channels[0].length)
  for (let i = 0; i < out.length; i++) {
    let s = 0
    for (const ch of channels) s += ch[i]
    out[i] = s / channels.length
  }
  return out
}

const MP3_DECODE_BLOCK = 1 << 18

/**
 * 把 MP3 转成 16kHz 单声道 s16le 写到 dest（覆盖）；返回写入的样本数。
 * mpg123（WASM）是流式解码器，decode 接受任意大小的数据、跨块的不完整帧内部缓存；解码出的浮点样本下混、重采样后写盘
 */
export async function convertMp3(src: string, dest: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const size = (await stat(src)).size
  const { MPEGDecoder } = await import('mpg123-decoder')
  const decoder = new MPEGDecoder()
  await decoder.ready
  const input = await open(src, 'r')
  let out: Awaited<ReturnType<typeof open>> | null = null
  let written = 0
  let resampler: Resampler | null = null
  let rate = 0
  try {
    out = await open(dest, 'w')
    const buf = Buffer.alloc(Math.min(MP3_DECODE_BLOCK, size))
    for (let done = 0; done < size; ) {
      const { bytesRead } = await input.read(buf, 0, buf.length, done)
      if (!bytesRead) break
      done += bytesRead
      const r = decoder.decode(buf.subarray(0, bytesRead))
      if (r.samplesDecoded) {
        if (r.sampleRate !== rate) {
          rate = r.sampleRate
          resampler = new Resampler(rate)
        }
        const pcm = resampler!.process(mixToMono(r.channelData))
        if (pcm.length) await out.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        written += pcm.length
      }
      onProgress?.(done, size)
    }
    return written
  } finally {
    decoder.free()
    await out?.close().catch(() => undefined)
    await input.close().catch(() => undefined)
  }
}

/** 导入录音的统一入口：按文件头分发到 WAV / MP3 的转换 */
export async function convertAudio(src: string, dest: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  if ((await audioKind(src)) === 'wav') return convertWav(src, dest, onProgress)
  return convertMp3(src, dest, onProgress)
}
