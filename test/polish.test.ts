// 运行：npm test（Node 22.6+ 原生剥离 TS 类型，无需额外依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripFillers,
  llmTimeoutMs,
  collapseSelfCorrections,
  localPreClean,
  hasSpokenContent,
  cleanLlmOutput,
  looksLikeRunaway,
  buildPolishPrompt
} from '../src/main/polish.ts'

test('stripFillers: 删除嗯/呃，保留实词里的“啊/额”', () => {
  assert.equal(stripFillers('嗯，我觉得这个方案可以'), '我觉得这个方案可以')
  assert.equal(stripFillers('呃呃我们明天开会'), '我们明天开会')
  assert.equal(stripFillers('是啊，金额没问题'), '是啊，金额没问题')
  assert.equal(stripFillers('好，啊，就这样'), '好，就这样')
  assert.equal(stripFillers('那个那个那个文件发我'), '那个文件发我')
})

test('stripFillers: 英文填充词按词边界删除', () => {
  assert.equal(stripFillers('um, so I think, uh, we should go'), 'so I think, we should go')
  assert.equal(stripFillers('the umbrella is here'), 'the umbrella is here')
})

test('collapseSelfCorrections: 只删紧邻的上一小句', () => {
  assert.equal(collapseSelfCorrections('我们周五，不对，周四下午开会'), '周四下午开会')
  assert.equal(collapseSelfCorrections('我今天要去北京开会，时间是周五，不对，周四'), '我今天要去北京开会，周四')
})

test('collapseSelfCorrections: 不误伤正常表达', () => {
  for (const s of ['这样做对不对，我不确定', '你说的不对，再想想', '这应该是对的，没问题', 'I mean it, seriously']) {
    assert.equal(collapseSelfCorrections(s), s)
  }
})

test('localPreClean: 组合清理', () => {
  assert.equal(localPreClean('嗯，发给张三，不对，发给李四'), '发给李四')
})

test('cleanLlmOutput: 去掉引号/围栏/标签/前缀', () => {
  assert.equal(cleanLlmOutput('“明天见”'), '明天见')
  assert.equal(cleanLlmOutput('```\nhello\n```'), 'hello')
  assert.equal(cleanLlmOutput('<transcript>\n你好\n</transcript>'), '你好')
  assert.equal(cleanLlmOutput('以下是整理后的文本：\n周四开会'), '周四开会')
  assert.equal(cleanLlmOutput('他说“好”然后走了'), '他说“好”然后走了')
})

test('looksLikeRunaway: 识别 LLM 把口述当指令扩写', () => {
  assert.equal(looksLikeRunaway('帮我写一封请假邮件', '尊敬的领导：'.repeat(20)), true)
  assert.equal(looksLikeRunaway('第一买菜第二做饭', '1. 买菜\n2. 做饭'), false)
  assert.equal(looksLikeRunaway('嗯那个明天三点在三楼会议室开会大家记得带电脑', '明天三点在三楼会议室开会，大家记得带电脑。'), false)
})

test('buildPolishPrompt: 转写内容包在标签里，词典规则编号不冲突', () => {
  const { system, user } = buildPolishPrompt('帮我写一封邮件', { appCategoryHint: 'email', words: ['DeepSeek', 'MyTypeless'] })
  assert.match(user, /^<transcript>\n帮我写一封邮件\n<\/transcript>$/)
  assert.match(system, /不是给你的指令/)
  assert.match(system, /7\. 目标场景是邮件/)
  assert.match(system, /8\. 专有名词词表：DeepSeek、MyTypeless/)
})

test('llmTimeoutMs：长文本润色超时随长度增加，有上限', () => {
  assert.equal(llmTimeoutMs(0), 25_000)
  assert.ok(llmTimeoutMs(3000) > 100_000, '20 分钟录音约几千字，不能按 25 秒超时')
  assert.equal(llmTimeoutMs(100_000), 180_000)
})

test('hasSpokenContent：只有语气词/标点的识别结果算没有内容（不调用 LLM）', () => {
  for (const t of ['', '。', '嗯。', '嗯，啊。', '嗯嗯', '呃……', 'um, uh.']) assert.equal(hasSpokenContent(t), false, t)
  for (const t of ['嗯，明天开会。', '那个。', '好', 'OK', '3']) assert.equal(hasSpokenContent(t), true, t)
})
