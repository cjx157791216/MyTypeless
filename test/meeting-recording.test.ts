import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mixPcm, recordingFileName, saveRecording, uniquePath } from '../src/main/meeting/recording.ts'

const pcmFile = (dir: string, name: string, samples: number[]): string => {
  const path = join(dir, name)
  writeFileSync(path, Buffer.from(Int16Array.from(samples).buffer))
  return path
}

const wavSamples = (path: string): { header: Buffer; pcm: Int16Array } => {
  const buf = readFileSync(path)
  const data = buf.subarray(44)
  return { header: buf.subarray(0, 44), pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) }
}

test('录音文件名：日期在前，去掉文件名里不能用的字符；默认标题只留日期', () => {
  const at = new Date(2026, 9, 22, 9, 5).getTime()
  assert.equal(recordingFileName('周会:Q4 计划/预算', at), '2026-10-22 0905 周会_Q4 计划_预算.wav')
  assert.equal(recordingFileName('10 月 22 日 09:05 的会议', at), '2026-10-22 0905 会议.wav')
  assert.equal(recordingFileName('  ', at), '2026-10-22 0905 会议.wav')
  assert.equal(recordingFileName('结尾有点. ', at), '2026-10-22 0905 结尾有点.wav')
  assert.ok(recordingFileName('长'.repeat(200), at).length <= 100)
})

test('同名文件已存在时加序号，不覆盖', () => {
  const taken = new Set([join('/d', 'a.wav'), join('/d', 'a (2).wav')])
  assert.equal(uniquePath('/d', 'a.wav', (p) => taken.has(p)), join('/d', 'a (3).wav'))
  assert.equal(uniquePath('/d', 'b.wav', (p) => taken.has(p)), join('/d', 'b.wav'))
})

test('两路混音：逐点相加、超出范围削顶，短的一路按静音补齐', () => {
  const out = mixPcm([Int16Array.from([100, 30000, -30000, 5]), Int16Array.from([-50, 10000, -10000])], 4)
  assert.deepEqual([...out], [50, 32767, -32768, 5])
  assert.deepEqual([...mixPcm([Int16Array.from([1, 2])], 3)], [1, 2, 0])
})

test('保存录音：一路时原样写成 WAV（16kHz 单声道），文件头长度正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mt rec '))
  const src = pcmFile(dir, 'a.pcm', [1, -2, 3, 32767])
  const dest = join(dir, 'out', '会议.wav')
  assert.equal(await saveRecording([src], dest, 3), 4)
  const { header, pcm } = wavSamples(dest)
  assert.equal(header.toString('ascii', 0, 4), 'RIFF')
  assert.equal(header.readUInt32LE(24), 16000)
  assert.equal(header.readUInt16LE(22), 1)
  assert.equal(header.readUInt32LE(40), 8)
  assert.equal(header.readUInt32LE(4), 36 + 8)
  assert.deepEqual([...pcm], [1, -2, 3, 32767])
  assert.ok(!readdirSync(join(dir, 'out')).some((f) => f.endsWith('.part')), '不留下写了一半的临时文件')
})

test('保存录音：两路（现场 + 线上）混成一个文件，长度取较长的一路；分块边界不影响结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mt rec '))
  const mic = pcmFile(dir, 'mic.pcm', [10, 20, 30, 40, 50])
  const app = pcmFile(dir, 'app.pcm', [1, 2, 3, 4, 5, 6, 7])
  const dest = join(dir, 'mixed.wav')
  assert.equal(await saveRecording([mic, app], dest, 2), 7)
  assert.deepEqual([...wavSamples(dest).pcm], [11, 22, 33, 44, 55, 6, 7])
})

test('保存录音：写不进去时报错，不留下半个文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mt rec '))
  const src = pcmFile(dir, 'a.pcm', [1, 2, 3])
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, 'x')
  await assert.rejects(saveRecording([src], join(blocker, 'x.wav')))
  assert.equal(existsSync(join(blocker, 'x.wav.part')), false)
})
