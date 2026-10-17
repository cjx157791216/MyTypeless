/**
 * 说话人聚类（D-015、D-019）。纯逻辑，不依赖 electron。
 * 输入是每段话的声音特征向量（mt-diarize 输出，ERes2NetV2 192 维，D-026）。
 *
 * 判断“是不是同一个人”一律用**平均链接**：新的一段与某人每一段的余弦相似度的平均值
 * （= 归一化向量 · 该人归一化向量之和 / 段数，计算量与中心比较相同）。
 * 不用“与归一化中心的余弦”：多段平均后，各人共有的成分（同一个麦克风、外放、房间）被放大，不同的人显得很像——
 * 真人 4 人录音模拟外放后，与中心比较时不同的人升到 0.5 以上被并成一个；两两平均则同一人 ≥ 0.60、不同人 ≤ 0.53。
 * 门槛按真实会议录音标定（AliMeeting 远场 3 场 × 4 人、1～3 秒短段，D-026）：换模型后保持“把不同的人并成一个”的比例与原门槛相同。
 */

/** 声纹模型标识：不同模型的声纹不能互相比较（会议与声纹都记下用的是哪个模型） */
export const EMBED_MODEL = 'eres2netv2-zh-cn'

export const SAME_SPEAKER = 0.57 // 平均相似度达到此值视为同一人（在线归入、句内合并；不同人误并约 0.1%）
// 整体归类只按参会人数（D-021）：不再按声音自动判断人数——真实会议多是 1～2 秒短句，同一人两句常低到 0.1～0.3，
// 不同人之间也可能到 0.4，任何固定门槛都会两头出错（拆成十几人，或把说得少的一方并掉）
export const KNOWN_CUT = 0.45 // 初分门槛（不同人误并约 1.4%）；之后取发言最多的 k 组为主、逐段重新归属
export const MIN_EMBED_MS = 800 // 短于此的段声纹不可靠：不参与归类，跟随上下文
// 认人（D-022）：一组与声纹的平均相似度 ÷ 声纹自身的一致度（|声纹|²，即保存时这人各句两两的平均相似度）。
// 不用固定门槛：有的人声音起伏大，自己各句之间平均只有 0.5，固定 0.55 连保存声纹的那场会议都认不出来
export const PRINT_MATCH = 0.7 // 真实会议 3 句一组：误认 1.8%、漏认 0.9%（0.65 时误认 4% 以上）
export const PRINT_MIN_SEGMENTS = 2 // 至少说过这么多句才认（单句不稳）

export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 余弦相似度（不要求输入已归一化） */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return dot(a, b) / (Math.sqrt(dot(a, a) * dot(b, b)) || 1)
}

/** 一组声纹：归一化向量之和与段数；mean() 是未归一化的平均向量（与它点乘即平均相似度） */
class Group {
  sum: Float32Array
  n = 0
  constructor(dim: number) {
    this.sum = new Float32Array(dim)
  }
  add(u: ArrayLike<number>, times = 1): void {
    for (let i = 0; i < u.length; i++) this.sum[i] += u[i] * times
    this.n += times
  }
  /** 一段（已归一化）与本组的平均相似度 */
  avg(u: ArrayLike<number>): number {
    return this.n ? dot(u, this.sum) / this.n : -1
  }
  mean(): Float32Array {
    return Float32Array.from(this.sum, (x) => x / (this.n || 1))
  }
}

/** 会议中在线归类 */
export class OnlineClusterer {
  private readonly groups = new Map<number, Group>()

  /** 加入一段到指定说话人（重建、恢复时用） */
  seed(key: number, v: ArrayLike<number>): void {
    const u = normalize(v)
    const g = this.groups.get(key) ?? new Group(u.length)
    g.add(u)
    this.groups.set(key, g)
  }

  /** 归类：与某人平均相似度达到门槛就归入，否则调用 create 新建；已有 max 人时只归入最像的人 */
  assign(v: ArrayLike<number>, create: () => number, max = Infinity): { key: number; created: boolean } {
    const u = normalize(v)
    let best = -1
    let bestSim = -Infinity
    for (const [key, g] of this.groups) {
      const s = g.avg(u)
      if (s > bestSim) {
        bestSim = s
        best = key
      }
    }
    if (best >= 0 && (bestSim >= SAME_SPEAKER || this.groups.size >= max)) {
      this.groups.get(best)!.add(u)
      return { key: best, created: false }
    }
    const key = create()
    this.seed(key, u)
    return { key, created: true }
  }

  /** 把 from 并入 into（用户手动合并） */
  merge(from: number, into: number): void {
    const a = this.groups.get(from)
    if (!a) return
    const b = this.groups.get(into)
    if (!b) this.groups.set(into, a)
    else {
      for (let i = 0; i < b.sum.length; i++) b.sum[i] += a.sum[i]
      b.n += a.n
    }
    this.groups.delete(from)
  }

  /** 该说话人的平均向量（未归一化，用于声纹认人与保存） */
  centroid(key: number): Float32Array | null {
    return this.groups.get(key)?.mean() ?? null
  }

  size(key: number): number {
    return this.groups.get(key)?.n ?? 0
  }

  /** 至少有 minN 段的说话人数 */
  countWith(minN: number): number {
    let n = 0
    for (const g of this.groups.values()) if (g.n >= minN) n++
    return n
  }

  /** 至少有 minN 段的说话人：与 v 的平均相似度（句内按窗口找换人位置用，D-025） */
  scores(v: ArrayLike<number>, minN: number): Array<{ key: number; sim: number }> {
    const u = normalize(v)
    const out: Array<{ key: number; sim: number }> = []
    for (const [key, g] of this.groups) if (g.n >= minN) out.push({ key, sim: g.avg(u) })
    return out
  }

  clear(): void {
    this.groups.clear()
  }
}

export interface ClusterItem {
  id: number // 段 id
  speaker: number | null // 当前所属说话人
  v: ArrayLike<number> | null // 声音特征（短段可为空）
  durMs: number
  locked: boolean // 用户手动指定过说话人：不改
}

export interface RegroupResult {
  /** 段 id → 说话人 */
  assign: Map<number, number>
  /** 不再出现的原说话人 → 其多数段的去向 */
  merged: Map<number, number>
  /** 最终每个说话人的平均向量（未归一化） */
  means: Map<number, Float32Array>
  /** 每个说话人参与归类的段数 */
  sizes: Map<number, number>
}

/**
 * 按参会人数 k 整体重新区分说话人（会议进行中定期、结束时、用户改人数时）：对所有有声纹的段做平均链接层次聚类
 * （最近邻链算法，O(n²)，4 小时会议也只需零点几秒），取发言最多的 k 组为主，每段重新归到平均最像的一组（迭代 3 次）。
 * 没有人数（较早的会议）时不重新聚类，只按现有归属计算每人的平均向量。
 * 约束：锁定（用户手动指定）的段、用户命名过的不同说话人不会被并到一起。
 * 结果映射回已有的说话人编号（尽量保持编号与名字不变），多出来的人用 create 新建。
 */
export function regroup(items: ClusterItem[], opts: { expected: number | null; named?: Set<number>; create: () => number }): RegroupResult {
  const named = opts.named ?? new Set<number>()
  const usable = items.filter((it) => it.v && it.durMs >= MIN_EMBED_MS && it.speaker !== null)
  const n = usable.length
  const assign = new Map<number, number>()
  const merged = new Map<number, number>()
  const means = new Map<number, Float32Array>()
  const sizes = new Map<number, number>()
  if (!n) {
    for (const it of items) if (it.speaker !== null) assign.set(it.id, it.speaker)
    return { assign, merged, means, sizes }
  }
  const dim = usable[0].v!.length
  const vecs = usable.map((it) => normalize(it.v!))
  // 约束标签：锁定段 → 锁定的说话人；命名说话人的段 → 该说话人；两簇标签不同不能合并
  const tag = usable.map((it) => (it.locked || named.has(it.speaker!) ? it.speaker! : null))

  // 簇间相似度之和 S[a][b] = Σ_{i∈a, j∈b} u_i·u_j；平均相似度 = S / (|a||b|)
  const S = new Float64Array(n * n)
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S[i * n + j] = S[j * n + i] = dot(vecs[i], vecs[j])
  const size = new Array<number>(n).fill(1)
  const ctag: Array<number | null> = [...tag]
  const active = new Array<boolean>(n).fill(true)
  const sim = (a: number, b: number) => (ctag[a] !== null && ctag[b] !== null && ctag[a] !== ctag[b] ? -Infinity : S[a * n + b] / (size[a] * size[b]))

  // 最近邻链：得到整棵合并树（平均链接可约，按相似度从高到低应用即为贪心结果）
  const merges: Array<{ a: number; b: number; s: number }> = []
  let remaining = n
  const chain: number[] = []
  while (remaining > 1) {
    if (!chain.length) chain.push(active.indexOf(true))
    const a = chain[chain.length - 1]
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1
    let b = -1
    let best = -Infinity
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === a) continue
      const s = sim(a, c)
      if (s > best || (s === best && c === prev)) {
        best = s
        b = c
      }
    }
    if (b < 0 || best === -Infinity) {
      // 与其余所有簇都有约束冲突：自成一簇，退出合并
      active[a] = false
      chain.pop()
      remaining--
      continue
    }
    if (b !== prev) {
      chain.push(b)
      continue
    }
    chain.pop()
    chain.pop()
    merges.push({ a, b, s: best })
    for (let c = 0; c < n; c++) {
      if (c === a || c === b) continue
      S[a * n + c] = S[c * n + a] = S[a * n + c] + S[b * n + c]
    }
    size[a] += size[b]
    ctag[a] = ctag[a] ?? ctag[b]
    active[b] = false
    remaining--
  }

  // 切树：按相似度从高到低应用合并（平均链接可约，即为贪心结果）
  merges.sort((x, y) => y.s - x.s)
  const k = opts.expected && opts.expected > 0 ? opts.expected : null
  const cutAt = (cut: number, maxMerges = Infinity): number[][] => {
    const root = Array.from({ length: n }, (_, i) => i)
    const find = (x: number): number => (root[x] === x ? x : (root[x] = find(root[x])))
    let done = 0
    for (const m of merges) {
      if (m.s < cut || done >= maxMerges) break
      const ra = find(m.a)
      const rb = find(m.b)
      if (ra === rb) continue
      root[rb] = ra
      done++
    }
    const members = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      const r = find(i)
      const list = members.get(r)
      if (list) list.push(i)
      else members.set(r, [i])
    }
    return [...members.values()]
  }
  const durOf = (ms: number[]) => ms.reduce((t, i) => t + usable[i].durMs, 0)
  const sumOf = (ms: number[]) => {
    const g = new Group(dim)
    for (const i of ms) g.add(vecs[i])
    return g
  }
  const tagOf = (ms: number[]) => ms.map((i) => tag[i]).find((t) => t !== null) ?? null
  let clusterList: number[][]
  if (k) {
    // 已知人数：先按 KNOWN_CUT 切；簇不够就在更高处切出 k 个；取发言最多的 k 个为主，其余逐段重新归到最像的主簇
    let cl = cutAt(KNOWN_CUT)
    if (cl.length < k) cl = cutAt(-Infinity, n - k)
    cl.sort((x, y) => durOf(y) - durOf(x))
    const majors = cl.slice(0, k).map((ms) => [...ms])
    const m = majors.length // 句子比参会人数少时（会议刚开始）簇数可能不到 k
    const fixed = new Set<number>() // 有约束标签的段不挪动
    for (const ms of majors) for (const i of ms) if (tag[i] !== null) fixed.add(i)
    let owner = new Array<number>(n).fill(-1)
    majors.forEach((ms, j) => ms.forEach((i) => (owner[i] = j)))
    for (let iter = 0; iter < 3; iter++) {
      const sums = majors.map((_, j) => sumOf(owner.map((o, i) => (o === j ? i : -1)).filter((i) => i >= 0)))
      const next = [...owner]
      for (let i = 0; i < n; i++) {
        if (fixed.has(i)) continue
        let best = owner[i]
        let bestSim = -Infinity
        for (let j = 0; j < m; j++) {
          const g = sums[j]
          const self = owner[i] === j
          const cnt = g.n - (self ? 1 : 0)
          if (cnt <= 0) continue
          const t = tagOf(majors[j])
          if (tag[i] !== null && t !== null && t !== tag[i]) continue
          const s = (dot(vecs[i], g.sum) - (self ? 1 : 0)) / cnt
          if (s > bestSim) {
            bestSim = s
            best = j
          }
        }
        next[i] = best
      }
      // 不能把某个人的段全部拉走（选了几个人就保证分出几个人）：留下与自己这组最像、相对最像别组差得最多的一段
      for (let j = 0; j < m; j++) {
        if (next.includes(j)) continue
        let keep = -1
        let margin = -Infinity
        for (let i = 0; i < n; i++) {
          if (owner[i] !== j || fixed.has(i) || next[i] < 0) continue
          const g = sums[j]
          const own = g.n > 1 ? (dot(vecs[i], g.sum) - 1) / (g.n - 1) : 1
          const to = sums[next[i]]
          const other = to.n ? dot(vecs[i], to.sum) / to.n : 0
          if (own - other > margin) {
            margin = own - other
            keep = i
          }
        }
        if (keep >= 0) next[keep] = j
      }
      owner = next
    }
    clusterList = majors.map((_, j) => owner.map((o, i) => (o === j ? i : -1)).filter((i) => i >= 0)).filter((ms) => ms.length)
  } else {
    // 没有人数：保持现有归属
    const bySpeaker = new Map<number, number[]>()
    usable.forEach((it, i) => bySpeaker.set(it.speaker!, [...(bySpeaker.get(it.speaker!) ?? []), i]))
    clusterList = [...bySpeaker.values()]
  }
  clusterList.sort((x, y) => y.length - x.length)

  // 每个簇映射到已有说话人：锁定/命名标签优先，否则取簇内最多的原说话人（每个说话人只用一次）
  const speakerOf = new Map<number[], number>()
  const used = new Set<number>()
  for (const ms of clusterList) {
    const t = ms.map((i) => tag[i]).find((x) => x !== null)
    if (t !== undefined && t !== null && !used.has(t)) {
      speakerOf.set(ms, t)
      used.add(t)
    }
  }
  for (const ms of clusterList) {
    if (speakerOf.has(ms)) continue
    const votes = new Map<number, number>()
    for (const i of ms) votes.set(usable[i].speaker!, (votes.get(usable[i].speaker!) ?? 0) + 1)
    const pick = [...votes].sort((x, y) => y[1] - x[1]).find(([sp]) => !used.has(sp))?.[0]
    const sp = pick ?? opts.create()
    speakerOf.set(ms, sp)
    used.add(sp)
  }

  const oldVotes = new Map<number, Map<number, number>>() // 原说话人 → 新说话人的票数（给没有声纹的短段用）
  for (const [ms, sp] of speakerOf) {
    const g = new Group(dim)
    for (const i of ms) {
      g.add(vecs[i])
      assign.set(usable[i].id, sp)
      const old = usable[i].speaker!
      const m = oldVotes.get(old) ?? new Map<number, number>()
      m.set(sp, (m.get(sp) ?? 0) + 1)
      oldVotes.set(old, m)
    }
    means.set(sp, g.mean())
    sizes.set(sp, g.n)
  }
  const fate = new Map<number, number>()
  for (const [old, m] of oldVotes) fate.set(old, [...m].sort((x, y) => y[1] - x[1])[0][0])
  for (const [old, to] of fate) if (old !== to && !used.has(old)) merged.set(old, to)
  for (const it of items) {
    if (assign.has(it.id) || it.speaker === null) continue
    assign.set(it.id, it.locked ? it.speaker : (fate.get(it.speaker) ?? it.speaker))
  }
  return { assign, merged, means, sizes }
}

/** 一组与声纹的匹配分：平均相似度 ÷ 声纹自身的一致度（同一人约 0.65～1，不同的人 ≤ 0.6） */
export function printScore(mean: ArrayLike<number>, print: ArrayLike<number>): number {
  const self = dot(print, print)
  return self > 0 ? dot(mean, print) / self : -1
}

/**
 * 按声纹库给本场的说话人认名字（D-022）：每组（平均向量 + 段数）与每个声纹打分，达到 PRINT_MATCH 的配对按分数从高到低
 * 一一指派（一个声纹只给一个人；taken 是本场已用过的声纹）。返回 说话人 → 声纹 id。
 */
export function identifySpeakers(
  groups: Array<{ key: number; mean: ArrayLike<number>; n: number }>,
  prints: Array<{ id: number; vector: ArrayLike<number> }>,
  taken: Set<number> = new Set()
): Map<number, number> {
  const cand: Array<{ key: number; id: number; s: number }> = []
  for (const g of groups) {
    if (g.n < PRINT_MIN_SEGMENTS) continue
    for (const p of prints) {
      if (taken.has(p.id) || p.vector.length !== g.mean.length) continue
      const s = printScore(g.mean, p.vector)
      if (s >= PRINT_MATCH) cand.push({ key: g.key, id: p.id, s })
    }
  }
  cand.sort((x, y) => y.s - x.s)
  const out = new Map<number, number>()
  const used = new Set(taken)
  for (const c of cand) {
    if (out.has(c.key) || used.has(c.id)) continue
    out.set(c.key, c.id)
    used.add(c.id)
  }
  return out
}

/** 声纹更新：两个平均向量按段数加权平均（保持未归一化） */
export function blendVoiceprint(old: ArrayLike<number>, oldN: number, add: ArrayLike<number>, addN: number): Float32Array {
  const out = new Float32Array(old.length)
  const total = oldN + addN || 1
  for (let i = 0; i < old.length; i++) out[i] = (old[i] * oldN + add[i] * addN) / total
  return out
}

export interface VoicedPart {
  start: number
  end: number
  v: Float32Array | null
}

/**
 * 句内切开的各段先算声纹，相邻且是同一个人的合回一段（少一次识别、转写上下文更完整）：
 * 没有声纹的短段跟随前一段；与当前段的平均相似度达到 SAME_SPEAKER 视为同一人。
 */
export function mergeAdjacentParts(parts: VoicedPart[]): VoicedPart[] {
  const out: Array<{ start: number; end: number; g: Group | null }> = []
  for (const p of parts) {
    const cur = out.at(-1)
    const u = p.v ? normalize(p.v) : null
    if (cur && (!u || !cur.g || cur.g.avg(u) >= SAME_SPEAKER)) {
      cur.end = p.end
      if (u) {
        cur.g ??= new Group(u.length)
        cur.g.add(u)
      }
      continue
    }
    let g: Group | null = null
    if (u) {
      g = new Group(u.length)
      g.add(u)
    }
    out.push({ start: p.start, end: p.end, g })
  }
  // 合并后的段用其各部分的平均向量（未归一化；归类时会再归一化）
  return out.map((o) => ({ start: o.start, end: o.end, v: o.g ? o.g.mean() : null }))
}

export const WINDOW_MS = 1500 // 句内找换人：每个窗口 1.5 秒
export const WINDOW_HOP_MS = 500 // 每 0.5 秒一个窗口
export const WINDOW_MIN_PART_MS = 1000 // 切出的段不短于 1 秒（更短的并入前一段）

/**
 * 句内按窗口找换人位置（D-025）：会议已经区分出几个人后，用这一句里每个窗口与各人的平均相似度（scores 按同一顺序），
 * 前后各平滑一个窗口取最像的人，在归属变化处（两个窗口中心的中点）切开；短于 minPart 的段并入前一段。
 * 比通用的分段模型可靠：它用上了本场已知的人数和每个人的声音（短句模拟对话：归对的时间 81% → 95%）。
 */
export function splitByWindows(start: number, end: number, wins: Array<{ center: number; scores: number[] }>, minPart: number): Array<{ start: number; end: number }> {
  if (wins.length < 2) return [{ start, end }]
  const k = wins[0].scores.length
  const label = wins.map((_, i) => {
    let best = 0
    let bestSum = -Infinity
    for (let j = 0; j < k; j++) {
      let sum = 0
      for (let t = Math.max(0, i - 1); t <= Math.min(wins.length - 1, i + 1); t++) sum += wins[t].scores[j]
      if (sum > bestSum) {
        bestSum = sum
        best = j
      }
    }
    return best
  })
  const parts: Array<{ start: number; end: number }> = []
  let cur = { start, end }
  for (let i = 1; i < wins.length; i++) {
    if (label[i] === label[i - 1]) continue
    const cut = Math.round((wins[i - 1].center + wins[i].center) / 2)
    if (cut <= cur.start || cut >= end) continue
    cur.end = cut
    parts.push(cur)
    cur = { start: cut, end }
  }
  parts.push(cur)
  const out: Array<{ start: number; end: number }> = []
  for (const p of parts) {
    const last = out.at(-1)
    if (last && p.end - p.start < minPart) last.end = p.end
    else out.push({ ...p })
  }
  if (out.length > 1 && out[0].end - out[0].start < minPart) {
    out[1].start = out[0].start
    out.shift()
  }
  return out
}
