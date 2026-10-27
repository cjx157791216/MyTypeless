import { existsSync } from 'fs'
import { mkdir, open, rename, stat, unlink } from 'fs/promises'
import { dirname, extname, join } from 'path'
import { SAMPLE_RATE } from '../live.ts'
import { wavHeader } from '../wav.ts'

/**
 * 保存会议录音（D-044）：会议整理时把临时录音（每路一个 16kHz 单声道 Int16 PCM 文件，两路已对齐到同一条时间线）
 * 写成一个 WAV 文件放到用户选的文件夹；麦克风 + 应用声音时两路混成一路。纯逻辑（只用 fs），被 test/ 导入。
 */

const CHUNK = SAMPLE_RATE * 10 // 每次读写 10 秒

/** 「2026-10-22 0905 周会.wav」：日期在前便于按时间排序；没起标题（默认标题）时只写“会议” */
export function recordingFileName(title: string, startedAt: number): string {
  const d = new Date(startedAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
  const name = /^\d+ 月 \d+ 日 \d\d:\d\d 的会议$/.test(title.trim())
    ? ''
    : title
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
        .replace(/[. ]+$/, '') // Windows 不允许以点或空格结尾
  return `${stamp} ${name || '会议'}.wav`
}

/**
 * recordingFileName 的反过程（导入录音时还原会议的开始时间与主题，D-046）：「2026-10-22 0905 周会.wav」→ 开始时间与「周会」；
 * 「… 会议.wav」（没起主题）的主题为 null；同名序号「 (2)」去掉。不是这种文件名时返回 null
 */
export function parseRecordingFileName(file: string): { startedAt: number; title: string | null } | null {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)(\d\d) (.+?)(?: \(\d+\))?\.wav$/i.exec(file)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const title = m[6].trim()
  return { startedAt: new Date(y, mo - 1, d, h, mi).getTime(), title: title === '会议' ? null : title }
}

/** 文件夹里已有同名文件时加序号「… (2).wav」，不覆盖 */
export function uniquePath(dir: string, file: string, exists: (path: string) => boolean = existsSync): string {
  const ext = extname(file)
  const base = file.slice(0, file.length - ext.length)
  let path = join(dir, file)
  for (let i = 2; exists(path); i++) path = join(dir, `${base} (${i})${ext}`)
  return path
}

/** 几路逐点相加（超出范围削顶）；短的一路按静音补齐到 n */
export function mixPcm(parts: Int16Array[], n: number): Int16Array {
  if (parts.length === 1 && parts[0].length === n) return parts[0]
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const p of parts) if (i < p.length) s += p[i]
    out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s
  }
  return out
}

/**
 * 把几路临时录音混成一个 WAV 写到 dest（先写 dest.part，写完再改名，失败时删掉）；返回写入的采样数。
 * 按块读写，几小时的会议也不占用大量内存。
 */
export async function saveRecording(paths: string[], dest: string, chunk = CHUNK): Promise<number> {
  const sizes = await Promise.all(paths.map((p) => stat(p).then((s) => Math.floor(s.size / 2))))
  const total = Math.max(0, ...sizes)
  await mkdir(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const inputs = await Promise.all(paths.map((p) => open(p, 'r')))
  let out: Awaited<ReturnType<typeof open>> | null = null
  try {
    out = await open(part, 'w')
    await out.write(wavHeader(total * 2, SAMPLE_RATE, 1))
    for (let pos = 0; pos < total; pos += chunk) {
      const n = Math.min(chunk, total - pos)
      const pcm = await Promise.all(
        inputs.map(async (f) => {
          const buf = Buffer.alloc(n * 2)
          const { bytesRead } = await f.read(buf, 0, buf.length, pos * 2)
          return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(bytesRead / 2))
        })
      )
      const mixed = mixPcm(pcm, n)
      await out.write(Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength))
    }
    await out.close()
    out = null
    await rename(part, dest)
    return total
  } catch (err) {
    await out?.close().catch(() => undefined)
    await unlink(part).catch(() => undefined)
    throw err
  } finally {
    await Promise.all(inputs.map((f) => f.close().catch(() => undefined)))
  }
}
