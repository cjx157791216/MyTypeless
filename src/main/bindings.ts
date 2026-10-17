import type { HotkeyMatchConfig } from './native'

/**
 * 快捷键绑定解析（纯逻辑，不依赖 electron，便于测试）：
 * "fn+space" → 原生助手的匹配规则 { key: 'space', require: ['fn'] } + globalShortcut 兜底用的加速键。
 * 修饰键除了通用的 opt / cmd / ctrl / shift / fn，还可以写区分左右的 rctrl、ropt 等（Windows 默认主键右 Ctrl，D-035）；
 * macOS 上区分左右的修饰键只能单独按下触发，不能当组合修饰。
 */

const MOD_MAP: Record<string, string> = {
  opt: 'opt', option: 'opt', alt: 'opt',
  cmd: 'cmd', command: 'cmd',
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
  fn: 'fn',
  // 区分左右：该侧必须按着（原生助手同时按对应的通用修饰键做精确匹配）
  rctrl: 'rctrl', rightcontrol: 'rctrl', lctrl: 'lctrl', leftcontrol: 'lctrl',
  ropt: 'ropt', rightoption: 'ropt', ralt: 'ropt', lopt: 'lopt', leftoption: 'lopt', lalt: 'lopt',
  rshift: 'rshift', rightshift: 'rshift', lshift: 'lshift', leftshift: 'lshift',
  rcmd: 'rcmd', rightcmd: 'rcmd', lcmd: 'lcmd', leftcmd: 'lcmd'
}

/** 区分左右的修饰键：macOS 的 mt-hotkey 不支持把它们当组合修饰（只支持单独按下触发） */
const SIDED_MODS = new Set(['rctrl', 'lctrl', 'ropt', 'lopt', 'rshift', 'lshift', 'rcmd', 'lcmd'])

/** globalShortcut 只能表达通用修饰键 */
const ACCEL_MOD: Record<string, string> = {
  opt: 'Alt', cmd: 'Command', ctrl: 'Control', shift: 'Shift'
}

const ACCEL_KEY: Record<string, string> = {
  space: 'Space', return: 'Return', enter: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape',
  delete: 'Backspace', backspace: 'Backspace', forwarddelete: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown'
}

/** 单修饰键触发（只有原生助手支持） */
const MODIFIER_ONLY_KEYS = new Set([
  'fn', 'ropt', 'rightoption', 'lopt', 'leftoption', 'rcmd', 'rightcmd', 'lcmd', 'leftcmd',
  'rshift', 'rightshift', 'lshift', 'leftshift', 'rctrl', 'rightcontrol', 'lctrl', 'leftcontrol', 'ralt', 'lalt'
])

export interface ParsedBinding {
  match: HotkeyMatchConfig
  /** globalShortcut 加速键；单修饰键触发、或用到 fn / 区分左右的修饰键时为 null */
  accelerator: string | null
}

export function parseBinding(mode: string, combo: string, platform: string = process.platform): ParsedBinding | null {
  const parts = combo.split('+').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!parts.length) return null
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((m) => MOD_MAP[m])
  if (mods.some((m) => !m)) return null
  // macOS 上 rctrl+space 会被助手忽略修饰键、变成单按空格（抢走全系统的空格）：判为无效
  if (platform === 'darwin' && mods.some((m) => SIDED_MODS.has(m))) return null
  const require = [...new Set(mods)]

  let accelerator: string | null = null
  if (!MODIFIER_ONLY_KEYS.has(key) && require.every((m) => ACCEL_MOD[m])) {
    const accelKey = ACCEL_KEY[key] ?? (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : null)
    if (accelKey) accelerator = require.map((m) => ACCEL_MOD[m]).concat(accelKey).join('+')
  }
  return { match: { name: mode, key, require }, accelerator }
}
