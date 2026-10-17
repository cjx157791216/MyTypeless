import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBinding } from '../src/main/bindings.ts'
import { defaultBindings } from '../src/shared/platform.ts'

test('parseBinding：单修饰键触发没有兜底加速键', () => {
  assert.deepEqual(parseBinding('dictation', 'fn'), { match: { name: 'dictation', key: 'fn', require: [] }, accelerator: null })
  assert.deepEqual(parseBinding('dictation', 'rctrl'), { match: { name: 'dictation', key: 'rctrl', require: [] }, accelerator: null })
})

test('parseBinding：通用修饰键组合有兜底加速键', () => {
  assert.deepEqual(parseBinding('ask', 'opt+space'), { match: { name: 'ask', key: 'space', require: ['opt'] }, accelerator: 'Alt+Space' })
  assert.deepEqual(parseBinding('translate', 'Ctrl + Shift + T'), { match: { name: 'translate', key: 't', require: ['ctrl', 'shift'] }, accelerator: 'Control+Shift+T' })
  assert.equal(parseBinding('x', 'cmd+f5')?.accelerator, 'Command+F5')
})

test('parseBinding：fn 与区分左右的修饰键只交给原生助手', () => {
  assert.deepEqual(parseBinding('ask', 'fn+space'), { match: { name: 'ask', key: 'space', require: ['fn'] }, accelerator: null })
  assert.deepEqual(parseBinding('ask', 'rctrl+space', 'win32'), { match: { name: 'ask', key: 'space', require: ['rctrl'] }, accelerator: null })
  assert.deepEqual(parseBinding('translate', 'RightControl+shift', 'win32'), { match: { name: 'translate', key: 'shift', require: ['rctrl'] }, accelerator: null })
  assert.deepEqual(parseBinding('x', 'ralt+k', 'win32')?.match.require, ['ropt'])
})

test('parseBinding：macOS 的原生助手不支持区分左右的修饰键当组合修饰，判为无效（否则变成单按空格、抢走全系统的空格）', () => {
  for (const combo of ['rctrl+space', 'ralt+k', 'lshift+a', 'RightControl+shift', 'rcmd+opt+x']) assert.equal(parseBinding('x', combo, 'darwin'), null, combo)
  // 单独按右侧修饰键触发、通用修饰键组合在 macOS 上照旧可用
  assert.deepEqual(parseBinding('dictation', 'ropt', 'darwin'), { match: { name: 'dictation', key: 'ropt', require: [] }, accelerator: null })
  assert.deepEqual(parseBinding('translate', 'fn+shift', 'darwin')?.match, { name: 'translate', key: 'shift', require: ['fn'] })
  assert.equal(parseBinding('ask', 'opt+space', 'darwin')?.accelerator, 'Alt+Space')
})

test('parseBinding：空串与未知修饰键返回 null', () => {
  assert.equal(parseBinding('x', ''), null)
  assert.equal(parseBinding('x', 'hyper+k'), null)
})

test('默认快捷键：macOS 用 Fn，Windows 用右 Ctrl，且都能被解析；右 Shift 的翻译组合也能解析', () => {
  assert.deepEqual(defaultBindings('darwin'), { hotkeyKey: 'fn', bindings: { dictation: 'fn', translate: 'fn+shift', rewrite: '', ask: 'fn+space' } })
  const win = defaultBindings('win32')
  assert.deepEqual(win, { hotkeyKey: 'rctrl', bindings: { dictation: 'rctrl', translate: 'rctrl+shift', rewrite: '', ask: 'rctrl+space' } })
  assert.deepEqual(parseBinding('translate', 'rshift+ctrl', 'win32')?.match, { name: 'translate', key: 'ctrl', require: ['rshift'] })
  for (const combo of [win.bindings.dictation, win.bindings.translate, win.bindings.ask]) assert.ok(parseBinding('m', combo, 'win32'))
  const mac = defaultBindings('darwin')
  for (const combo of [mac.bindings.dictation, mac.bindings.translate, mac.bindings.ask]) assert.ok(parseBinding('m', combo, 'darwin'))
})
