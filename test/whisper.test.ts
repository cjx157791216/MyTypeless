// 内置引擎：模型目录纯函数、分段合并、模型下载（断点续传 / 换源 / 校验 / 取消）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MODELS, findModel, fileUrls, modelUrls, recommendedModelId, resolveLanguage, resolveScript, hasHan } from '../src/main/whisper/catalog.ts'
import { fixAsrCase } from '../src/main/text.ts'
import { downloadFile, DownloadError } from '../src/main/whisper/download.ts'
import { joinSegments } from '../src/main/providers/asr.ts'

test('catalog: 中文/英文推荐 FireRedASR2、其他语言推荐 Whisper；下载地址先官方后镜像；每个文件都有校验值', () => {
  assert.equal(recommendedModelId('zh'), 'firered2-aed-int8')
  assert.equal(recommendedModelId('en'), 'firered2-aed-int8')
  assert.equal(recommendedModelId('auto'), 'firered2-aed-int8')
  assert.equal(recommendedModelId('ja'), 'large-v3-turbo-q5_0')
  const turbo = findModel('large-v3-turbo-q5_0')!
  const urls = modelUrls(turbo)
  assert.match(urls[0], /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-large-v3-turbo-q5_0\.bin$/)
  assert.match(urls[1], /^https:\/\/hf-mirror\.com\//)
  const fr = findModel('firered2-aed-int8')!
  assert.equal(fr.engine, 'firered')
  assert.deepEqual(fr.files!.map((f) => f.name).sort(), ['decoder.int8.onnx', 'encoder.int8.onnx', 'punct.int8.onnx', 'tokens.txt'])
  assert.equal(fr.sizeBytes, fr.files!.reduce((n, f) => n + f.sizeBytes, 0))
  assert.match(fileUrls(fr.files![0])[0], /^https:\/\/huggingface\.co\/csukuangfj2\//)
  for (const m of MODELS) {
    if (m.files) for (const f of m.files) assert.match(f.sha256, /^[0-9a-f]{64}$/)
    else assert.match(m.sha256, /^[0-9a-f]{64}$/)
  }
})

test('fixAsrCase: 全大写英文改小写；词典词按词典写法（含多词）；常见缩写、I、带数字的保持；纯英文句首大写', () => {
  assert.equal(fixAsrCase('对，就是那些BASKETBALL或者SOCCER。', []), '对，就是那些basketball或者soccer。')
  assert.equal(fixAsrCase('我们用DEEPSEEK和CLAUDE CODE做API测试，I THINK OK。', ['DeepSeek', 'Claude Code']), '我们用DeepSeek和Claude Code做API测试，I think OK。')
  assert.equal(fixAsrCase('THIS IS A GOOD IDEA', []), 'This is a good idea')
  assert.equal(fixAsrCase('用GPT4O写PPT', []), '用GPT4O写PPT')
  assert.equal(fixAsrCase('已经是 iPhone 和 GitHub', []), '已经是 iPhone 和 GitHub')
})

test('resolveLanguage: 跟随系统时中文系统用 zh，其他自动检测；显式设置原样返回', () => {
  assert.equal(resolveLanguage('system', ['zh-Hans-CN', 'en-US']), 'zh')
  assert.equal(resolveLanguage('system', ['zh-TW']), 'zh')
  assert.equal(resolveLanguage('system', ['en-US', 'zh-Hans']), 'auto')
  assert.equal(resolveLanguage(undefined, []), 'auto')
  assert.equal(resolveLanguage('en', ['zh-Hans']), 'en')
  assert.equal(resolveLanguage('auto', ['zh-Hans']), 'auto')
})

test('resolveScript: 跟随系统时繁体地区输出繁体，其余简体', () => {
  assert.equal(resolveScript('system', ['zh-Hans-CN']), 'hans')
  assert.equal(resolveScript('system', ['zh-Hant-TW']), 'hant')
  assert.equal(resolveScript('system', ['zh-HK']), 'hant')
  assert.equal(resolveScript('system', ['en-US']), 'hans')
  assert.equal(resolveScript('off', ['zh-Hant']), 'off')
  assert.equal(hasHan('DeepSeek 测试'), true)
  assert.equal(hasHan('hello'), false)
})

test('joinSegments: 中文段直接相连，英文段补空格', () => {
  assert.equal(joinSegments('嗯,那个,我们三点开会,\n大家记得带上电脑。\n'), '嗯,那个,我们三点开会,大家记得带上电脑。')
  assert.equal(joinSegments('Let us move the review\nto Thursday.\n'), 'Let us move the review to Thursday.')
  assert.equal(joinSegments('  \n'), '')
})

// —— 下载 ——

const payload = Buffer.alloc(300_000, 0)
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 251
const sha = createHash('sha256').update(payload).digest('hex')

/** Range 服务器；cutAt>0 时第一次响应只发这么多字节就断开 */
function serve(opts: { cutAt?: number; ignoreRange?: boolean; status?: number } = {}): Promise<{ url: string; server: Server; ranges: string[] }> {
  const ranges: string[] = []
  let cut = opts.cutAt ?? 0
  const server = createServer((req, res) => {
    if (opts.status) {
      res.writeHead(opts.status).end()
      return
    }
    const range = req.headers.range
    ranges.push(range ?? '')
    let start = 0
    if (range && !opts.ignoreRange) start = Number(/bytes=(\d+)-/.exec(range)![1])
    const body = payload.subarray(start)
    res.writeHead(start > 0 ? 206 : 200, { 'Content-Length': body.length })
    if (cut > 0) {
      res.write(body.subarray(0, cut))
      cut = 0
      setTimeout(() => res.destroy(), 50) // 数据送达后再断开，模拟真实网络中断
      return
    }
    res.end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number }
    resolve({ url: `http://127.0.0.1:${addr.port}/m.bin`, server, ranges })
  }))
}

const dest = () => join(mkdtempSync(join(tmpdir(), 'mt-dl-')), 'models', 'm.bin')

test('download: 正常下载并校验后改名', async () => {
  const { url, server } = await serve()
  const file = dest()
  let sawProgress = false
  await downloadFile({ urls: [url], dest: file, sizeBytes: payload.length, sha256: sha, onProgress: () => (sawProgress = true) })
  server.close()
  assert.deepEqual(readFileSync(file), payload)
  assert.equal(existsSync(`${file}.part`), false)
  assert.ok(sawProgress)
})

test('download: 连接中途断开后用 Range 从断点续传', async () => {
  const { url, server, ranges } = await serve({ cutAt: 100_000 })
  const file = dest()
  await downloadFile({ urls: [url], dest: file, sizeBytes: payload.length, sha256: sha })
  server.close()
  assert.deepEqual(readFileSync(file), payload)
  assert.equal(ranges[0], '')
  assert.match(ranges[1], /^bytes=\d+-$/)
})

test('download: 第一个源不可用时换下一个源', async () => {
  const bad = await serve({ status: 503 })
  const good = await serve()
  const file = dest()
  await downloadFile({ urls: [bad.url, good.url], dest: file, sizeBytes: payload.length, sha256: sha })
  bad.server.close()
  good.server.close()
  assert.deepEqual(readFileSync(file), payload)
})

test('download: 服务器忽略 Range 时从头重下，结果仍正确', async () => {
  const { url, server } = await serve({ ignoreRange: true })
  const file = dest()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.part`, payload.subarray(0, 1000))
  await downloadFile({ urls: [url], dest: file, sizeBytes: payload.length, sha256: sha })
  server.close()
  assert.deepEqual(readFileSync(file), payload)
})

test('download: 校验失败时删除临时文件并报 CHECKSUM', async () => {
  const { url, server } = await serve()
  const file = dest()
  await assert.rejects(
    downloadFile({ urls: [url], dest: file, sizeBytes: payload.length, sha256: '0'.repeat(64) }),
    (err: unknown) => err instanceof DownloadError && err.code === 'CHECKSUM'
  )
  server.close()
  assert.equal(existsSync(file), false)
  assert.equal(existsSync(`${file}.part`), false)
})

test('download: 取消时报 ABORTED 并保留已下载部分', async () => {
  const { url, server } = await serve({ cutAt: 50_000 })
  const file = dest()
  const ctrl = new AbortController()
  await assert.rejects(
    downloadFile({
      urls: [url],
      dest: file,
      sizeBytes: payload.length,
      sha256: sha,
      signal: ctrl.signal,
      onProgress: () => ctrl.abort()
    }),
    (err: unknown) => err instanceof DownloadError && err.code === 'ABORTED'
  )
  server.close()
  assert.equal(existsSync(file), false)
  assert.ok(statSync(`${file}.part`).size > 0)
})

test('download: 所有源都失败时报 NETWORK', async () => {
  const bad = await serve({ status: 404 })
  await assert.rejects(
    downloadFile({ urls: [bad.url], dest: dest(), sizeBytes: payload.length, sha256: sha }),
    (err: unknown) => err instanceof DownloadError && err.code === 'NETWORK'
  )
  bad.server.close()
})

// —— 文本规整 ——
import { normalizeChinesePunctuation, joinText, isHallucination, stripAsrTokens } from '../src/main/text.ts'

test('normalizeChinesePunctuation: 中文语境下英文标点转中文标点，不误伤数字/网址/英文', () => {
  assert.equal(
    normalizeChinesePunctuation('嗯,那个,我们明天下午三点开会,大家记得带上电脑.'),
    '嗯，那个，我们明天下午三点开会，大家记得带上电脑。'
  )
  assert.equal(normalizeChinesePunctuation('你吃饭了吗?好的!'), '你吃饭了吗？好的！')
  assert.equal(normalizeChinesePunctuation('版本 v1.2 价格 3.5 元,网址 example.com'), '版本 v1.2 价格 3.5 元，网址 example.com')
  assert.equal(normalizeChinesePunctuation('Hello, world. How are you?'), 'Hello, world. How are you?')
  assert.equal(normalizeChinesePunctuation('用 DeepSeek 测试,效果不错'), '用 DeepSeek 测试，效果不错')
})

test('joinText：中文直接相连，英文补空格', () => {
  assert.equal(joinText('明天开会。', '记得带电脑'), '明天开会。记得带电脑')
  assert.equal(joinText('Hello world.', 'How are you'), 'Hello world. How are you')
  assert.equal(joinText('用 DeepSeek', '测试'), '用 DeepSeek测试')
  assert.equal(joinText('', 'abc'), 'abc')
})

test('isHallucination：静音/噪声上的典型幻觉整段丢弃，正常内容保留', () => {
  assert.equal(isHallucination('谢谢观看。'), true)
  assert.equal(isHallucination('字幕志愿者 杨栋梁姑娘请无家内有居住'), true)
  assert.equal(isHallucination('中文字幕制作 某某'), true)
  assert.equal(isHallucination('[BLANK_AUDIO]'), true)
  assert.equal(isHallucination('谢谢你帮我改字幕'), false)
  assert.equal(isHallucination('明天下午三点开会'), false)
})

test('stripAsrTokens：去掉 FireRedASR2 的特殊标记（<sil> 等，标点模型会拆成 < sil >）；只剩标点时为空', () => {
  assert.equal(stripAsrTokens('< sil >。'), '')
  assert.equal(stripAsrTokens('<sil>'), '')
  assert.equal(stripAsrTokens('<unk>，<sil>。'), '')
  assert.equal(stripAsrTokens('你好< sil >世界。'), '你好世界。')
  assert.equal(stripAsrTokens('< sil >，明天开会。'), '明天开会。')
  assert.equal(stripAsrTokens('HELLO <sil> WORLD'), 'HELLO WORLD')
  assert.equal(stripAsrTokens('明天下午三点开会。'), '明天下午三点开会。')
  assert.equal(stripAsrTokens('3 < 5 > 2'), '3 < 5 > 2')
})
