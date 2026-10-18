/**
 * 在会议纪要文字里找出说话人名字，生成纪要时加粗（`**名字**`），界面再把加粗的说话人名字显示成彩色标签。
 * 两个字以上的名字在任意位置匹配；单字名字（如「成」「胡」）容易撞上普通词语（完成、成本、胡同），
 * 只在句首、标点或介词（与、根据…）后，且后面接标点或常见的“谁做了什么”动词时才算；
 * 紧跟在另一个名字后连列（成、胡 / 成和胡）的也算。
 */

export interface SpeakerMention {
  start: number
  end: number
  name: string
}

/** 标点、空白 */
const BOUNDARY = /[\s\p{P}\p{S}]/u
/** 字母数字（不含汉字）：名字首尾是字母数字时，相邻字符不能也是（「说话人 1」不匹配「说话人 10」） */
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c) && !/\p{Script=Han}/u.test(c)

/** 单字名字后面允许接的词（纪要里“某某表示 / 认为 / 提出…”的写法） */
const SINGLE_CHAR_FOLLOWERS = [
  '表示', '认为', '提出', '询问', '说明', '确认', '建议', '同意', '倾向', '关注', '希望', '介绍', '展示',
  '明确', '补充', '强调', '担心', '指出', '回应', '提到', '提醒', '提示', '负责', '认可', '解释', '反馈',
  '追问', '质疑', '坚持', '计划', '承诺', '决定', '主张', '赞同', '反对', '进一步', '最终', '初步',
  '接受', '反映', '讨论', '复核', '共同', '一起', '购', '打算', '准备', '考虑', '要求', '需要', '觉得', '想',
  '也', '还', '则', '和', '与', '及', '会', '将', '需', '不', '没', '已', '可', '先', '再'
]
/** 单字名字前面允许的介词 */
const SINGLE_CHAR_LEADERS = ['根据', '与', '和', '跟', '同', '由', '向', '对', '给', '请', '让', '被', '及']
/** 连列名字之间的分隔 */
const JOINERS = '、和与及跟'


export function findSpeakerMentions(text: string, names: string[]): SpeakerMention[] {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!list.length) return []
  const out: SpeakerMention[] = []
  let i = 0
  while (i < text.length) {
    const joined = out.length > 0 && out[out.length - 1].end === i - 1 && JOINERS.includes(text[i - 1])
    const name = list.find((n) => text.startsWith(n, i) && fits(text, i, n, joined))
    if (name) {
      out.push({ start: i, end: i + name.length, name })
      i += name.length
    } else i++
  }
  return out
}

/** 已有的粗体与行内代码原样保留，不在里面再找名字 */
const KEEP = /(`[^`\n]*`|\*\*[^*\n]+\*\*)/

/** 纪要 Markdown 里的说话人名字加粗；重复执行结果不变。名字里有 * 或 ` 时不处理（会破坏格式） */
export function markSpeakerNames(md: string, names: string[]): string {
  const list = names.filter((n) => !/[*`]/.test(n))
  if (!list.length) return md
  return md
    .split(KEEP)
    .map((part, i) => {
      if (i % 2 === 1) return part
      let out = ''
      let at = 0
      for (const m of findSpeakerMentions(part, list)) {
        out += `${part.slice(at, m.start)}**${part.slice(m.start, m.end)}**`
        at = m.end
      }
      return out + part.slice(at)
    })
    .join('')
}

function fits(text: string, start: number, name: string, joined: boolean): boolean {
  const end = start + name.length
  const before = text[start - 1]
  const after = text[end]
  if (isWordChar(name[0]) && isWordChar(before)) return false
  if (isWordChar(name[name.length - 1]) && isWordChar(after)) return false
  if (name.length > 1 || joined) return true
  if (before !== undefined && !BOUNDARY.test(before) && !SINGLE_CHAR_LEADERS.some((w) => text.endsWith(w, start))) return false
  return after === undefined || BOUNDARY.test(after) || SINGLE_CHAR_FOLLOWERS.some((w) => text.startsWith(w, end))
}
