// 外放回声检测标定（D-033）：真人录音 + 模拟外放（房间混响、延迟 30～120ms、回声音量、底噪、两路时间线误差 ±0.1 秒）
// 用法: node scripts/echo-sim.ts <对方录音 ref.json> <现场录音 ref.json> [门槛1,门槛2,...]
//   ref.json 为 [{ "pcm": "<16kHz 单声道 s16le 文件路径>", ... }]，用人工标注的公开数据（如 WenetSpeech test_meeting 作对方、AISHELL-1 test 作现场）
// 输出每种情况在各门槛下“回声去掉的比例”与“现场的话保留的比例”：改 ECHO_CORR 时两者都要看
import { readFileSync } from 'fs'
import { removeEcho, ECHO_LEAD_FRAMES, ECHO_AHEAD_FRAMES } from '../src/main/meeting/echo.ts'

const SR = 16000
const load = (refFile: string) => (JSON.parse(readFileSync(refFile, 'utf8')) as Array<{ pcm: string }>).map((r) => {
  const b = readFileSync(r.pcm)
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 2)))
})
if (process.argv.length < 4) {
  console.log('用法: node scripts/echo-sim.ts <对方录音 ref.json> <现场录音 ref.json> [门槛,...]')
  process.exit(2)
}
const remote = load(process.argv[2]).filter((x) => x.length > SR * 2.5)
const local = load(process.argv[3]).filter((x) => x.length > SR * 2.5)

let seed = 1
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
const rms = (x: Float32Array | Int16Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length))

/** 房间脉冲响应：直达 + 指数衰减的噪声尾巴（RT60 秒） */
function rir(rt60: number): Float32Array {
  const n = Math.floor(SR * rt60 * 0.8)
  const h = new Float32Array(n)
  h[0] = 1
  const tau = rt60 / 6.9
  for (let i = 40; i < n; i++) h[i] = 0.35 * gauss() * Math.exp(-i / SR / tau)
  return h
}
function convolve(x: Int16Array, h: Float32Array): Float32Array {
  // 稀疏化：每 4 个抽头取 1 个（尾巴是噪声，足够模拟包络被抹平的效果）
  const y = new Float32Array(x.length + h.length)
  for (let k = 0; k < h.length; k += k < 40 ? 1 : 4) {
    const g = k < 40 ? h[k] : h[k] * 2
    if (!g) continue
    for (let i = 0; i < x.length; i++) y[i + k] += x[i] * g
  }
  return y.subarray(0, x.length)
}

interface Case { name: string; expect: 'drop' | 'keep' | 'split' }
const TH = (process.argv[4] ?? '0.55,0.6,0.65').split(',').map(Number)
const results: Record<string, { n: number; kept: number; echoRemoved: number; localKept: number }> = {}

function run(name: string, opts: { echoDb: number | null; localAt: number | null; appPlaying: boolean; rt60: number; offsetMs: number; seq?: boolean }) {
  const a = remote[Math.floor(rnd() * remote.length)]
  const b = local[Math.floor(rnd() * local.length)]
  const len = opts.seq ? b.length + a.length + SR / 2 : Math.max(a.length, b.length)
  // 时间线：应用声音（对方）原样；麦克风 = 本地人声 + 回声（外放 → 房间 → 麦克风，延迟 30～120ms）+ 底噪
  const app = new Int16Array(len + SR)
  const aAt = opts.seq ? b.length + SR / 2 : 0
  if (opts.appPlaying || opts.echoDb !== null) app.set(a.subarray(0, Math.min(a.length, len - aAt)), aAt)
  const mic = new Float32Array(len)
  const localRms = rms(b)
  if (opts.localAt !== null) for (let i = 0; i < b.length && i < len; i++) mic[i] += b[i]
  if (opts.echoDb !== null) {
    const delay = Math.floor(SR * (0.03 + rnd() * 0.09))
    const e = convolve(a, rir(opts.rt60))
    const g = (localRms / Math.max(1, rms(e))) * 10 ** (opts.echoDb / 20)
    for (let i = 0; i < e.length; i++) {
      const t = aAt + i + delay
      if (t < len) mic[t] += e[i] * g
    }
  }
  const noise = localRms * 10 ** (-40 / 20)
  for (let i = 0; i < len; i++) mic[i] += gauss() * noise
  const micI = Int16Array.from(mic, (v) => Math.max(-32768, Math.min(32767, Math.round(v))))
  // 两路时间线误差：应用声音整体偏移 offsetMs（正 = 应用声音落后）
  const off = Math.round((opts.offsetMs / 1000) * SR)
  const lead = ECHO_LEAD_FRAMES * 320
  const ahead = ECHO_AHEAD_FRAMES * 320
  const appWin = new Int16Array(len + lead + ahead)
  for (let i = 0; i < appWin.length; i++) {
    const t = i - lead - off
    if (t >= 0 && t < app.length) appWin[i] = app[t]
  }
  for (const th of TH) {
  const r = removeEcho(0, len, micI, appWin, th)
  const keptSamples = (from: number, to: number) => r.keep.reduce((s, p) => s + Math.max(0, Math.min(p.end, to) - Math.max(p.start, from)), 0)
  const st = (results[`${th}|${name}`] ??= { n: 0, kept: 0, echoRemoved: 0, localKept: 0 })
  st.n++
  st.kept += keptSamples(0, len) / len
  if (opts.seq) {
    st.localKept += keptSamples(0, b.length) / b.length
    st.echoRemoved += 1 - keptSamples(aAt, len) / (len - aAt)
  } else if (opts.localAt !== null) st.localKept += keptSamples(0, b.length) / b.length
  else st.echoRemoved += 1 - keptSamples(0, len) / len
  }
}

for (let k = 0; k < 25; k++) {
  for (const echoDb of [0, -6, -12, -20]) {
    for (const rt60 of [0.25, 0.5]) {
      const offsetMs = Math.round((rnd() - 0.5) * 200)
      run(`只有回声 ${echoDb}dB rt${rt60}`, { echoDb, localAt: null, appPlaying: true, rt60, offsetMs })
      run(`同时说话+回声 ${echoDb}dB rt${rt60}`, { echoDb, localAt: 0, appPlaying: true, rt60, offsetMs })
      run(`先现场后回声 ${echoDb}dB rt${rt60}`, { echoDb, localAt: 0, appPlaying: true, rt60, offsetMs, seq: true })
    }
  }
  run('只有现场（对方没声音）', { echoDb: null, localAt: 0, appPlaying: false, rt60: 0.3, offsetMs: 0 })
  run('戴耳机：两边同时说话', { echoDb: null, localAt: 0, appPlaying: true, rt60: 0.3, offsetMs: Math.round((rnd() - 0.5) * 200) })
}
console.log('门槛 情况'.padEnd(34), '回声去掉', '现场保留')
for (const [key, s] of Object.entries(results).sort()) {
  const name = key.split('|')[1]
  const echo = name.startsWith('只有回声') || name.startsWith('先现场') ? `${((s.echoRemoved / s.n) * 100).toFixed(0)}%` : '—'
  const loc = name.startsWith('只有回声') ? '—' : `${((s.localKept / s.n) * 100).toFixed(0)}%`
  console.log(key.padEnd(34), echo.padStart(6), loc.padStart(8))
}
