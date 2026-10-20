import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// macOS 版 mt-hotkey 的状态机用 --replay 测（不建 tap、不需要辅助功能权限）：按行读 "<键名> down|up"，
// 造出与真实键盘相同的 flagsChanged / keyDown / keyUp 事件交给同一个处理函数。物理按键需要真机验收。
const bin = join(import.meta.dirname, '..', 'native', 'bin', 'mt-hotkey')
const skip = process.platform !== 'darwin' ? '只在 macOS 上测' : !existsSync(bin) ? '需要先编译 mt-hotkey（npm run native）' : false

const FN_CFG = JSON.stringify({
  matches: [
    { name: 'dictation', key: 'fn' },
    { name: 'translate', key: 'shift', require: ['fn'] },
    { name: 'ask', key: 'space', require: ['fn'] }
  ]
})
const replay = (keys: string, cfg = FN_CFG) => {
  const r = spawnSync(bin, [cfg, '--replay'], { input: keys, timeout: 5000 })
  assert.equal(r.status, 0, r.stderr.toString())
  return r.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const j = JSON.parse(l) as { name?: string; phase?: string; swallowed?: string }
      return j.swallowed ? `吞:${j.swallowed}` : `${j.name}:${j.phase}`
    })
}

test('mt-hotkey（macOS）：按住 Fn 说话，松开结束（🌐 键报为 63 号键）', { skip }, () => {
  assert.deepEqual(replay('fn down\nfn up\n'), ['dictation:down', 'dictation:up'])
})

test('mt-hotkey（macOS）：🌐 键同时报 63 和 179 号键时只算一次，179 不会把这次按键当成组合误触而作废', { skip }, () => {
  // 63 在前：原来 179 的 keyDown 会被当成“按住 Fn 时按了别的键”→ abort，录音立刻作废
  assert.deepEqual(replay('fn down\nglobe down\nglobe up\nfn up\n'), ['dictation:down', 'dictation:up'])
  // 179 在前
  assert.deepEqual(replay('globe down\nfn down\nglobe up\nfn up\n'), ['dictation:down', 'dictation:up'])
  // 179 在松开之后才到：不能再触发一次
  assert.deepEqual(replay('fn down\nfn up\nglobe down\nglobe up\nfn down\nfn up\n'), ['dictation:down', 'dictation:up', 'dictation:down', 'dictation:up'])
})

test('mt-hotkey（macOS）：只收得到 179 号键的 Mac 也能触发（按下开始、松开结束），179 不被吞', { skip }, () => {
  assert.deepEqual(replay('globe down\nglobe up\nglobe down\nglobe up\n'), ['dictation:down', 'dictation:up', 'dictation:down', 'dictation:up'])
})

test('mt-hotkey（macOS）：Fn+空格、Fn+Shift 照常切到对应组合；Fn+方向键视为普通组合键使用', { skip }, () => {
  assert.deepEqual(replay('fn down\nspace down\nspace up\nfn up\n'), ['dictation:down', 'dictation:abort', 'ask:down', '吞:space down', 'ask:up', '吞:space up'])
  assert.deepEqual(replay('fn down\nshift down\nshift up\nfn up\n'), ['dictation:down', 'dictation:abort', 'translate:down', 'translate:up'])
  assert.deepEqual(replay('fn down\nleft down\nleft up\nfn up\n'), ['dictation:down', 'dictation:abort'])
})

test('mt-hotkey（macOS）：主键不是 Fn 时 🌐（179）不触发任何绑定', { skip }, () => {
  const cfg = JSON.stringify({ matches: [{ name: 'dictation', key: 'ropt' }] })
  assert.deepEqual(replay('globe down\nglobe up\nropt down\nropt up\n', cfg), ['dictation:down', 'dictation:up'])
})
