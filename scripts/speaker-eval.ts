// 说话人区分与声纹认人评测（D-042）：改 regroup 的分组参数、自动人数参数或 PRINT_MATCH 时，用真实会议录音的逐句声纹对比新旧结果
// 用法: node scripts/speaker-eval.ts <声纹.json>
//   声纹.json 为 [{ "set": "ali" | "ais", "spk": "说话人", "meeting": 0, "t": 起始秒, "dur": 秒, "v": [192 维声纹] }]，
//   用人工标注说话人的公开数据：AliMeeting 远场会议（set=ali，按标注切出不与别人重叠的 1～3 秒单人短段，meeting 区分场次、t 为时间）、
//   AISHELL-1（set=ais，每人若干句切成 1～3 秒）；声纹用 native/bin/mt-diarize 的 `embed` 命令与应用相同的模型算出
// 输出：各类场景下自动人数的判对数与每人归对率、已知人数的每人归对率；声纹同场冒认率与漏认率。两头（多分、漏分）都要看
import { readFileSync } from 'fs'
import { AUTO_SPEAKERS, PRINT_MATCH, normalize, printScore, regroup, type ClusterItem } from '../src/main/meeting/cluster.ts'

type Seg = { set: string; spk: string; meeting?: number; t?: number; dur: number; v: number[] }
if (process.argv.length < 3) {
  console.log('用法: node scripts/speaker-eval.ts <声纹.json>')
  process.exit(2)
}
const all = (JSON.parse(readFileSync(process.argv[2], 'utf8')) as Seg[]).filter((x) => x.dur >= 0.8)
let seed = 99
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const subsets = <T>(xs: T[], k: number): T[][] => (k === 0 ? [[]] : xs.flatMap((x, i) => subsets(xs.slice(i + 1), k - 1).map((s) => [x, ...s])))

// —— 场景：真实会议拆出的 1～4 人组合与会议开头、一方只说几句；近讲 1～7 人（发言量不均） ——
const scenes: Array<{ kind: string; truth: number; segs: Seg[] }> = []
for (const m of [...new Set(all.filter((x) => x.set === 'ali').map((x) => x.meeting))]) {
  const xs = all.filter((x) => x.set === 'ali' && x.meeting === m).sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
  const spk = [...new Set(xs.map((x) => x.spk))]
  for (let k = 1; k <= spk.length; k++) {
    for (const sub of subsets(spk, k)) {
      const segs = xs.filter((x) => sub.includes(x.spk))
      scenes.push({ kind: k === 1 ? '单人' : '2～4 人会议', truth: k, segs })
      if (k >= 2) scenes.push({ kind: '会议开头 40 句', truth: new Set(segs.slice(0, 40).map((x) => x.spk)).size, segs: segs.slice(0, 40) })
    }
  }
  for (const a of spk) {
    for (const b of spk) {
      if (a === b) continue
      for (const n of [2, 3, 5, 10]) {
        const few = xs.filter((x) => x.spk === b).slice(0, n)
        scenes.push({ kind: n <= 3 ? '一方只说 2～3 句' : '一方只说 5～10 句', truth: 2, segs: xs.filter((x) => x.spk === a || few.includes(x)) })
      }
    }
  }
}
const ais = all.filter((x) => x.set === 'ais')
const aspk = [...new Set(ais.map((x) => x.spk))]
for (let k = 1; k <= Math.min(7, aspk.length); k++) {
  for (let r = 0; r < 6; r++) {
    const pool = [...aspk]
    const sub = Array.from({ length: k }, () => pool.splice(Math.floor(rnd() * pool.length), 1)[0])
    const total = 30 + Math.floor(rnd() * 90)
    const w = sub.map((_, i) => 1 / (i + 1))
    const W = w.reduce((a, b) => a + b)
    const segs = sub.flatMap((s, i) => ais.filter((x) => x.spk === s).slice(0, Math.max(2, Math.round((total * w[i]) / W))))
    for (let i = segs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[segs[i], segs[j]] = [segs[j], segs[i]]
    }
    scenes.push({ kind: k === 1 ? '单人' : '近讲 2～7 人', truth: k, segs })
  }
}

/** 每个真实说话人的时长被归对的比例（按最佳一一对应），取平均：说得少的人被并掉时明显下降 */
function perSpeaker(segs: Seg[], labels: number[]): number {
  const cell = new Map<string, number>()
  const total = new Map<string, number>()
  segs.forEach((s, i) => {
    cell.set(`${s.spk}|${labels[i]}`, (cell.get(`${s.spk}|${labels[i]}`) ?? 0) + s.dur)
    total.set(s.spk, (total.get(s.spk) ?? 0) + s.dur)
  })
  const used = new Set<string>()
  const got = new Map<string, number>()
  for (const [key, d] of [...cell].sort((a, b) => b[1] - a[1])) {
    const [t, l] = key.split('|')
    if (used.has(`t${t}`) || used.has(`l${l}`)) continue
    used.add(`t${t}`)
    used.add(`l${l}`)
    got.set(t, d)
  }
  return [...total].reduce((s, [t, d]) => s + (got.get(t) ?? 0) / d, 0) / total.size
}

const rows = new Map<string, { n: number; exact: number; auto: number; known: number }>()
for (const sc of scenes) {
  const items: ClusterItem[] = sc.segs.map((s, i) => ({ id: i, speaker: 1, v: s.v, durMs: s.dur * 1000, locked: false }))
  let next = 1000
  const auto = regroup(items, { expected: AUTO_SPEAKERS, create: () => next++ })
  const known = regroup(items, { expected: sc.truth, create: () => next++ })
  const autoLabels = sc.segs.map((_, i) => auto.assign.get(i)!)
  const r = rows.get(sc.kind) ?? { n: 0, exact: 0, auto: 0, known: 0 }
  r.n++
  if (new Set(autoLabels).size === sc.truth) r.exact++
  r.auto += perSpeaker(sc.segs, autoLabels)
  r.known += perSpeaker(sc.segs, sc.segs.map((_, i) => known.assign.get(i)!))
  rows.set(sc.kind, r)
}
console.log('场景'.padEnd(16), '自动：人数判对 / 每人归对', '  已知人数：每人归对')
let exact = 0
for (const [kind, r] of rows) {
  exact += r.exact
  console.log(kind.padEnd(16), `${r.exact}/${r.n}`.padStart(8), `${((r.auto / r.n) * 100).toFixed(0)}%`.padStart(6), `${((r.known / r.n) * 100).toFixed(0)}%`.padStart(14))
}
console.log(`自动人数合计判对 ${exact}/${scenes.length}`)

// —— 声纹：每人按时间后一半做声纹，前一半每 3 句一组去认；同场其他人的声纹过线即冒认 ——
const mean = (xs: Seg[]) => {
  const us = xs.map((x) => normalize(x.v))
  return Float32Array.from(us[0], (_, d) => us.reduce((t, u) => t + u[d], 0) / us.length)
}
let genuine = 0
let miss = 0
let impostor = 0
let falseHit = 0
for (const set of ['ali', 'ais']) {
  const xs = all.filter((x) => x.set === set)
  const prints = [...new Set(xs.map((x) => x.spk))].map((spk) => {
    const own = xs.filter((x) => x.spk === spk).sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
    const half = Math.floor(own.length / 2)
    return { spk, room: own[0].meeting ?? -1, vector: mean(own.slice(half)), test: own.slice(0, half) }
  })
  for (const p of prints) {
    for (let o = 0; o + 3 <= p.test.length; o += 3) {
      const g = mean(p.test.slice(o, o + 3))
      for (const q of prints) {
        if (q.room !== p.room) continue
        const hit = printScore(g, q.vector) >= PRINT_MATCH
        if (q.spk === p.spk) {
          genuine++
          if (!hit) miss++
        } else {
          impostor++
          if (hit) falseHit++
        }
      }
    }
  }
}
console.log(`声纹（同场，3 句一组，门槛 ${PRINT_MATCH}）：漏认 ${((miss / genuine) * 100).toFixed(1)}%，别人过线 ${((falseHit / impostor) * 100).toFixed(1)}%`)
