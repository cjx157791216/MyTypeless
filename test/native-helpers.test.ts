import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 原生助手的共同协议（docs/contracts/native-helpers.md）：macOS（npm run native）与 Windows（npm run native:win）跑同一组用例，
// 保证两边参数、输出与退出码一致。只测不发按键、不读输入框的路径；Windows 独有的部分见 native-win.test.ts
const isWin = process.platform === 'win32'
const bin = (name: string) => join(import.meta.dirname, '..', 'native', 'bin', isWin ? `${name}.exe` : name)
const skipUnless = (...names: string[]) =>
  !isWin && process.platform !== 'darwin'
    ? '只有 macOS 与 Windows 有原生助手'
    : names.some((n) => !existsSync(bin(n)))
      ? `需要先编译 ${names.join('、')}（${isWin ? 'npm run native:win' : 'npm run native'}）`
      : false

function run(name: string, args: string[], input = '') {
  const r = spawnSync(bin(name), args, { input: Buffer.from(input, 'utf-8'), timeout: 5000 })
  return { code: r.status, out: r.stdout.toString('utf-8') }
}

test('mt-text：繁简互转，UTF-8 进出，换行原样保留', { skip: skipUnless('mt-text') }, () => {
  assert.deepEqual(run('mt-text', ['--to', 'hans'], '會議記錄\n第二行'), { code: 0, out: '会议记录\n第二行' })
  assert.deepEqual(run('mt-text', ['--to', 'hant'], '会议记录'), { code: 0, out: '會議記錄' })
  assert.deepEqual(run('mt-text', ['--to', 'hans'], 'Hello 123'), { code: 0, out: 'Hello 123' })
})

test('mt-text：参数错误退出码 2，空输入输出为空', { skip: skipUnless('mt-text') }, () => {
  assert.equal(run('mt-text', ['--to', 'xx']).code, 2)
  assert.equal(run('mt-text', []).code, 2)
  assert.deepEqual(run('mt-text', ['--to', 'hans'], ''), { code: 0, out: '' })
})

test('mt-focus：输出前台应用 JSON（没有前台应用时为 {}）', { skip: skipUnless('mt-focus') }, () => {
  const r = run('mt-focus', [])
  assert.equal(r.code, 0)
  const info = JSON.parse(r.out) as { bundleId?: string; name?: string; pid?: number }
  if (info.pid !== undefined) {
    assert.ok(info.pid > 0)
    if (isWin) assert.match(info.bundleId ?? '', /^[^A-Z]+$/) // Windows 为小写 exe 文件名
  }
})

// 参数先校验再检查权限：没有辅助功能授权的机器（CI）上同样是退出码 2
test('mt-focus：激活不存在的进程、未知参数、光标上下文的长度不合法时退出码 2', { skip: skipUnless('mt-focus') }, () => {
  for (const args of [
    ['--activate', '4294967'],
    ['--activate', 'abc'],
    ['--activate'],
    ['--bogus'],
    ['--selected-text', 'extra'],
    ['--caret-context', '-1', '5'],
    ['--caret-context', '0', '0'],
    ['--caret-context', 'x', '5'],
    ['--caret-context', '5']
  ]) {
    assert.equal(run('mt-focus', args).code, 2, args.join(' '))
  }
})

test('mt-inject：参数错误、非法 base64、不支持的组合键退出码 2（不发送任何按键）', { skip: skipUnless('mt-inject') }, () => {
  for (const args of [[], ['@@@'], ['--paste'], ['--combo'], ['--combo', 'ctrl+f13'], ['--combo', 'hyper+c']]) {
    assert.equal(run('mt-inject', args).code, 2, args.join(' '))
  }
})

test('mt-audiotap：未知参数退出码 2', { skip: skipUnless('mt-audiotap') }, () => {
  assert.equal(run('mt-audiotap', ['--bogus']).code, 2)
})

// mt-diarize（npm run diarize / diarize:win）：不带模型只测参数与模型加载失败；降噪 / 识别需要下载模型，见运行记录
test('mt-diarize：没有任何模型参数退出码 2；模型文件不存在退出码 4', { skip: skipUnless('mt-diarize') }, () => {
  assert.equal(run('mt-diarize', []).code, 2)
  assert.equal(run('mt-diarize', ['--denoiser', join(import.meta.dirname, '不存在 的模型.onnx')]).code, 4)
})
