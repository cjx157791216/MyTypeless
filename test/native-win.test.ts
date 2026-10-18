import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Windows 原生助手（GAP-008）独有的协议测试：只在 Windows 且已 npm run native:win 时运行；两个平台共同的部分见 native-helpers.test.ts
const bin = (name: string) => join(import.meta.dirname, '..', 'native', 'bin', `${name}.exe`)
const skip = process.platform !== 'win32' || !existsSync(bin('mt-inject')) ? '需要 Windows 与 npm run native:win' : false

function run(name: string, args: string[], input = '') {
  const r = spawnSync(bin(name), args, { input: Buffer.from(input, 'utf-8'), timeout: 5000 })
  return { code: r.status, out: r.stdout.toString('utf-8') }
}

// mt-hotkey 的状态机用 --replay 测（不安装钩子）：物理按键无法由程序模拟，钩子本身需要真机验收。
// "tick" = 单修饰键按住满 HOLD_MS（150ms）
const HOTKEY_CFG = JSON.stringify({
  matches: [
    { name: 'dictation', key: 'rshift' },
    { name: 'ask', key: 'space', require: ['rshift'] },
    { name: 'translate', key: 'ctrl', require: ['rshift'] }
  ]
})
const replay = (keys: string, cfg = HOTKEY_CFG) =>
  run('mt-hotkey', [cfg, '--replay'], keys)
    .out.trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const j = JSON.parse(l) as { name?: string; phase?: string; swallowed?: string; masked?: string }
      return j.swallowed ? `吞:${j.swallowed}` : j.masked ? `屏蔽菜单:${j.masked}` : `${j.name}:${j.phase}`
    })

test('mt-hotkey：按住右 Shift 满 150ms 才开始说话；自动重复不重复触发；轻按补发 down + up', { skip }, () => {
  assert.deepEqual(replay('rshift down\ntick\nrshift down\nrshift up\n'), ['dictation:down', 'dictation:up'])
  assert.deepEqual(replay('rshift down\nrshift up\n'), ['dictation:down', 'dictation:up'])
})

test('mt-hotkey：右 Shift+字母打大写（150ms 内）什么都不发；之后再按字母才 abort', { skip }, () => {
  assert.deepEqual(replay('rshift down\na down\na up\nrshift up\n'), [])
  assert.deepEqual(replay('rshift down\ntick\na down\na up\nrshift up\n'), ['dictation:down', 'dictation:abort'])
})

test('mt-hotkey：右 Shift+空格 提问、右 Shift+Ctrl 翻译，触发键被吞（Ctrl 成对吞，避免切换键盘布局）', { skip }, () => {
  assert.deepEqual(replay('rshift down\nspace down\nspace down\nspace up\nrshift up\n'), [
    'ask:down', '吞:space down', '吞:space down', 'ask:up', '吞:space up'
  ])
  assert.deepEqual(replay('rshift down\nlctrl down\nlctrl up\nrshift up\n'), ['translate:down', '吞:lctrl down', 'translate:up', '吞:lctrl up'])
  // 已开始说话后再组合：先 abort 听写再切过去
  assert.deepEqual(replay('rshift down\ntick\nspace down\nspace up\nrshift up\n'), [
    'dictation:down', 'dictation:abort', 'ask:down', '吞:space down', 'ask:up', '吞:space up'
  ])
})

test('mt-hotkey：左 Shift、先按着别的修饰键再按右 Shift 都不触发', { skip }, () => {
  assert.deepEqual(replay('lshift down\nlshift up\nspace down\nspace up\n'), [])
  assert.deepEqual(replay('lctrl down\nrshift down\ntick\nrshift up\nlctrl up\n'), [])
})

test('mt-hotkey：右 Alt / 右 Ctrl 作主键；右 Alt 按下时补发菜单屏蔽键', { skip }, () => {
  const ralt = JSON.stringify({ matches: [{ name: 'dictation', key: 'ralt' }] })
  assert.deepEqual(replay('ralt down\ntick\nralt up\n', ralt), ['屏蔽菜单:ralt down', 'dictation:down', 'dictation:up'])
  const rctrl = JSON.stringify({ matches: [{ name: 'dictation', key: 'rctrl' }, { name: 'ask', key: 'space', require: ['rctrl'] }] })
  assert.deepEqual(replay('rctrl down\nc down\nc up\nrctrl up\n', rctrl), [])
  assert.deepEqual(replay('rctrl down\ntick\nrctrl up\n', rctrl), ['dictation:down', 'dictation:up'])
})

test('mt-hotkey：配置错误或只有 fn 时退出码 2', { skip }, () => {
  assert.equal(run('mt-hotkey', ['not json', '--replay']).code, 2)
  assert.equal(run('mt-hotkey', [JSON.stringify({ matches: [{ name: 'dictation', key: 'fn' }] }), '--replay']).code, 2)
})

test('mt-hotkey：配置字符串以反斜杠结尾、或 Unicode 转义不足 4 位时判为配置错误（退出码 2），不越界读取', { skip }, () => {
  const bs = String.fromCharCode(92) // 反斜杠
  assert.equal(run('mt-hotkey', [`{"matches":[{"name":"a${bs}`, '--replay']).code, 2)
  assert.equal(run('mt-hotkey', [`{"matches":[{"name":"a${bs}u12`, '--replay']).code, 2)
  assert.equal(run('mt-hotkey', [`{"matches":[{"name":"a${bs}u12zz","key":"rctrl"}]}`, '--replay']).code, 2)
})

test('mt-hotkey：主进程的 stdin 管道关闭后立即退出（主进程崩溃时不留下全局钩子）', { skip, timeout: 15_000 }, async () => {
  const child = spawn(bin('mt-hotkey'), [JSON.stringify({ matches: [{ name: 'dictation', key: 'rctrl' }] })], { stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  for (let i = 0; i < 50 && !out.includes('"ready"') && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100))
  if (child.exitCode === 4) return // 没有桌面会话、装不上钩子（部分 CI 环境）
  assert.match(out, /"phase":"ready"/)
  const t0 = Date.now()
  child.stdin.end()
  const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000))])
  if (code === 'timeout') child.kill()
  assert.notEqual(code, 'timeout', 'stdin 关闭 3 秒后助手仍在运行')
  assert.ok(Date.now() - t0 < 1000)
})

// mt-whisper（npm run whisper:win）：用 whisper.cpp 自带的测试模型（随机权重，只验证能加载、能起服务）
const testModel = join(import.meta.dirname, '..', '.vendor', 'whisper.cpp', 'models', 'for-tests-ggml-tiny.bin')
const skipWhisper = process.platform !== 'win32' || !existsSync(bin('mt-whisper')) || !existsSync(testModel) ? '需要 Windows 与 npm run whisper:win' : false

test('mt-whisper：加载模型后 /health 就绪（与主进程相同的启动参数）', { skip: skipWhisper, timeout: 90_000 }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(bin('mt-whisper'), ['-m', testModel, '--host', '127.0.0.1', '--port', String(port), '-t', '2', '-l', 'auto'], { stdio: 'ignore' })
  try {
    let ok = false
    for (let i = 0; i < 600 && !ok && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 100))
      ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)
    }
    assert.ok(ok, `引擎没有就绪（退出码 ${child.exitCode}）`)
  } finally {
    child.kill()
  }
})

// mt-audiotap（线上会议截取应用声音，D-033）：只测不依赖播放声音的部分；真实截取见运行记录里的端到端测试
test('mt-audiotap：--apps / --list 输出 JSON 数组', { skip }, () => {
  for (const arg of ['--apps', '--list']) {
    const r = run('mt-audiotap', [arg])
    assert.equal(r.code, 0)
    const list = JSON.parse(r.out) as Array<{ bundleId: string; name: string }>
    assert.ok(Array.isArray(list))
    for (const a of list) assert.match(a.bundleId, /^[^A-Z]+$/) // 小写 exe 文件名
  }
})

test('mt-audiotap：截取不存在的应用——就绪后按真实时间输出 16kHz 静音', { skip, timeout: 20_000 }, async () => {
  const child = spawn(bin('mt-audiotap'), ['--bundle', 'no-such-app.exe'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  const chunks: Buffer[] = []
  child.stderr.on('data', (d: Buffer) => (err += d))
  try {
    for (let i = 0; i < 50 && !err.includes('"ready"') && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100))
    if (child.exitCode === 4) return // 低于 Windows 10 build 20348（CI 机器可能不支持进程回环录音）
    assert.match(err, /"ready":true/)
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    await new Promise((r) => setTimeout(r, 1000))
    const bytes = Buffer.concat(chunks)
    assert.ok(bytes.length > 16000 * 2 * 0.7 && bytes.length < 16000 * 2 * 1.3, `1 秒输出了 ${bytes.length} 字节`)
    assert.ok(bytes.every((b) => b === 0))
  } finally {
    child.kill()
  }
})
