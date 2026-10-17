// 线上会议外放回声检测（D-033）：麦克风里对方声音的回声要去掉，现场的人说的话不能被去掉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ECHO_AHEAD_FRAMES, ECHO_LEAD_FRAMES, removeEcho } from '../src/main/meeting/echo.ts'

const SR = 16000
const LEAD = ECHO_LEAD_FRAMES * 320
const AHEAD = ECHO_AHEAD_FRAMES * 320

/** 像说话的信号：每 120ms 一个“音节”，音高、共振峰、响度都随机变化，音节之间有短停顿 */
function voice(seed: number, ms: number): Int16Array {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const n = Math.round((ms / 1000) * SR)
  const out = new Int16Array(n)
  const syl = Math.round(0.12 * SR)
  for (let a = 0; a < n; a += syl) {
    const pause = rnd() < 0.2
    const f0 = 100 + rnd() * 150
    const f1 = 300 + rnd() * 700
    const f2 = 900 + rnd() * 2000
    const amp = pause ? 0 : 2000 + rnd() * 6000
    for (let i = a; i < Math.min(n, a + syl); i++) {
      const t = i / SR
      const env = Math.sin((Math.PI * (i - a)) / syl)
      out[i] = Math.round(amp * env * (0.5 * Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(2 * Math.PI * f1 * t) + 0.2 * Math.sin(2 * Math.PI * f2 * t)))
    }
  }
  return out
}

/** 外放回声：延迟、变小、加一点底噪 */
function echoOf(src: Int16Array, delay: number, gain: number, len: number): Float32Array {
  const out = new Float32Array(len)
  for (let i = 0; i < src.length && i + delay < len; i++) out[i + delay] += src[i] * gain
  return out
}

function toPcm(x: Float32Array, noiseSeed = 7): Int16Array {
  let s = noiseSeed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5
  return Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v + rnd() * 40))))
}

/** 应用声音窗口：比麦克风这句提前 LEAD、多 AHEAD */
function appWindow(app: Int16Array, len: number): Int16Array {
  const w = new Int16Array(LEAD + len + AHEAD)
  w.set(app.subarray(0, Math.min(app.length, len + AHEAD)), LEAD)
  return w
}

const kept = (keep: Array<{ start: number; end: number }>, from: number, to: number) =>
  keep.reduce((s, p) => s + Math.max(0, Math.min(p.end, to) - Math.max(p.start, from)), 0) / (to - from)

test('回声：只有外放的对方声音时整句去掉', () => {
  const len = 4 * SR
  const remote = voice(1, 4000)
  const mic = toPcm(echoOf(remote, Math.round(0.06 * SR), 0.3, len))
  const r = removeEcho(0, len, mic, appWindow(remote, len))
  assert.ok(kept(r.keep, 0, len) < 0.1, `保留了 ${kept(r.keep, 0, len)}`)
})

test('回声：戴耳机时（麦克风只有现场的人）两边同时说话也全部保留', () => {
  const len = 4 * SR
  const local = voice(2, 4000)
  const remote = voice(3, 4000)
  const r = removeEcho(0, len, toPcm(Float32Array.from(local)), appWindow(remote, len))
  assert.deepEqual(r.keep, [{ start: 0, end: len }])
})

test('回声：对方没出声时整句保留', () => {
  const len = 3 * SR
  const r = removeEcho(0, len, voice(4, 3000), new Int16Array(LEAD + len + AHEAD))
  assert.deepEqual(r.keep, [{ start: 0, end: len }])
})

test('回声：现场的人先说、接着是外放回声，只去掉回声那段', () => {
  const localMs = 2500
  const len = 5 * SR
  const local = voice(5, localMs)
  const remote = voice(6, 2000)
  const at = Math.round(3 * SR) // 对方从第 3 秒开始说
  const appTrack = new Int16Array(len + AHEAD)
  appTrack.set(remote, at)
  const mic = echoOf(remote, at + Math.round(0.05 * SR), 0.3, len)
  for (let i = 0; i < local.length; i++) mic[i] += local[i]
  const r = removeEcho(0, len, toPcm(mic), appWindow(appTrack, len))
  const localEnd = Math.round((localMs / 1000) * SR)
  assert.ok(kept(r.keep, 0, localEnd) > 0.95, `现场保留 ${kept(r.keep, 0, localEnd)}`)
  assert.ok(kept(r.keep, at + 0.2 * SR, len) < 0.2, `回声保留 ${kept(r.keep, at + 0.2 * SR, len)}`)
  // 保留段在句子时间线上（start 偏移）
  const shifted = removeEcho(1000, 1000 + len, toPcm(mic), appWindow(appTrack, len))
  assert.equal(shifted.keep[0].start, 1000)
})
