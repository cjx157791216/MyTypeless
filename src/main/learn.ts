/**
 * 自动词典学习（D-012）。纯逻辑，不依赖 electron，便于测试。
 * 两个来源：
 * - 写入后追踪修改：对比“写入的文字”和“用户改过之后的那一段”，学习被改正的词
 * - 常用专有名词：从听写结果里统计反复出现的英文专有名词
 * 收录规则：含英文字母/数字的改正词改一次即收录；中文改正词（2～6 字）同样的改正出现 2 次才收录；
 * 常用专有名词出现 3 次收录。被用户从词典删除过的词不再自动收录（由调用方维护屏蔽表）。
 */

export const CORRECTION_PROMOTE_CJK = 2
export const FREQUENT_PROMOTE = 3

/** 常见缩写/日常词：模型本来就认识，不必进词典 */
const COMMON = new Set(['OK', 'AI', 'PS', 'AM', 'PM', 'TV', 'ID', 'PC', 'APP', 'USB', 'PDF', 'URL', 'CEO', 'VS', 'MR', 'MS', 'DR'])

const HAN = /\p{Script=Han}/u

/** 从文本中提取像专有名词的英文词：内部有大写（DeepSeek、iPhone）、全大写缩写（API）、字母数字混合（GPT4o） */
export function extractTerms(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*/g)) {
    const w = m[0]
    if (w.length < 2 || w.length > 32) continue
    if (/^v?\d/i.test(w) && !/[a-z]{2}/i.test(w)) continue // 版本号
    const innerUpper = /[a-z][A-Z]/.test(w) || /^[a-z]+[A-Z]/.test(w)
    const allCaps = /^[A-Z]{2,8}$/.test(w)
    const alnum = /[A-Za-z]/.test(w) && /\d/.test(w)
    if (!(innerUpper || allCaps || alnum)) continue
    if (COMMON.has(w.toUpperCase())) continue
    out.add(w)
  }
  return [...out]
}

/** 分词：汉字逐字，英文/数字成词，其余（空白、标点）作为分隔丢弃 */
export function tokenize(text: string): string[] {
  return text.match(/\p{Script=Han}|[A-Za-z0-9]+(?:[-.'][A-Za-z0-9]+)*/gu) ?? []
}

export interface Correction {
  from: string
  to: string
}

/**
 * 对比写入的文字与当前内容（光标附近读到的一段，可能含前后无关文字），返回被替换的片段。
 * 两者相似度太低（用户整段改写/光标已不在这里）时返回空。
 */
export function diffCorrections(inserted: string, current: string): Correction[] {
  const a = tokenize(inserted)
  const b = tokenize(current)
  if (!a.length || !b.length || a.length > 400 || b.length > 600) return []
  // LCS 动态规划
  const dp: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  if (dp[0][0] < a.length * 0.6) return []
  // 回溯成编辑脚本
  type Op = { t: 'eq' | 'del' | 'ins'; tok: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', tok: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: 'del', tok: a[i++] })
    else ops.push({ t: 'ins', tok: b[j++] })
  }
  while (i < a.length) ops.push({ t: 'del', tok: a[i++] })
  while (j < b.length) ops.push({ t: 'ins', tok: b[j++] })

  // 切成替换块：只认首次匹配之后、最后一次匹配之前（或紧跟其后）的“删 + 插”，排除读到的前后无关上下文
  const firstEq = ops.findIndex((o) => o.t === 'eq')
  let lastEq = -1
  for (let k = ops.length - 1; k >= 0; k--) if (ops[k].t === 'eq') { lastEq = k; break }
  if (firstEq < 0) return []
  interface Hunk { from: string[]; to: string[]; start: number; end: number }
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  for (let k = firstEq; k < ops.length; k++) {
    const o = ops[k]
    if (o.t === 'eq') {
      if (cur) hunks.push(cur)
      cur = null
      if (k >= lastEq) {
        // 末尾：写入的文字剩余被删、紧接着出现新内容 → 也视为替换
        const rest = ops.slice(k + 1)
        const del = rest.filter((r) => r.t === 'del').map((r) => r.tok)
        const ins = rest.filter((r) => r.t === 'ins').map((r) => r.tok).slice(0, del.length + 2)
        if (del.length && ins.length) hunks.push({ from: del, to: ins, start: k + 1, end: ops.length })
        break
      }
      continue
    }
    cur ??= { from: [], to: [], start: k, end: k }
    if (o.t === 'del') cur.from.push(o.tok)
    else cur.to.push(o.tok)
    cur.end = k + 1
  }
  const real = hunks.filter((h) => h.from.length && h.to.length)

  // 中文：两处替换之间只隔一个相同汉字时合并（张三丰 → 章三峰）
  const merged: Hunk[] = []
  for (const h of real) {
    const prev = merged.at(-1)
    const between = prev ? ops.slice(prev.end, h.start) : []
    if (prev && between.length === 1 && between[0].t === 'eq' && HAN.test(between[0].tok)) {
      prev.from.push(between[0].tok, ...h.from)
      prev.to.push(between[0].tok, ...h.to)
      prev.end = h.end
    } else merged.push({ ...h, from: [...h.from], to: [...h.to] })
  }
  // 中文单字替换：带上前一个相同汉字组成双字词（开放 → 开饭），便于作为词条学习
  for (const h of merged) {
    if (h.from.length === 1 && h.to.length === 1 && HAN.test(h.to[0])) {
      const before = ops[h.start - 1]
      if (before?.t === 'eq' && HAN.test(before.tok)) {
        h.from.unshift(before.tok)
        h.to.unshift(before.tok)
      }
    }
  }
  return merged.map((h) => ({ from: joinTokens(h.from), to: joinTokens(h.to) }))
}

function joinTokens(tokens: string[]): string {
  let s = ''
  for (const t of tokens) {
    if (s && !HAN.test(t) && !HAN.test(s.slice(-1))) s += ' '
    s += t
  }
  return s
}

export interface LearnCandidate {
  term: string
  /** true：改一次即收录（含英文/数字）；false：需累计 CORRECTION_PROMOTE_CJK 次 */
  immediate: boolean
}

/** 从一次改正中挑出值得学习的词 */
export function learnableFromCorrection(c: Correction): LearnCandidate | null {
  const to = c.to.trim()
  if (!to || to === c.from || to.length > 24) return null
  if (/[A-Za-z0-9]/.test(to)) {
    if (!/[A-Za-z]{2}/.test(to) || COMMON.has(to.toUpperCase())) return null
    // 只改了大小写/空格也算（如 deepseek → DeepSeek），但必须与原词有关联或长度相近，避免整句改写
    if (to.length > Math.max(c.from.length * 2, 16)) return null
    return { term: to, immediate: true }
  }
  if (HAN.test(to) && [...to].length >= 2 && [...to].length <= 6 && [...c.from].length <= 8) {
    return { term: to, immediate: false }
  }
  return null
}

/** 风格学习：光标停在改动后面不远（末尾追加了几个字，如表情、语气词）时，把这几个字也算进修改 */
const APPEND_MAX = 8

/**
 * 风格学习（D-041）：在光标附近读到的文字里找出写入的那一段被用户改成了什么样。
 * 半全局对齐（写入内容整体对齐到读到文字中的一段，两端的无关上下文不计代价），取编辑距离最小、最靠后的一段；
 * 改动超过写入内容的一半（整段重写 / 光标已离开）或没有改动时返回 null。caret 为光标在 current 中的 UTF-16 位置。
 */
export function editedSpan(inserted: string, current: string, caret: number): string | null {
  const a = [...inserted.trim()]
  const b = [...current]
  const n = a.length
  const m = b.length
  if (!n || !m || n > 400 || m > 600) return null
  // d[i][j]：a 的前 i 个字对齐到 b 中以 j 结尾的一段的最小编辑距离；s[i][j]：该段在 b 中的起点
  let prevD = new Int32Array(m + 1)
  let prevS = new Int32Array(m + 1)
  for (let j = 0; j <= m; j++) prevS[j] = j
  for (let i = 1; i <= n; i++) {
    const d = new Int32Array(m + 1)
    const s = new Int32Array(m + 1)
    d[0] = i
    for (let j = 1; j <= m; j++) {
      let best = prevD[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      let start = prevS[j - 1]
      if (prevD[j] + 1 < best) (best = prevD[j] + 1), (start = prevS[j])
      if (d[j - 1] + 1 < best) (best = d[j - 1] + 1), (start = s[j - 1])
      d[j] = best
      s[j] = start
    }
    prevD = d
    prevS = s
  }
  let end = 0
  for (let j = 1; j <= m; j++) if (prevD[j] <= prevD[end]) end = j
  const dist = prevD[end]
  const start = prevS[end]
  if (dist > n * 0.5 || end <= start) return null
  // 光标在这一段后面不远：末尾追加的几个字（不跨行）也算修改
  const caretAt = [...current.slice(0, Math.max(0, caret))].length
  let stop = end
  if (caretAt > end && caretAt - end <= APPEND_MAX && !b.slice(end, caretAt).includes('\n')) stop = caretAt
  const after = b.slice(start, stop).join('').trim()
  if (!after || after === a.join('')) return null
  return after
}
