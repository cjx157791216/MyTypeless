import { spawn, execFile, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'

/**
 * 原生助手管理（原创 CLI，macOS 为 Swift、Windows 为 C++，编译到 native/bin/）
 * - mt-hotkey: 全局快捷键（按住说话/触发切换），事件走 stdout JSON 行
 * - mt-inject: 文本写入（键入 / --paste 粘贴 / --combo 组合键 / --copy-selection 抓选区）
 * - mt-focus:  前台应用探测、激活、读选中文字与光标上下文
 * - mt-text:   繁简转换
 * 打包后位于 resources/bin/（electron-builder extraResources）。Windows 版助手同名、带 .exe，协议相同（docs/contracts/native-helpers.md）。
 */

export interface HotkeyEvent {
  name: string
  phase: 'down' | 'up' | 'ready' | 'abort'
}

export interface HotkeyMatchConfig {
  name: string
  key: string
  require?: string[]
}

export function helperPath(name: string): string | null {
  if (process.platform === 'win32') name += '.exe'
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'bin', name)]
    : [join(app.getAppPath(), 'native', 'bin', name)]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

// ---------- mt-focus ----------

export interface FrontAppInfo {
  bundleId?: string
  name?: string
  pid?: number
}

export async function getFrontApp(): Promise<FrontAppInfo> {
  const bin = helperPath('mt-focus')
  if (!bin) return {}
  return new Promise((resolve) => {
    execFile(bin, { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve({})
      try {
        resolve(JSON.parse(stdout) as FrontAppInfo)
      } catch {
        resolve({})
      }
    })
  })
}

/** 把指定进程的应用切回前台（浮卡抢了焦点后，注入前归还给原应用） */
export async function activateApp(pid: number): Promise<boolean> {
  const bin = helperPath('mt-focus')
  if (!bin) return false
  return new Promise((resolve) => {
    execFile(bin, ['--activate', String(pid)], { timeout: 2000 }, (err) => resolve(!err))
  })
}

/** 焦点输入框中选中的文字（辅助功能 API，不碰剪贴板）；没有选中或应用不支持时为 null */
export async function getSelectedTextAX(): Promise<string | null> {
  const bin = helperPath('mt-focus')
  if (!bin) return null
  return new Promise((resolve) => {
    execFile(bin, ['--selected-text'], { timeout: 1000 }, (err, stdout) => {
      if (err) return resolve(null)
      const text = Buffer.from(stdout.trim(), 'base64').toString('utf-8')
      resolve(text || null)
    })
  })
}

export interface CaretContext {
  text: string
  caret: number
  pid: number
}

/** 光标前后各若干字符（自动词典追踪修改用，D-012）；读不到时为 null */
export async function getCaretContext(before: number, after: number): Promise<CaretContext | null> {
  const bin = helperPath('mt-focus')
  if (!bin) return null
  return new Promise((resolve) => {
    execFile(bin, ['--caret-context', String(before), String(after)], { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve(JSON.parse(stdout) as CaretContext)
      } catch {
        resolve(null)
      }
    })
  })
}

// ---------- mt-text ----------

/** 繁简转换（系统 ICU）；助手缺失或失败时原样返回 */
export function convertChineseScript(text: string, to: 'hans' | 'hant'): Promise<string> {
  const bin = helperPath('mt-text')
  if (!bin) return Promise.resolve(text)
  return new Promise((resolve) => {
    const child = spawn(bin, ['--to', to], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => child.kill(), 2000)
    child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf-8')))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 && out ? out : text)
    })
    child.on('error', () => resolve(text))
    child.stdin!.end(text, 'utf-8')
  })
}

// ---------- mt-inject ----------

export type InjectMode = 'type' | 'paste'

export async function injectWithHelper(
  text: string,
  mode: InjectMode = 'type'
): Promise<{ ok: boolean; error?: string; code?: number }> {
  const bin = helperPath('mt-inject')
  if (!bin) return { ok: false, error: 'helper-missing' }
  const b64 = Buffer.from(text, 'utf-8').toString('base64')
  const args = mode === 'paste' ? ['--paste', b64] : [b64]
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true })
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code
      const msg = stderr?.trim() || err.message
      resolve({ ok: false, error: msg, code: typeof code === 'number' ? code : undefined })
    })
  })
}

// ---------- mt-hotkey ----------

export class HotkeyWatcher {
  private child: ChildProcess | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private stopped = false
  private restartCount = 0

  constructor(
    private matches: HotkeyMatchConfig[],
    private readonly onEvent: (ev: HotkeyEvent) => void,
    private readonly onFailure: (reason: string) => void
  ) {}

  start(): void {
    this.stopped = false
    this.spawn()
  }

  private spawn(): void {
    const bin = helperPath('mt-hotkey')
    if (!bin) {
      this.onFailure('helper-missing')
      return
    }
    let child: ChildProcess
    try {
      child = spawn(bin, [JSON.stringify({ matches: this.matches })], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      this.onFailure(err instanceof Error ? err.message : String(err))
      return
    }
    this.child = child

    let buf = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line) as HotkeyEvent
          if (ev.phase === 'ready') this.restartCount = 0
          if (ev.name && ev.phase) this.onEvent(ev)
        } catch {
          /* 忽略坏行 */
        }
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf-8').trim()
      // 无权限时每次重试都会报，交给 onFailure 统一提示
      if (msg && msg !== 'accessibility not granted') console.warn('[mt-hotkey]', msg)
    })
    child.on('exit', (code) => {
      this.child = null
      if (this.stopped) return
      if (code === 3) {
        this.onFailure('accessibility-denied')
        return
      }
      // 意外退出：退避重启（最多 5 次）
      if (this.restartCount < 5) {
        this.restartCount++
        this.restartTimer = setTimeout(() => this.spawn(), 500 * this.restartCount)
      } else {
        this.onFailure('repeated-crash')
      }
    })
  }

  /** 配置变更时重启 */
  reload(matches: HotkeyMatchConfig[]): void {
    this.matches = matches
    this.restartCount = 0
    this.stop()
    this.start()
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.child) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* noop */
      }
      this.child = null
    }
  }
}
