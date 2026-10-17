/**
 * 识别结果的文本规整（纯函数，不依赖 electron，便于测试）。
 */

/** 拼接两段识别结果：任一侧是汉字/中文标点则直接相连，否则补一个空格 */
export function joinText(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return /[\p{Script=Han}，。！？、；：]$/u.test(a) || /^[\p{Script=Han}，。！？、；：]/u.test(b) ? a + b : `${a} ${b}`
}

const HAN = '\\p{Script=Han}'
const PUNCT_MAP: Record<string, string> = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' }

/**
 * 中文语境下的英文标点 → 中文标点：前面是汉字（或右引号/右括号）时转换；
 * 句点只在前面是汉字时转为“。”，避免误伤 3.5、v1.2、example.com。
 */
export function normalizeChinesePunctuation(text: string): string {
  return text
    .replace(new RegExp(`(${HAN}|[”’）])\\s*([,?!:;])\\s*`, 'gu'), (_m, prev: string, p: string) => prev + PUNCT_MAP[p])
    .replace(new RegExp(`(${HAN})\\s*\\.(?!\\d)\\s*`, 'gu'), '$1。')
    .replace(new RegExp(`([，。？！：；])\\s+(?=${HAN})`, 'gu'), '$1')
}

/** whisper 系模型在静音/噪声上的典型幻觉输出（多来自视频字幕训练数据）；命中的整段丢弃 */
const HALLUCINATIONS = [
  /^(谢谢观看|谢谢收看|感谢观看|谢谢大家|谢谢)[。！!.]?$/,
  /字幕由.*提供/,
  /字幕(志愿者|制作|翻译|校对)/,
  /请不吝点赞.*订阅/,
  /^(thank you( for watching)?|thanks for watching|you)[.!]?$/i,
  /^\[?(music|音乐|blank_audio)\]?$/i
]

export function isHallucination(text: string): boolean {
  const t = text.trim()
  return HALLUCINATIONS.some((re) => re.test(t))
}

/**
 * 去掉 FireRedASR2 输出里的特殊标记（静音时输出 <sil>，还有 <unk> 等；标点模型会把它拆成“< sil >”并补上“。”）。
 * 去掉后只剩标点/空白的整段为空，开头残留的标点一并去掉。
 */
export function stripAsrTokens(text: string): string {
  const out = text
    .replace(/\s*<\s*[A-Za-z_][\w-]*\s*>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`(?<=${HAN}|[，。！？、；：]) | (?=${HAN}|[，。！？、；：])`, 'gu'), '')
    .trim()
  if (!/[\p{L}\p{N}]/u.test(out)) return ''
  return out.replace(/^[\s，。！？、；：,.!?;:]+/u, '')
}

/** 常见缩写：识别结果里保持全大写 */
const KEEP_UPPER = new Set(
  'AI API APP AR ASR B2B CEO CFO COO CPU CTO CV GDP GPU HR ID IP IT KPI LLM MBA ML NBA NLP OK OKR PC PDF PM PPT PR QA QR ROI SDK SQL TTS TV UI URL USB UX VIP VR'.split(' ')
)

/**
 * 恢复识别结果中英文的大小写（FireRedASR2 输出的英文全大写，D-027）：词典里的词按词典写法（含多词，如 Claude Code），
 * 常见缩写与单独的 I 保持大写，带数字的保持原样，其余全大写的词改小写；已有小写字母的词不动。纯英文的一句首字母大写。
 */
export function fixAsrCase(text: string, vocabulary: string[]): string {
  let out = text
  const vocab = new Map<string, string>()
  for (const w of vocabulary) {
    if (!/[A-Za-z]/.test(w)) continue
    if (/\s/.test(w)) {
      const pattern = w.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')
      out = out.replace(new RegExp(`(?<![A-Za-z])${pattern}(?![A-Za-z])`, 'gi'), w)
    } else vocab.set(w.toLowerCase(), w)
  }
  out = out.replace(/[A-Za-z][A-Za-z0-9']*/g, (w) => {
    if (w !== w.toUpperCase()) return w
    const v = vocab.get(w.toLowerCase())
    if (v) return v
    if (w === 'I' || KEEP_UPPER.has(w) || /\d/.test(w)) return w
    return w.toLowerCase()
  })
  if (!/\p{Script=Han}/u.test(out)) out = out.replace(/^(\s*)([a-z])/, (_, sp: string, c: string) => sp + c.toUpperCase())
  return out
}

