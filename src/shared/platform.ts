// 按平台显示的快捷键名与系统设置路径（主进程与渲染端共用；不依赖 electron，可直接单测）

/** macOS 键名：与改版前首页的显示保持一致 */
const MAC_KEYS: Record<string, string> = {
  fn: 'fn',
  space: '空格',
  shift: '⇧',
  opt: '⌥',
  option: '⌥',
  alt: '⌥',
  ropt: '右⌥',
  cmd: '⌘',
  command: '⌘',
  ctrl: '⌃',
  control: '⌃',
  esc: 'esc'
}

/** Windows 键名：opt 对应 Alt，cmd 对应 Win 键 */
const WIN_KEYS: Record<string, string> = {
  fn: 'Fn',
  space: '空格',
  shift: 'Shift',
  rshift: '右Shift',
  lshift: '左Shift',
  opt: 'Alt',
  option: 'Alt',
  alt: 'Alt',
  ropt: '右Alt',
  ralt: '右Alt',
  lopt: '左Alt',
  lalt: '左Alt',
  cmd: 'Win',
  command: 'Win',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  rctrl: '右Ctrl',
  lctrl: '左Ctrl',
  esc: 'Esc'
}

export function isMacPlatform(platform: string): boolean {
  return platform === 'darwin'
}

/** "fn+space" → ['fn', '空格']；未知键转大写 */
export function comboKeys(combo: string, platform: string): string[] {
  const names = isMacPlatform(platform) ? MAC_KEYS : WIN_KEYS
  return combo
    .split('+')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => names[k] ?? k.toUpperCase())
}

/** 粘贴快捷键的写法（写入失败提示用） */
export function pasteShortcut(platform: string): string {
  return isMacPlatform(platform) ? '⌘V' : 'Ctrl+V'
}

/** 没有麦克风权限时，告诉用户去哪里打开 */
export function micPermissionHint(platform: string): string {
  return isMacPlatform(platform)
    ? '没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风 → 允许 MyTypeless'
    : '没有麦克风权限：设置 → 隐私和安全性 → 麦克风 → 打开「允许桌面应用访问麦克风」'
}

export interface DefaultBindings {
  hotkeyKey: string
  bindings: { dictation: string; translate: string; rewrite: string; ask: string }
}

/**
 * 默认快捷键：macOS 按住 Fn（D-010）。Windows 键盘的 Fn 系统读不到，改用右 Ctrl（D-035）；
 * 没有右 Ctrl 的键盘可在设置里改为 rshift（翻译 rshift+ctrl）、ralt 等。
 * 改写不需要单独的键：选中文字后按主键即改写（rewrite 留空 = 不注册单独快捷键）。
 */
export function defaultBindings(platform: string): DefaultBindings {
  if (isMacPlatform(platform)) return { hotkeyKey: 'fn', bindings: { dictation: 'fn', translate: 'fn+shift', rewrite: '', ask: 'fn+space' } }
  return { hotkeyKey: 'rctrl', bindings: { dictation: 'rctrl', translate: 'rctrl+shift', rewrite: '', ask: 'rctrl+space' } }
}
