// 会议模式（D-015）：分句、说话人聚类、纪要整理、Markdown 展示
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALIGN_TOLERANCE, MEETING_VAD_DENOISED, UtteranceSegmenter, alignPad, planFeed, samplesToMs, splitByTurns, turnsInUtterance } from '../src/main/meeting/segmenter.ts'
import { readFileSync } from 'node:fs'
import { OnlineClusterer, regroup, identifySpeakers, printScore, splitByWindows, blendVoiceprint, cosine, normalize, mergeAdjacentParts, type ClusterItem } from '../src/main/meeting/cluster.ts'
import { buildTranscript, chunkTranscript, formatClock, formatDuration, minutesHeader, cleanMinutesBody, exportMarkdown } from '../src/main/meeting/minutes.ts'
import { renderMarkdown } from '../src/shared/markdown.ts'
import { normalizeLoudness } from '../src/main/meeting/enhance.ts'

const SR = 16000
const FRAME = 1600
const speech = (ms: number) => {
  const n = (ms / 1000) * SR
  const f = new Int16Array(n)
  for (let i = 0; i < n; i++) f[i] = Math.round(5000 * Math.sin((2 * Math.PI * 220 * i) / SR))
  return f
}
const silence = (ms: number) => new Int16Array((ms / 1000) * SR)

function feed(seg: UtteranceSegmenter, parts: Int16Array[]) {
  const out = []
  for (const p of parts) for (let off = 0; off < p.length; off += FRAME) out.push(...seg.push(p.subarray(off, off + FRAME)))
  return out
}

test('分句：停顿 0.6 秒切句，句首句尾留白，时间线连续', () => {
  const seg = new UtteranceSegmenter()
  const us = feed(seg, [silence(1000), speech(2000), silence(1000), speech(1500), silence(1000)])
  assert.equal(us.length, 2)
  assert.equal(samplesToMs(us[0].start), 800, '句首前留 200ms')
  assert.ok(Math.abs(samplesToMs(us[0].end) - 3300) <= 100, `第一句结束 ${samplesToMs(us[0].end)}ms`)
  assert.equal(us[0].pcm.length, us[0].end - us[0].start)
  assert.equal(samplesToMs(us[1].start), 3800)
})

test('分句：短停顿不切句；咳嗽一类的短声音不成句', () => {
  const seg = new UtteranceSegmenter()
  const us = feed(seg, [speech(1000), silence(400), speech(1000), silence(800), speech(200), silence(1000)])
  assert.equal(us.length, 1, '0.4 秒停顿属于同一句；0.2 秒的声音丢弃')
  assert.ok(samplesToMs(us[0].end - us[0].start) >= 2400)
})

test('分句：一直不停顿时 20 秒内切开，前后两句不重叠、不丢音频', () => {
  const seg = new UtteranceSegmenter()
  const us = [...feed(seg, [speech(45_000)]), ...seg.flush()]
  assert.ok(us.length >= 3)
  assert.ok(us.every((u) => samplesToMs(u.end - u.start) <= 20_300), '每句不超过约 20 秒')
  for (let i = 1; i < us.length; i++) assert.equal(us[i].start, us[i - 1].end, '首尾相接')
})

test('分句：flush 输出正在说的一句', () => {
  const seg = new UtteranceSegmenter()
  assert.equal(feed(seg, [speech(1500)]).length, 0)
  const us = seg.flush()
  assert.equal(us.length, 1)
})

/** 造声纹：每个人一个随机方向，每句加噪声 */
function voices(n: number, dim = 64, seed = 7) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1
  const base = Array.from({ length: n }, () => Array.from({ length: dim }, rnd))
  return (who: number, noise = 0.35) => base[who].map((x) => x + noise * rnd())
}

test('在线归类：同一人归到一起，不同人新建', () => {
  const v = voices(3)
  const c = new OnlineClusterer()
  let next = 1
  const seq = [0, 1, 0, 2, 1, 0, 2, 2, 1]
  const keys = seq.map((who) => c.assign(v(who), () => next++).key)
  const byWho = new Map<number, Set<number>>()
  seq.forEach((who, i) => byWho.set(who, (byWho.get(who) ?? new Set()).add(keys[i])))
  for (const set of byWho.values()) assert.equal(set.size, 1, '同一人只有一个说话人编号')
  assert.equal(new Set(keys).size, 3)
})

/** 按最佳一一对应统计分对的段数 */
function accuracy(truth: number[], labels: number[]): number {
  const count = new Map<string, number>()
  truth.forEach((t, i) => count.set(`${t}|${labels[i]}`, (count.get(`${t}|${labels[i]}`) ?? 0) + 1))
  const used = new Set<string>()
  let ok = 0
  for (const [k, c] of [...count].sort((x, y) => y[1] - x[1])) {
    const [t, l] = k.split('|')
    if (used.has(`t${t}`) || used.has(`l${l}`)) continue
    used.add(`t${t}`)
    used.add(`l${l}`)
    ok += c
  }
  return ok
}

// 说话人回归数据（scripts/gen-speaker-fixture.cjs 生成，换声纹模型后重跑）：sr-data 真人中文，完整段 long 与 1～2.5 秒短句 short
const fixture = JSON.parse(readFileSync(new URL('./fixtures/speakers.json', import.meta.url), 'utf-8')).items as Array<{ spk: string; ch: string; kind: string; d: number; v: number[] }>
const longClips = fixture.filter((x) => x.kind === 'long')
const shortTurns = fixture.filter((x) => x.kind === 'short')
const speakerIds = [...new Set(fixture.map((x) => x.spk))].sort()
/** 原声完整段，t = 说话人序号（前 4 人） */
const fourSpeakers = longClips.filter((x) => x.ch === 'clean' && speakerIds.indexOf(x.spk) < 4).map((x) => ({ t: speakerIds.indexOf(x.spk), v: x.v }))

test('真实录音回归（完整段，原声与外放）：在线归类每组都分对；按人数整体归类全部分对', () => {
  for (const ch of ['clean', 'played']) {
    const name = ch
    const set = longClips.filter((x) => x.ch === ch).map((x) => ({ t: speakerIds.indexOf(x.spk), v: x.v }))
    const truth = set.map((x) => x.t)
    const people = new Set(truth).size
    const online = new OnlineClusterer()
    let next = 1
    const onlineLabels = set.map((x) => online.assign(x.v, () => next++).key)
    assert.equal(new Set(onlineLabels).size, people, `${name}：在线分出 ${new Set(onlineLabels).size} 人`)
    assert.equal(accuracy(truth, onlineLabels), set.length, `${name}：在线归类有错`)
    const items: ClusterItem[] = set.map((x, i) => ({ id: i, speaker: 1, v: x.v, durMs: 3000, locked: false }))
    const known = regroup(items, { expected: people, create: () => next++ })
    assert.equal(accuracy(truth, set.map((_, i) => known.assign.get(i)!)), set.length, `${name}：按人数归类仍有错`)
  }
})

test('会议短句模拟（真人中文 1～2.5 秒短句，原声与外放；单人/两人/三人）：按人数归类准确率全部 ≥ 90%', () => {
  const spks = [...new Set(shortTurns.map((x) => x.spk))].sort()
  const combos: string[][] = []
  const pick = (start: number, cur: string[], k: number) => {
    if (cur.length === k) return combos.push([...cur])
    for (let i = start; i < spks.length; i++) pick(i + 1, [...cur, spks[i]], k)
  }
  for (const k of [1, 2, 3]) pick(0, [], k)
  for (const ch of ['clean', 'played']) {
    for (const combo of combos) {
      const set = shortTurns.filter((x) => x.ch === ch && combo.includes(x.spk))
      if (set.length < 4) continue
      const truth = set.map((x) => combo.indexOf(x.spk))
      let next = 1000 // 新说话人编号不能与段里已有的编号（1）重复
      const items: ClusterItem[] = set.map((x, i) => ({ id: i, speaker: 1, v: x.v, durMs: x.d * 1000, locked: false }))
      const known = regroup(items, { expected: combo.length, create: () => next++ })
      const labels = set.map((_, i) => known.assign.get(i)!)
      if (combo.length === 1) assert.equal(new Set(labels).size, 1, `${ch} ${combo}：单人被拆开`)
      const acc = accuracy(truth, labels) / set.length
      assert.ok(acc >= 0.9, `${ch} ${combo.join('+')}：按人数准确率 ${acc.toFixed(2)}`)
    }
  }
})

test('一方只说两三句（真人短句）：按 2 人归类不会把说得少的一方并掉，准确率 ≥ 80%，≥ 90% 的占九成以上', () => {
  // 用户真实二人会议：一方只说了几句，旧的自动模式把它当零星碎句并进了主讲人（D-021）
  const spks = [...new Set(shortTurns.map((x) => x.spk))].sort()
  let total = 0
  let good = 0
  for (const ch of ['clean', 'played']) {
    for (const a of spks) {
      for (const b of spks) {
        const A = shortTurns.filter((x) => x.ch === ch && x.spk === a)
        const B = shortTurns.filter((x) => x.ch === ch && x.spk === b)
        if (a === b || A.length < 7) continue
        for (const m of [2, 3, 4]) {
          for (let off = 0; off + m <= B.length; off += m) {
            const set = [...A, ...B.slice(off, off + m)]
            let next = 1000
            const items: ClusterItem[] = set.map((x, i) => ({ id: i, speaker: 1, v: x.v, durMs: x.d * 1000, locked: false }))
            const r = regroup(items, { expected: 2, create: () => next++ })
            const labels = set.map((_, i) => r.assign.get(i)!)
            assert.equal(new Set(labels).size, 2, `${ch} ${a}+${b}[${off}:${m}]：只剩 1 人`)
            const acc = accuracy(set.map((x) => (x.spk === a ? 0 : 1)), labels) / set.length
            assert.ok(acc >= 0.8, `${ch} ${a}+${b}[${off}:${m}]：准确率 ${acc.toFixed(2)}`)
            total++
            if (acc >= 0.9) good++
          }
        }
      }
    }
  }
  assert.ok(good / total >= 0.9, `≥ 90% 的只有 ${good}/${total}`)
})

test('在线归类：已有参会人数那么多人时不再新建，归入最像的人', () => {
  const v = voices(3)
  const c = new OnlineClusterer()
  let next = 1
  const keys = [0, 1, 2, 2, 0].map((who) => c.assign(v(who), () => next++, 2).key)
  assert.equal(new Set(keys).size, 2)
})

test('没有参会人数（较早的会议）：保持现有归属，只计算每人的平均向量', () => {
  const set = fourSpeakers
  const items: ClusterItem[] = set.map((x, i) => ({ id: i, speaker: i % 3 === 0 ? 7 : 8, v: x.v, durMs: 3000, locked: false }))
  const r = regroup(items, { expected: null, create: () => 99 })
  for (const it of items) assert.equal(r.assign.get(it.id), it.speaker)
  assert.deepEqual([...r.means.keys()].sort(), [7, 8])
})

test('整体归类：按参会人数合并；手动指定的段与命名过的不同说话人不被并到一起；短段跟随', () => {
  const set = fourSpeakers
  let next = 100
  const items: ClusterItem[] = set.map((x, i) => ({ id: i, speaker: x.t + 1, v: x.v, durMs: 3000, locked: false }))
  const two = regroup(items, { expected: 2, create: () => next++ })
  assert.equal(new Set(two.assign.values()).size, 2, '指定 2 人时合并到 2 组')
  const locked = items.map((it) => (it.id === 0 ? { ...it, speaker: 4, locked: true } : it))
  const r = regroup(locked, { expected: 2, named: new Set([1, 2]), create: () => next++ })
  assert.equal(r.assign.get(0), 4, '手动指定的段不动')
  const sp1 = items.filter((it) => it.speaker === 1 && it.id !== 0).map((it) => r.assign.get(it.id))
  const sp2 = items.filter((it) => it.speaker === 2).map((it) => r.assign.get(it.id))
  assert.ok(!sp1.some((s) => sp2.includes(s)), '命名过的不同说话人不合并')
  const withShort = [...items, { id: 99, speaker: 3, v: null, durMs: 400, locked: false }]
  const r2 = regroup(withShort, { expected: 4, create: () => next++ })
  assert.equal(r2.assign.get(99), r2.assign.get(items.find((it) => it.speaker === 3)!.id), '没有声纹的短段跟随原说话人')
})

test('声纹认人（真人短句，原声/外放/跨通道）：用整组声音按自身一致度认，每组 3 句以上全部认出；不认错；没保存过的人不被认成别人', () => {
  const spks = [...new Set(shortTurns.map((x) => x.spk))].sort()
  const mean = (vs: number[][]) => {
    const us = vs.map((v) => normalize(v))
    return Float32Array.from(us[0], (_, k) => us.reduce((t, u) => t + u[k], 0) / us.length)
  }
  const chs = [['clean', 'clean'], ['played', 'played'], ['clean', 'played'], ['played', 'clean']]
  let checked = 0
  for (const [ech, tch] of chs) {
    const prints: Array<{ id: number; vector: Float32Array; spk: string }> = []
    const tests = new Map<string, number[][]>()
    spks.forEach((spk, id) => {
      const e = shortTurns.filter((x) => x.spk === spk && x.ch === ech).map((x) => x.v)
      const t = shortTurns.filter((x) => x.spk === spk && x.ch === tch).map((x) => x.v)
      if (e.length < 3) return
      const half = Math.ceil(e.length / 2)
      prints.push({ id, vector: mean(ech === tch ? e.slice(0, half) : e), spk })
      tests.set(spk, ech === tch ? t.slice(half) : t)
    })
    for (const [a, ta] of tests) {
      for (const [b, tb] of tests) {
        if (a >= b || ta.length < 3 || tb.length < 3) continue
        const groups = [
          { key: 1, mean: mean(ta), n: ta.length },
          { key: 2, mean: mean(tb), n: tb.length }
        ]
        const all = identifySpeakers(groups, prints)
        assert.equal(prints.find((p) => p.id === all.get(1))?.spk, a, `${ech}→${tch} ${a}+${b}：${a} 没认出`)
        assert.equal(prints.find((p) => p.id === all.get(2))?.spk, b, `${ech}→${tch} ${a}+${b}：${b} 没认出`)
        const withoutB = identifySpeakers(groups, prints.filter((p) => p.spk !== b))
        assert.ok(!withoutB.has(2), `${ech}→${tch}：没保存过的 ${b} 被认成了别人`)
        checked++
      }
    }
  }
  assert.ok(checked >= 10)
})

test('声纹认人：一个声纹只给一个人；本场已用过的不再给；单句不认；声纹更新为加权平均', () => {
  const set = fourSpeakers
  const a = set.filter((x) => x.t === 0).map((x) => normalize(x.v))
  const print = Float32Array.from(a[0], (_, k) => (a[0][k] + a[1][k]) / 2)
  const prints = [{ id: 7, vector: print }]
  const g = (key: number, vs: Float32Array[]) => ({ key, mean: Float32Array.from(vs[0], (_, k) => vs.reduce((t, v) => t + v[k], 0) / vs.length), n: vs.length })
  const both = identifySpeakers([g(1, [a[2], a[0]]), g(2, [a[2], a[1]])], prints)
  assert.equal(both.size, 1, '同一声纹只给一个人')
  assert.equal(identifySpeakers([g(1, [a[2], a[0]])], prints, new Set([7])).size, 0, '本场已用过')
  assert.equal(identifySpeakers([g(1, [a[2]])], prints).size, 0, '单句不认')
  assert.ok(printScore(print, print) > 0.999)
  const blended = blendVoiceprint(print, 2, a[2], 1)
  assert.ok(Math.abs(blended[0] - (print[0] * 2 + a[2][0]) / 3) < 1e-6)
  assert.ok(cosine(a[0], a[0]) > 0.999)
})

test('纪要：转写稿合并同一人连续发言、时间格式、长会议分段', () => {
  const lines = buildTranscript([
    { startMs: 0, speaker: '张三', text: '我们开始吧。' },
    { startMs: 3000, speaker: '张三', text: '今天讨论上线时间。' },
    { startMs: 65_000, speaker: '李四', text: 'OK' },
    { startMs: 66_000, speaker: '李四', text: 'no problem' }
  ])
  assert.deepEqual(lines, ['[00:00] 张三：我们开始吧。今天讨论上线时间。', '[01:05] 李四：OK no problem'])
  assert.equal(formatClock(3_725_000), '1:02:05')
  assert.equal(formatDuration(3_900_000), '1 小时 5 分')
  assert.equal(formatDuration(30_000), '30 秒')
  const chunks = chunkTranscript(Array.from({ length: 10 }, (_, i) => `第 ${i} 行 ${'字'.repeat(40)}`), 200)
  assert.ok(chunks.length >= 3 && chunks.every((c) => c.length <= 200))
})

test('纪要：头部本地生成；模型输出去掉围栏和一级标题；导出带完整记录', () => {
  const header = minutesHeader({ title: '周会', startedAt: new Date(2026, 9, 15, 14, 5).getTime(), durationMs: 1_800_000, speakers: ['张三', '李四'] })
  assert.match(header, /^# 周会\n/)
  assert.match(header, /2026-10-15 14:05/)
  assert.match(header, /参会人：张三、李四/)
  assert.equal(cleanMinutesBody('```markdown\n# 纪要\n## 决议\n- 无\n```'), '## 决议\n- 无')
  const md = exportMarkdown('# 周会\n\n## 决议\n- 无', ['[00:00] 张三：好'])
  assert.match(md, /## 完整记录\n\n\[00:00\] 张三：好\n$/)
})

test('Markdown 展示：标题、列表、任务、粗体；HTML 被转义', () => {
  const html = renderMarkdown('## 决议\n- **上线**时间定在周五\n- [ ] 写文档（负责人：张三）\n\n<script>x</script>')
  assert.match(html, /<h2>决议<\/h2>/)
  assert.match(html, /<li><strong>上线<\/strong>时间定在周五<\/li>/)
  assert.match(html, /<li class="task">写文档（负责人：张三）<\/li>/)
  assert.match(html, /&lt;script&gt;/)
})

test('句内换人：按轮次切开；碎片并入前一段且不再按标签合并；只有一人时整句', () => {
  const k = (sec: number) => Math.round(sec * SR)
  const T = (a: number, b: number, s: number): [number, number, number] => [k(a), k(b), s]
  const base = k(100)
  // 真人录音实测：A 说到 2.3 秒，B 从 2.45 秒接话；局部标签把 A 的开头和 B 标成了同一个（1），中间碎片标成 2
  const parts = splitByTurns(base, base + k(5.9), [T(0.2, 1.36, 1), T(1.53, 2.26, 2), T(2.11, 5.75, 1)])
  assert.equal(parts.length, 2)
  assert.equal(parts[0].start, base)
  assert.equal(parts[1].end, base + k(5.9))
  assert.equal(parts[0].end, parts[1].start)
  assert.ok(Math.abs(parts[0].end - (base + k(2.11))) < 2, '在后一人开口处切开')
  // 两人之间有空隙：切在中点
  const two = splitByTurns(0, k(10.6), [T(0.2, 6.43, 0), T(6.61, 10.27, 1)])
  assert.equal(two.length, 2)
  assert.ok(Math.abs(two[0].end - k(6.52)) < 2)
  // 一个人：整句
  assert.deepEqual(splitByTurns(0, k(3), [T(0.15, 2.9, 1)]), [{ start: 0, end: k(3) }])
  assert.deepEqual(splitByTurns(0, k(3), []), [{ start: 0, end: k(3) }])
  // 开头的碎片并入后一段
  assert.deepEqual(splitByTurns(0, k(4), [T(0, 0.5, 3), T(0.6, 3.8, 1)]), [{ start: 0, end: k(4) }])
})

test('句内各段：同一人的相邻段合回，不同人保持分开；短段跟随前一段', () => {
  const v = voices(2)
  const f = (x: number[]) => Float32Array.from(x)
  const merged = mergeAdjacentParts([
    { start: 0, end: 10, v: f(v(0)) },
    { start: 10, end: 20, v: f(v(0)) },
    { start: 20, end: 22, v: null },
    { start: 22, end: 30, v: f(v(1)) }
  ])
  assert.deepEqual(merged.map((m) => [m.start, m.end]), [[0, 22], [22, 30]])
  assert.ok(merged.every((m) => m.v))
})

test('带参考上下文的换人检测：轮次换算到句内并裁掉句外部分', () => {
  // 上下文从 100 开始，句子是 [500, 900)
  const t = turnsInUtterance(100, 500, 900, [[0, 300, 0], [350, 650, 1], [650, 900, 0]])
  assert.deepEqual(t, [[0, 250, 1], [250, 400, 0]])
})

test('边录边降噪接入分句：输出按时间线对齐，重叠丢掉、缺口用原始录音补、不超过录音结尾', () => {
  const pcm = (at: number, n: number) => ({ at, pcm: Int16Array.from({ length: n }, (_, i) => at + i) })
  const pcmOf = (steps: ReturnType<typeof planFeed>) => steps.map((s) => ('pcm' in s ? [s.pcm[0], s.pcm.length] : s.raw))
  assert.deepEqual(pcmOf(planFeed(0, pcm(0, 7000), 8000)), [[0, 7000]], '降噪输出落后于输入：只送已输出的部分')
  assert.deepEqual(pcmOf(planFeed(7000, pcm(7000, 8000), 16000)), [[7000, 8000]])
  assert.deepEqual(pcmOf(planFeed(8000, null, 16000)), [[8000, 16000]], '降噪失败：用原始录音')
  assert.deepEqual(pcmOf(planFeed(16000, pcm(12000, 6000), 18000)), [[16000, 2000]], '与已送入重叠：丢掉重叠部分')
  assert.deepEqual(pcmOf(planFeed(16000, pcm(20000, 1000), 24000)), [[16000, 20000], [20000, 1000]], '进程重启后从新位置开始：缺口用原始录音补')
  assert.deepEqual(pcmOf(planFeed(16000, pcm(16000, 4000), 18000)), [[16000, 2000]], '收尾补出的空白不超过录音结尾')
  assert.deepEqual(planFeed(18000, pcm(18000, 0), 18000), [])
})

test('识别前音量归一：小声放大到正常水平、最多 30 dB、不削顶；正常音量不变', () => {
  const tone = (amp: number) => Int16Array.from({ length: 16000 }, (_, i) => Math.round(amp * Math.sin(i / 5)))
  const rms = (x: Int16Array) => Math.sqrt(x.reduce((t, v) => t + v * v, 0) / x.length)
  const quiet = normalizeLoudness(tone(300))
  assert.ok(Math.abs(rms(quiet) - 3000) < 50, `小声放大到约 3000（实际 ${rms(quiet).toFixed(0)}）`)
  assert.ok(rms(normalizeLoudness(tone(20))) < 20 * 31.7 / Math.SQRT2 + 1, '最多放大 30 dB')
  const spiky = tone(300)
  spiky[100] = 20000
  assert.ok(Math.max(...normalizeLoudness(spiky)) <= 30000, '峰值不削顶')
  const loud = tone(6000)
  assert.equal(normalizeLoudness(loud), loud, '正常音量不处理')
})

test('降噪后分句参数：远处小声的句子能分出来，纯底噪不误触发', () => {
  const seg = new UtteranceSegmenter(MEETING_VAD_DENOISED)
  const noise = (ms: number, amp: number) => Int16Array.from({ length: (ms / 1000) * SR }, () => Math.round((Math.random() * 2 - 1) * amp))
  const far = (ms: number) => Int16Array.from({ length: (ms / 1000) * SR }, (_, i) => Math.round(200 * Math.sin((2 * Math.PI * 220 * i) / SR) + (Math.random() * 2 - 1) * 15))
  const out = feed(seg, [noise(3000, 15), far(1500), noise(1500, 15), far(1200), noise(3000, 15)])
  assert.equal(out.length, 2, '两句远处小声的话（RMS 约 140，底噪约 9）都分出来')
  const quiet = feed(new UtteranceSegmenter(MEETING_VAD_DENOISED), [noise(10000, 30)])
  assert.equal(quiet.length, 0, '纯底噪不成句')
})

test('句内按窗口找换人：归属变化处切开、单个窗口的抖动被平滑、短段并入前一段', () => {
  const win = (labels: number[]) => labels.map((l, i) => ({ center: 12000 + i * 8000, scores: l === 0 ? [0.6, 0.2] : [0.2, 0.6] }))
  // A A A B B B B：在第 3、4 个窗口中心之间切开
  assert.deepEqual(splitByWindows(0, 70000, win([0, 0, 0, 1, 1, 1, 1]), 16000), [
    { start: 0, end: 32000 },
    { start: 32000, end: 70000 }
  ])
  // 中间单个窗口抖动（A A B A A）不切
  assert.deepEqual(splitByWindows(0, 56000, win([0, 0, 1, 0, 0]), 16000), [{ start: 0, end: 56000 }])
  // 只有一个窗口、或全是同一人：整句
  assert.deepEqual(splitByWindows(0, 30000, win([1]), 16000), [{ start: 0, end: 30000 }])
  // 末尾不足 1 秒的一段并入前一段
  const parts = splitByWindows(0, 60000, win([0, 0, 0, 0, 0, 1, 1]), 30000)
  assert.equal(parts.length, 1)
})

test('句内按窗口找换人（真人短句模拟接话）：比整句归一个人分对更多时间', () => {
  // 用真人短句声纹拼一句“A 说完 B 立刻接话”：每个窗口取相应说话人的一段声纹
  const spk = [...new Set(shortTurns.map((x) => x.spk))].sort()
  const a = shortTurns.filter((x) => x.ch === 'clean' && x.spk === spk[0])
  const b = shortTurns.filter((x) => x.ch === 'clean' && x.spk === spk[1])
  const online = new OnlineClusterer()
  for (const x of a.slice(0, 3)) online.seed(0, x.v)
  for (const x of b.slice(0, 3)) online.seed(1, x.v)
  const seq = [...a.slice(3, 7).map(() => 0), ...b.slice(3, 7).map(() => 1)]
  const wins = seq.map((who, i) => {
    const v = (who === 0 ? a : b)[3 + (i % 4)].v
    const sc = online.scores(v, 2).sort((x, y) => x.key - y.key)
    return { center: 12000 + i * 8000, scores: sc.map((x) => x.sim) }
  })
  const parts = splitByWindows(0, 12000 + seq.length * 8000, wins, 16000)
  assert.equal(parts.length, 2, `切成 ${parts.length} 段`)
  assert.ok(Math.abs(parts[0].end - (12000 + 3.5 * 8000)) <= 8000, `切点 ${parts[0].end}`)
})

test('两路对齐（D-033）：落后会议时间线超过容差才补静音，补到与时间线对齐', () => {
  // 刚开始：应用声音晚到 1 秒，第一块 0.1 秒
  assert.equal(alignPad(0, 1600, 16000 + 1600), 16000)
  // 正常采集的抖动（落后不到 0.25 秒）不补
  assert.equal(alignPad(16000, 1600, 16000 + 1600 + ALIGN_TOLERANCE - 1), 0)
  // 进程重启的缺口：补齐
  assert.equal(alignPad(32000, 1600, 64000), 64000 - 32000 - 1600)
  // 比时间线超前（采集早到一点）：不动
  assert.equal(alignPad(20000, 1600, 16000), 0)
})
