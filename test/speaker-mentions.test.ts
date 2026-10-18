import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSpeakerMentions, markSpeakerNames } from '../src/shared/speaker-mentions.ts'

const names = (text: string, list: string[]) => findSpeakerMentions(text, list).map((m) => text.slice(m.start, m.end))

test('多字名字在任意位置标出', () => {
  assert.deepEqual(names('设计师说明原始户型；成表示认可设计师的方案', ['设计师']), ['设计师', '设计师'])
})

test('单字名字只在句首、标点或介词后，且后面接标点或常见动词时标出；连列的名字也算', () => {
  const list = ['成', '胡']
  assert.deepEqual(names('成表示认可。胡关注玄关；成、胡提出参考案例', list), ['成', '胡', '成', '胡'])
  assert.deepEqual(names('负责人：成；截止：待定', list), ['成'])
  assert.deepEqual(names('成', list), ['成'])
  assert.deepEqual(names('根据成、胡复核意见；将与胡复核方案；成和胡讨论餐边柜', list), ['成', '胡', '胡', '成', '胡'])
  // 词语里的同一个字不算
  assert.deepEqual(names('方案已完成，墙体较稳固但占空间、成本较高，与成本相比，住在胡同里，去成都', list), [])
})

test('名字以数字或字母结尾时不吞掉更长的编号', () => {
  assert.deepEqual(names('说话人 1 与说话人 10 讨论', ['说话人 1', '说话人 10']), ['说话人 1', '说话人 10'])
  assert.deepEqual(names('说话人 10 提出', ['说话人 1']), [])
  assert.deepEqual(names('Tomorrow Tom will', ['Tom']), ['Tom'])
})

test('优先匹配更长的名字，返回的 name 是名单里的名字', () => {
  const m = findSpeakerMentions('现场 1 和现场 12', ['现场 1', '现场 12'])
  assert.deepEqual(m, [
    { start: 0, end: 4, name: '现场 1' },
    { start: 6, end: 11, name: '现场 12' }
  ])
})

test('空名单或空名字不标', () => {
  assert.deepEqual(findSpeakerMentions('成表示认可', []), [])
  assert.deepEqual(findSpeakerMentions('成表示认可', ['', '  ']), [])
})

test('纪要原文里的说话人名字加粗；已有的粗体和代码不动，重复执行结果不变', () => {
  const md = ['### 成', '- 设计师说明原始户型；成表示认可', '- 成、胡提出参考案例', '- [ ] 复核方案（负责人：成；截止：待定）', '- 已完成 `成本` 核算'].join('\n')
  const marked = markSpeakerNames(md, ['成', '胡', '设计师'])
  assert.equal(
    marked,
    ['### **成**', '- **设计师**说明原始户型；**成**表示认可', '- **成**、**胡**提出参考案例', '- [ ] 复核方案（负责人：**成**；截止：待定）', '- 已完成 `成本` 核算'].join('\n')
  )
  assert.equal(markSpeakerNames(marked, ['成', '胡', '设计师']), marked)
})

test('名字里有 Markdown 符号时不加粗（避免破坏格式）', () => {
  assert.equal(markSpeakerNames('a*b 表示同意', ['a*b']), 'a*b 表示同意')
})
