import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { cpus, setPriority } from 'os'
import { helperPath } from '../native'

/**
 * 内置识别引擎进程（mt-whisper = whisper.cpp 的 whisper-server）：
 * - 只监听 127.0.0.1 的随机空闲端口
 * - 按需启动：开始录音时预热，模型加载（约 0.5 秒）藏在说话期间
 * - 常驻以保持低延迟；闲置 IDLE_STOP_MS 后退出释放内存（turbo 模型约 770MB）
 * - 进程意外退出后，下次调用自动重启
 */

const IDLE_STOP_MS = 10 * 60_000
const START_TIMEOUT_MS = 60_000

export class WhisperEngine {
  private child: ChildProcess | null = null
  private modelPath = ''
  private port = 0
  private starting: Promise<string> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private stderrTail: string[] = []

  isRunning(): boolean {
    return !!this.child && !this.starting
  }

  runningModel(): string | null {
    return this.child ? this.modelPath : null
  }

  /** 确保引擎以指定模型运行，返回服务地址 */
  async ensureRunning(modelPath: string): Promise<string> {
    this.touch()
    if (this.modelPath === modelPath) {
      if (this.starting) return this.starting
      if (this.child) return this.baseUrl()
    }
    if (this.child) this.stop()
    this.modelPath = modelPath
    const starting = this.start(modelPath)
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  /** 推迟闲置退出（请求开始和结束时调用） */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS)
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const child = this.child
    this.child = null
    this.starting = null
    if (child && child.exitCode === null) child.kill('SIGTERM')
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private async start(modelPath: string): Promise<string> {
    const bin = helperPath('mt-whisper')
    if (!bin) throw new Error('LOCAL_ENGINE_MISSING')
    const port = await freePort()
    // macOS：识别主要跑在 GPU（Metal）上，CPU 线程只负责解码，4 个足够，多了只会和其他工作抢核。
    // Windows 版只用 CPU（AVX2）：按物理核数（约逻辑核的一半）给，最多 8 个
    const maxThreads = process.platform === 'darwin' ? 4 : 8
    const threads = String(Math.max(2, Math.min(maxThreads, Math.floor(cpus().length / 2))))
    this.stderrTail = []
    const child = spawn(bin, ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', threads, '-l', 'auto'], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let exited = false
    child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line.trim()) this.stderrTail.push(line.trim())
      }
      if (this.stderrTail.length > 20) this.stderrTail.splice(0, this.stderrTail.length - 20)
    })
    // 降低调度优先级：机器忙时让位给用户的其他工作（只在争抢 CPU 时生效）
    try {
      if (child.pid) setPriority(child.pid, 10)
    } catch {
      /* noop */
    }
    child.on('exit', () => {
      exited = true
      if (this.child === child) this.child = null
    })
    child.on('error', () => {
      exited = true
    })
    this.child = child
    this.port = port

    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited) throw new Error(`LOCAL_ENGINE_FAILED: ${this.stderrTail.slice(-3).join(' | ')}`)
      if (this.child !== child) throw new Error('LOCAL_ENGINE_FAILED: stopped')
      try {
        // 加载模型期间 /health 返回 503
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) return base
      } catch {
        /* 尚未监听 */
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    this.stop()
    throw new Error('LOCAL_ENGINE_TIMEOUT')
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/**
 * 清理上次异常退出（崩溃、被强制结束）留下的识别引擎：whisper-server 不会随父进程退出，
 * 残留进程各占约 770MB 内存。只清理本应用 mt-whisper 路径、且父进程已是 launchd（pid 1）的进程（Windows 见 killOrphanEnginesWin）。
 */
export function killOrphanEngines(): number {
  const bin = helperPath('mt-whisper')
  if (!bin) return 0
  if (process.platform === 'win32') {
    killOrphanEnginesWin(bin)
    return 0
  }
  let killed = 0
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8' })
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!m || m[2] !== '1' || !m[3].startsWith(`${bin} `)) continue
      try {
        process.kill(Number(m[1]), 'SIGTERM')
        killed++
      } catch {
        /* 已退出 */
      }
    }
  } catch {
    /* ps 不可用时忽略 */
  }
  return killed
}

/**
 * Windows 没有“被 launchd 收养”：清理本应用 mt-whisper.exe 中父进程已不存在的。查询要起 PowerShell（约 1 秒），
 * 放到后台做，不拖慢启动。父进程号被新进程复用时不会误杀（只会漏清一次）。
 */
function killOrphanEnginesWin(bin: string): void {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='mt-whisper.exe'\" | " +
    'Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ' +
    'ForEach-Object { \'{0}|{1}\' -f $_.ProcessId, $_.ExecutablePath }'
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
    if (err) return
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, path] = line.split('|')
      if (!pid || path?.toLowerCase() !== bin.toLowerCase()) continue
      try {
        process.kill(Number(pid))
      } catch {
        /* 已退出 */
      }
    }
  })
}
