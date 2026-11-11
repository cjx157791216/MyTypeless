import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Mp3FrameScan, Resampler, convertAudio, convertWav, decodeFrames, parseWavHeader, readAudioInfo, readMp3Info, readWavInfo } from '../src/main/meeting/import-audio.ts'
import { wavHeader } from '../src/main/wav.ts'

// 导入录音（D-046）：WAV / MP3 解析、下混、重采样到 16kHz 单声道

const SR = 16000

/** 任意格式的 WAV：samples 为每帧各声道的值（-1..1） */
function makeWav(opts: { rate: number; channels: number; bits: number; float?: boolean; extensible?: boolean; dataSize?: number; extraChunk?: boolean }, frames: number[][]): Buffer {
  const { rate, channels, bits } = opts
  const bytes = bits / 8
  const data = Buffer.alloc(frames.length * channels * bytes)
  let o = 0
  for (const f of frames) {
    for (let c = 0; c < channels; c++, o += bytes) {
      const v = f[c] ?? 0
      if (opts.float) bytes === 4 ? data.writeFloatLE(v, o) : data.writeDoubleLE(v, o)
      else if (bytes === 1) data[o] = Math.round(v * 127) + 128
      else if (bytes === 2) data.writeInt16LE(Math.round(v * 32767), o)
      else if (bytes === 3) data.writeIntLE(Math.round(v * 8388607), o, 3)
      else data.writeInt32LE(Math.round(v * 2147483647), o)
    }
  }
  const fmtSize = opts.extensible ? 40 : 16
  const fmt = Buffer.alloc(8 + fmtSize)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(fmtSize, 4)
  fmt.writeUInt16LE(opts.extensible ? 0xfffe : opts.float ? 3 : 1, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(rate, 12)
  fmt.writeUInt32LE(rate * channels * bytes, 16)
  fmt.writeUInt16LE(channels * bytes, 20)
  fmt.writeUInt16LE(bits, 22)
  if (opts.extensible) {
    fmt.writeUInt16LE(22, 24)
    fmt.writeUInt16LE(bits, 26)
    fmt.writeUInt16LE(opts.float ? 3 : 1, 32) // 子格式 GUID 的前两个字节
  }
  const extra = opts.extraChunk ? Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0', 'ascii')]) : Buffer.alloc(0)
  const dataHead = Buffer.alloc(8)
  dataHead.write('data', 0, 'ascii')
  dataHead.writeUInt32LE(opts.dataSize ?? data.length, 4)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(4 + fmt.length + extra.length + 8 + data.length, 4)
  riff.write('WAVE', 8, 'ascii')
  return Buffer.concat([riff, fmt, extra, dataHead, data])
}

const sine = (rate: number, freq: number, seconds: number, amp = 0.5) => Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate))

const tmp = () => mkdtempSync(join(tmpdir(), 'mt import '))
const readPcm = (path: string) => {
  const b = readFileSync(path)
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2)
}

/** 某频率的幅度（单点 DFT） */
function amplitude(pcm: Int16Array, freq: number): number {
  let re = 0
  let im = 0
  for (let i = 0; i < pcm.length; i++) {
    re += pcm[i] * Math.cos((2 * Math.PI * freq * i) / SR)
    im += pcm[i] * Math.sin((2 * Math.PI * freq * i) / SR)
  }
  return (2 * Math.hypot(re, im)) / pcm.length / 32767
}

test('WAV 头：整数 / 浮点 / 扩展格式、跳过其他块、流式写入时长度为 0 按文件大小算', () => {
  const frames = sine(48000, 440, 0.1).map((v) => [v, -v])
  const a = makeWav({ rate: 48000, channels: 2, bits: 16, extraChunk: true }, frames)
  const ia = parseWavHeader(a, a.length)
  assert.deepEqual({ ...ia, dataOffset: 0 }, { format: 'int', channels: 2, rate: 48000, bits: 16, dataOffset: 0, dataBytes: frames.length * 4, durationMs: 100 })
  const b = makeWav({ rate: 44100, channels: 1, bits: 32, float: true, extensible: true, dataSize: 0 }, sine(44100, 440, 0.5).map((v) => [v]))
  const ib = parseWavHeader(b, b.length)
  assert.equal(ib.format, 'float')
  assert.equal(ib.dataBytes, Math.round(44100 * 0.5) * 4)
  const c = makeWav({ rate: 16000, channels: 1, bits: 16, dataSize: 0xffffffff }, [[0], [0.5]])
  assert.equal(parseWavHeader(c, c.length).dataBytes, 4)
})

test('WAV 头：不是 WAV、压缩编码、头不完整时报出说明', () => {
  assert.throws(() => parseWavHeader(Buffer.from('ID3\u0003 not a wav file at all'), 24), /不是 WAV/)
  const adpcm = makeWav({ rate: 16000, channels: 1, bits: 16 }, [[0]])
  adpcm.writeUInt16LE(2, 20) // MS ADPCM
  assert.throws(() => parseWavHeader(adpcm, adpcm.length), /不支持这种 WAV 编码/)
  const ok = makeWav({ rate: 16000, channels: 1, bits: 16 }, [[0]])
  assert.throws(() => parseWavHeader(ok.subarray(0, 30), ok.length), /文件头不完整/)
})

test('解码：各种位深与声道下混成单声道', () => {
  for (const [bits, float] of [[8, false], [16, false], [24, false], [32, false], [32, true], [64, true]] as const) {
    const w = makeWav({ rate: 16000, channels: 2, bits, float }, [[0.5, 0.25], [-0.5, -0.5]])
    const info = parseWavHeader(w, w.length)
    const mono = decodeFrames(w.subarray(info.dataOffset), info)
    assert.equal(mono.length, 2)
    assert.ok(Math.abs(mono[0] - 0.375) < 0.01, `${bits} 位：${mono[0]}`)
    assert.ok(Math.abs(mono[1] + 0.5) < 0.01, `${bits} 位：${mono[1]}`)
  }
})

test('重采样：48k / 44.1k → 16k 长度正确、音调不变、超过 8kHz 的被滤掉；分块送入与一次送入结果相同', () => {
  for (const rate of [48000, 44100, 22050, 8000]) {
    const x = Float32Array.from(sine(rate, 1000, 1, 0.5))
    const whole = new Resampler(rate).process(x)
    // 滤波器尾巴：末尾最多少 16 个输入样本（不到 2 毫秒）
    assert.ok(Math.abs(whole.length - SR) <= Math.ceil((16 * SR) / rate) + 2, `${rate}：${whole.length} 个样本`)
    assert.ok(Math.abs(amplitude(whole.subarray(200, 15800), 1000) - 0.5) < 0.03, `${rate}：1kHz 幅度保持`)
    const r = new Resampler(rate)
    const parts: Int16Array[] = []
    for (let off = 0; off < x.length; off += 1234) parts.push(r.process(x.subarray(off, off + 1234)))
    const chunked = Int16Array.from(parts.flatMap((p) => Array.from(p)))
    assert.deepEqual(chunked, whole, `${rate}：分块结果相同`)
  }
  const high = new Resampler(48000).process(Float32Array.from(sine(48000, 12000, 1, 0.5)))
  assert.ok(amplitude(high.subarray(200, 15800), 4000) < 0.01, '12kHz 不混叠成 4kHz')
})

test('转换：保存的会议录音（16k 单声道 16 位）原样拷贝；48k 立体声转成 16k 单声道', async () => {
  const dir = tmp()
  const pcm = Int16Array.from({ length: SR * 2 }, (_, i) => (i * 37) % 30000 - 15000)
  const src = join(dir, '2026-10-22 0905 周会.wav')
  writeFileSync(src, Buffer.concat([wavHeader(pcm.length * 2), Buffer.from(pcm.buffer)]))
  const dest = join(dir, 'a.pcm')
  const progress: number[] = []
  assert.equal(await convertWav(src, dest, (done, all) => progress.push(done / all)), pcm.length)
  assert.deepEqual(readPcm(dest), pcm)
  assert.equal(progress.at(-1), 1)
  assert.equal((await readWavInfo(src)).durationMs, 2000)

  const stereo = join(dir, 'b.wav')
  writeFileSync(stereo, makeWav({ rate: 48000, channels: 2, bits: 24 }, sine(48000, 500, 12).map((v) => [v, v])))
  const n = await convertWav(stereo, join(dir, 'b.pcm'))
  const out = readPcm(join(dir, 'b.pcm'))
  assert.equal(out.length, n)
  assert.ok(Math.abs(n - SR * 12) <= 20, `${n} 个样本`)
  assert.ok(Math.abs(amplitude(out.subarray(SR, SR * 11), 500) - 0.5) < 0.03)
})

test('转换：不是 WAV 时报错', async () => {
  const dir = tmp()
  const src = join(dir, 'x.wav')
  writeFileSync(src, 'hello')
  await assert.rejects(convertWav(src, join(dir, 'x.pcm')), /不是 WAV/)
})

test('MP3 帧扫描：各版本帧长公式、声道数', () => {
  // [版本字节 b1, 比特率字节 b2, 帧长, 每帧样本数, 采样率]
  for (const [b1, b2, len, samples, rate] of [
    [0xfb, 0x90, 417, 1152, 44100], // MPEG1 L3：144×128k/44100（b2 idx9 = 128k，rate idx0 = 44100）
    [0xfd, 0x90, 522, 1152, 44100], // MPEG1 L2：144×160k/44100（b2 idx9 = 160k）
    [0xff, 0x90, 312, 384, 44100], // MPEG1 L1：(12×288k/44100)×4（b2 idx9 = 288k）
    [0xf3, 0x40, 104, 576, 22050], // MPEG2 L3：72×32k/22050（b2 idx4 = 32k，rate idx0 = 22050）
    [0xe3, 0x38, 216, 576, 8000] // MPEG2.5 L3：72×24k/8000
  ] as const) {
    const frame = Buffer.concat([Buffer.from([0xff, b1, b2, 0x00]), Buffer.alloc(len - 4)])
    const s = new Mp3FrameScan()
    s.push(frame)
    s.end()
    assert.equal(s.samples, samples, `b1=${b1.toString(16)}`)
    assert.equal(s.rate, rate)
    assert.equal(s.channels, 2)
    assert.equal(s.dataOffset, 0)
    assert.equal(s.framesEnd, len)
    const mono = Buffer.from([0xff, b1, b2, 0xc0])
    const sm = new Mp3FrameScan()
    sm.push(mono)
    sm.end()
    assert.equal(sm.channels, 1)
  }
})

test('MP3 帧扫描：跳过 ID3 与垃圾、填充位改变帧长、分块送入与一次送入相同', () => {
  const id3 = Buffer.alloc(20)
  id3.write('ID3', 0, 'ascii')
  id3[6] = 0 // 标签体 10 字节（syncsafe），总共跳 20
  id3[9] = 10
  const garbage = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0x00, 0x21, 0x43, 0x65, 0x87, 0xa9, 0x00, 0x11])
  const frame = (pad: boolean) => Buffer.concat([Buffer.from([0xff, 0xfb, pad ? 0x92 : 0x90, 0x00]), Buffer.alloc((pad ? 418 : 417) - 4)])
  const whole = Buffer.concat([id3, garbage, frame(false), frame(true), frame(false)])
  const s = new Mp3FrameScan()
  s.push(whole)
  s.end()
  assert.equal(s.dataOffset, 33)
  assert.equal(s.framesEnd, whole.length)
  assert.equal(s.samples, 3 * 1152)
  assert.equal(s.rate, 44100)
  assert.deepEqual(Math.round((s.samples * 1000) / s.rate), 78)
  const chunked = new Mp3FrameScan()
  for (let off = 0; off < whole.length; off += 7) chunked.push(whole.subarray(off, off + 7))
  chunked.end()
  assert.deepEqual([chunked.dataOffset, chunked.framesEnd, chunked.samples, chunked.rate], [s.dataOffset, s.framesEnd, s.samples, s.rate])
  // 最后一帧不完整：end() 时也计入（时长按声明的帧长算，误差 ≤1 帧）
  const cut = new Mp3FrameScan()
  cut.push(whole.subarray(0, whole.length - 5))
  cut.end()
  assert.equal(cut.samples, 3 * 1152)
  assert.equal(cut.framesEnd, whole.length)
})

test('MP3 帧扫描：保留版本 / 保留层 / 无效比特率 / 无效采样率不算帧', () => {
  for (const [b1, b2] of [[0xeb, 0x90], [0xf9, 0x90], [0xfb, 0xf0], [0xfb, 0x9c]] as const) {
    const s = new Mp3FrameScan()
    s.push(Buffer.from([0xff, b1, b2, 0x00, 0, 0, 0, 0]))
    s.end()
    assert.equal(s.rate, 0, `b1=${b1.toString(16)} b2=${b2.toString(16)}`)
  }
})

test('MP3：读时长与转码（44.1kHz 立体声、8kHz 单声道 MPEG-2.5），不是 MP3 时报错', async () => {
  const dir = tmp()
  const src44 = join(import.meta.dirname, 'fixtures', 'import-audio-44k.mp3')
  const info = await readAudioInfo(src44)
  assert.equal(info.kind, 'mp3')
  assert.ok(Math.abs(info.durationMs - 3000) <= 150, `${info.durationMs} ms`)
  const dest = join(dir, 'a.pcm')
  const progress: number[] = []
  const n = await convertAudio(src44, dest, (done, all) => progress.push(done / all))
  const out = readPcm(dest)
  assert.equal(out.length, n)
  assert.ok(Math.abs(n - SR * 3) <= 100, `${n} 个样本`)
  assert.ok(Math.abs(amplitude(out.subarray(SR, SR * 2), 440) - 0.5) < 0.05, '440Hz 幅度保持')
  assert.equal(progress.at(-1), 1)

  const src8 = join(import.meta.dirname, 'fixtures', 'import-audio-8k.mp3')
  const info8 = await readMp3Info(src8)
  assert.equal(info8.rate, 8000)
  assert.equal(info8.channels, 1)
  // 帧头数出的时长含 LAME 的编码器延迟与尾部填充帧（约 0.2s）；解码时经 gapless 裁剪，所以转码长度是准的
  assert.ok(Math.abs(info8.durationMs - 2000) <= 300, `${info8.durationMs} ms`)
  const n8 = await convertAudio(src8, join(dir, 'b.pcm'))
  const out8 = readPcm(join(dir, 'b.pcm'))
  assert.equal(out8.length, n8)
  assert.ok(Math.abs(n8 - SR * 2) <= 100, `${n8} 个样本`)
  assert.ok(Math.abs(amplitude(out8.subarray(SR, SR * 1.5), 500) - 0.5) < 0.05, '500Hz 幅度保持')

  const fake = join(dir, 'fake.mp3')
  writeFileSync(fake, 'ID3 no frames at all here')
  await assert.rejects(readAudioInfo(fake), /不是有效的 MP3/)
  const junk = join(dir, 'junk.dat')
  writeFileSync(junk, 'hello world, not audio')
  await assert.rejects(convertAudio(junk, join(dir, 'junk.pcm')), /不是支持的录音格式/)
})

test('转换入口：WAV 经 convertAudio 结果不变、读出类型与时长', async () => {
  const dir = tmp()
  const pcm = Int16Array.from({ length: SR }, (_, i) => ((i * 89) % 20000) - 10000)
  const src = join(dir, 'a.wav')
  writeFileSync(src, Buffer.concat([wavHeader(pcm.length * 2), Buffer.from(pcm.buffer)]))
  assert.equal(await convertAudio(src, join(dir, 'a.pcm')), pcm.length)
  assert.deepEqual(readPcm(join(dir, 'a.pcm')), pcm)
  const info = await readAudioInfo(src)
  assert.deepEqual({ kind: info.kind, durationMs: info.durationMs }, { kind: 'wav', durationMs: 1000 })
})
