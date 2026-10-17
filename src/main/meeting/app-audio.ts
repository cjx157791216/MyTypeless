import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type { AudioApp } from '../../shared/types'
import { helperPath } from '../native'

/**
 * 线上会议的应用声音（D-033）：mt-audiotap 截取会议软件播放出来的对方声音，stdout 连续输出 16kHz 单声道 s16le。
 * 协议见 docs/contracts/native-helpers.md。声音只交给会议（与麦克风录音一样写入会议临时录音），不另存、不外发。
 */

/** 首次使用时系统弹「录制系统音频」授权框，回应前助手不输出 ready：等这么久还没就绪就提示用户 */
const READY_HINT_MS = 3000
/** 一直收到纯零（数字静音）这么久：可能没授权（系统只给静音），提示去系统设置 */
const SILENT_HINT_MS = 60_000
const MAX_RESTARTS = 5

/** macOS：Process tap 需要 14.2+。Windows：进程回环录音需要 Windows 10 build 20348+（即 Windows 11，GAP-008） */
export function appAudioSupported(): boolean {
  if (process.platform === 'win32') return Number(process.getSystemVersion().split('.')[2] ?? 0) >= 20348 && !!helperPath('mt-audiotap')
  if (process.platform !== 'darwin') return false
  const [major, minor] = process.getSystemVersion().split('.').map(Number)
  return (major > 14 || (major === 14 && minor >= 2)) && !!helperPath('mt-audiotap')
}

/**
 * 截取哪些进程：应用的 bundleId 前缀（辅助进程 com.google.Chrome.helper 一起截到）；
 * Safari 的网页声音由系统共用的 WebKit 媒体进程发出，要一起截取（会带上其他 WebKit 应用的声音）
 */
export function tapBundles(bundleId: string): string[] {
  return bundleId === 'com.apple.Safari' ? [bundleId, 'com.apple.WebKit.GPU'] : [bundleId]
}

/** MyTypeless 自己（列表里去掉、截取全部时排除）：macOS 为 bundleId 前缀，Windows 为 exe 文件名（Windows 的应用标识见 mt-audiotap 契约） */
function ownAppId(): string {
  if (process.platform === 'win32') return app.isPackaged ? 'mytypeless.exe' : 'electron.exe'
  return app.isPackaged ? 'com.mytypeless' : 'com.github.Electron'
}

/** 常见会议软件（选择列表排在前面；开会时默认选正在运行的第一个） */
const MEETING_APPS = [
  'com.tencent.meeting', // 腾讯会议
  'com.electron.lark', // 飞书
  'us.zoom.xos', // Zoom
  'com.microsoft.teams2',
  'com.microsoft.teams',
  'com.alibaba.DingTalkMac', // 钉钉
  'com.tencent.xinWeChat', // 微信
  'com.cisco.webexmeetingsapp',
  'com.google.Chrome', // 网页会议（Google Meet、腾讯会议网页版…）
  'com.microsoft.edgemac',
  'com.apple.Safari',
  'org.mozilla.firefox',
  // Windows：小写 exe 文件名（mt-audiotap --apps 的 bundleId）
  'wemeetapp.exe', // 腾讯会议
  'feishu.exe', // 飞书
  'lark.exe',
  'zoom.exe',
  'ms-teams.exe',
  'teams.exe',
  'dingtalk.exe', // 钉钉
  'weixin.exe', // 微信
  'wechat.exe',
  'webexhost.exe',
  'chrome.exe',
  'msedge.exe',
  'firefox.exe'
]

/** 正在运行的应用（给开会时选择“截取哪个应用的声音”）：常见会议软件在前，其次是正在发声的 */
export function listAudioApps(): Promise<AudioApp[]> {
  const bin = helperPath('mt-audiotap')
  if (!bin || !appAudioSupported()) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(bin, ['--apps'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([])
      try {
        const own = ownAppId()
        const list = (JSON.parse(stdout) as AudioApp[]).filter((a) => !a.bundleId.startsWith(own))
        const rank = (a: AudioApp) => {
          const i = MEETING_APPS.indexOf(a.bundleId)
          return i >= 0 ? i : MEETING_APPS.length + (a.output ? 0 : a.audio ? 1 : 2)
        }
        resolve(list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)))
      } catch {
        resolve([])
      }
    })
  })
}

let authorized = false
let probing: Promise<boolean> | null = null

/**
 * 开会前确认已能截取（D-033）：首次使用时系统弹「录制系统音频」授权框，用户允许后 macOS 会退出并重新打开 MyTypeless——
 * 必须在会议开始前完成，否则会议被打断。授权框还没回应时返回 'waiting'（探测进程留着，授权框不消失）。
 * 用户拒绝过时系统不再询问、只给静音：仍返回 'ready'，由会议中“一直是静音”的提示引导去系统设置。
 */
/** 不能截取会议软件声音时给用户的说明 */
export function appAudioUnsupportedHint(): string {
  if (process.platform === 'darwin') return '截取会议软件的声音需要 macOS 14.2 或更新版本'
  if (process.platform === 'win32') return '截取会议软件的声音需要 Windows 11（Windows 10 build 20348 以上）'
  return '当前平台暂不支持截取会议软件的声音'
}

export async function prepareAppAudio(timeoutMs = 2500): Promise<'ready' | 'waiting' | 'unsupported'> {
  if (!appAudioSupported()) return 'unsupported'
  if (authorized) return 'ready'
  if (!probing) {
    probing = new Promise<boolean>((resolve) => {
      const child = spawn(helperPath('mt-audiotap')!, ['--probe'], { stdio: ['ignore', 'ignore', 'pipe'] })
      const giveUp = setTimeout(() => child.kill('SIGTERM'), 120_000) // 两分钟没回应：收起，下次再问
      createInterface({ input: child.stderr! }).on('line', (line) => {
        if (line.includes('"ready"')) {
          authorized = true
          resolve(true)
        }
      })
      child.on('exit', () => {
        clearTimeout(giveUp)
        probing = null
        resolve(authorized)
      })
      child.on('error', () => resolve(false))
    })
  }
  const r = await Promise.race([probing, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))])
  return r ? 'ready' : 'waiting'
}

export function isMeetingApp(bundleId: string): boolean {
  return MEETING_APPS.includes(bundleId)
}

export type AppAudioEvent =
  | { type: 'ready' }
  | { type: 'waiting-permission' } // 系统授权框还没回应
  | { type: 'silent' } // 一直是纯零：可能没授权
  | { type: 'failed'; error: string } // 多次重启仍失败

export class AppAudioCapture {
  private child: ChildProcess | null = null
  private stopped = false
  private restarts = 0
  private leftover: Buffer | null = null
  private heardSound = false
  private silentTimer: NodeJS.Timeout | null = null
  private readonly args: string[]
  private readonly onPcm: (pcm: Int16Array) => void
  private readonly onEvent: (e: AppAudioEvent) => void

  /** bundleId 为空 = 全部系统声音（排除 MyTypeless 自己） */
  constructor(bundleId: string, onPcm: (pcm: Int16Array) => void, onEvent: (e: AppAudioEvent) => void) {
    this.onPcm = onPcm
    this.onEvent = onEvent
    const own = app.getAppMetrics().map((m) => m.pid)
    this.args = [
      ...(bundleId ? tapBundles(bundleId).flatMap((b) => ['--bundle', b]) : []),
      ...own.flatMap((pid) => ['--exclude-pid', String(pid)]),
      '--exclude-bundle',
      ownAppId()
    ]
  }

  start(): void {
    this.stopped = false
    this.spawn()
    this.silentTimer = setTimeout(() => {
      if (!this.heardSound && !this.stopped) this.onEvent({ type: 'silent' })
    }, SILENT_HINT_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.silentTimer) clearTimeout(this.silentTimer)
    this.silentTimer = null
    this.child?.kill('SIGTERM')
    this.child = null
    this.leftover = null
  }

  private spawn(): void {
    const bin = helperPath('mt-audiotap')
    if (!bin) {
      this.onEvent({ type: 'failed', error: '缺少 mt-audiotap' })
      return
    }
    const child = spawn(bin, this.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    let ready = false
    const hint = setTimeout(() => {
      if (!ready && this.child === child) this.onEvent({ type: 'waiting-permission' })
    }, READY_HINT_MS)
    createInterface({ input: child.stderr! }).on('line', (line) => {
      let msg: { ready?: boolean; error?: string } = {}
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.ready && !ready) {
        ready = true
        clearTimeout(hint)
        this.onEvent({ type: 'ready' })
      } else if (msg.error) console.warn('[app-audio]', msg.error)
    })
    child.stdout!.on('data', (buf: Buffer) => {
      if (this.child !== child) return
      // 按 2 字节对齐：上一块剩下的半个样本接到这一块前面
      const data = this.leftover ? Buffer.concat([this.leftover, buf]) : buf
      const even = data.length - (data.length % 2)
      this.leftover = even < data.length ? data.subarray(even) : null
      if (!even) return
      const pcm = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + even))
      if (!this.heardSound && pcm.some((v) => v !== 0)) this.heardSound = true
      this.onPcm(pcm)
    })
    child.on('exit', (code) => {
      clearTimeout(hint)
      if (this.child !== child || this.stopped) return
      this.child = null
      // 意外退出（换输出设备失败、coreaudiod 重启…）：稍后重启，期间的缺口由会议按真实时间补静音
      if (code !== 2 && this.restarts < MAX_RESTARTS) {
        this.restarts++
        setTimeout(() => {
          if (!this.stopped) this.spawn()
        }, 1000 * this.restarts)
      } else this.onEvent({ type: 'failed', error: `mt-audiotap 退出（${code}）` })
    })
  }
}
