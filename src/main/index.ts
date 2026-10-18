import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Tray, Menu, nativeImage, nativeTheme, screen, shell, systemPreferences } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { appendFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IPC, type SessionProgress, type Settings, type FeatureMode, type MeetingLive, type MeetingStartOptions, type MeetingTrack } from '../shared/types'
import type { PermissionStatus } from '../shared/api'
import { loadSettings, saveSettings, hasKey, keyMask, setKey, maskKey, getKey } from './config'
import { LlmPolisher, describeLlmError } from './polish'
import { DictationSessionManager } from './session'
import { HotkeyController } from './hotkeys'
import { listHistory, getHistory, deleteHistory, clearHistory, listWords, addWord, removeWord, historyStats } from './history'
import { checkAccessibility, injectText, openAccessibilitySettings } from './inject'
import { activateApp } from './native'
import { checkLocalAsrHealth } from './providers/asr'
import { TRAY_ICON_2X_BASE64 } from './tray-icon'
import { asrLanguage, fireredEngine, modelManager, selectedEngine, selectedModelId, whisperEngine, builtinReady } from './whisper'
import { findModel } from './whisper/catalog'
import { killOrphanEngines } from './whisper/engine'
import { appInfo, versionLabel } from './build-info'
import * as updater from './updater'
import { stopTracking } from './learner'
import { MeetingManager, meetingStore } from './meeting'
import { appAudioSupported, listAudioApps, prepareAppAudio } from './meeting/app-audio'
import { denoiser, diarizer } from './meeting/diarizer'
import { buildTranscript, exportMarkdown } from './meeting/minutes'
import { comboKeys, defaultBindings } from '../shared/platform'

/**
 * MyTypeless 主进程入口
 * 窗口：floating-bar（无边框悬浮条，负责麦克风采集；启动即预建以消除首次开口延迟）
 *      hub（主窗口：设置/历史）· answer-card（AI 回答浮卡）
 * 托盘：开始/停止、打开主窗口、退出
 */

let floatingBar: BrowserWindow | null = null
let hub: BrowserWindow | null = null
let answerCard: BrowserWindow | null = null
let answerCardReady: Promise<void> = Promise.resolve()
let tray: Tray | null = null
let session: DictationSessionManager
let meeting: MeetingManager
let meetingLive: MeetingLive = { state: 'idle' }
let hotkeys: HotkeyController
let escRegistered = false

const isDev = !!process.env.ELECTRON_RENDERER_URL
const isMac = process.platform === 'darwin'
const DEVLOG_PATH = isMac ? '/tmp/mytypeless-main.log' : join(tmpdir(), 'mytypeless-main.log')

/** dev 诊断直写文件（stdout 缓冲不可靠） */
export function devlog(...parts: unknown[]): void {
  if (!isDev) return
  try {
    appendFileSync(DEVLOG_PATH,`[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`)
  } catch {
    /* noop */
  }
}

function attachRendererDiagnostics(win: BrowserWindow, tag: string): void {
  win.webContents.on('preload-error', (_e, path, err) => {
    devlog(`[${tag}] preload-error:`, path, String(err))
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    devlog(`[${tag}] did-fail-load:`, code, desc)
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) devlog(`[${tag}][console]`, message, `(${sourceId}:${line})`)
  })
}

function loadRenderer(win: BrowserWindow, page: string): void {
  if (isDev) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}/index.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
  }
}

const preload = join(__dirname, '../preload/index.js')

function createFloatingBar(): BrowserWindow {
  const win = new BrowserWindow({
    // 窗口比胶囊大（留出出错提示的空间），透明区域点击穿透；只有胶囊本身可交互
    width: FLOATING_BAR_SIZE.width,
    height: FLOATING_BAR_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // macOS 面板窗口（非激活 NSPanel）：能浮在全屏应用上方，且不需要把整个应用变成后台辅助应用
    ...(isMac ? { type: 'panel' } : {}),
    focusable: false, // 永不抢焦点：注入目标始终是用户正在用的 app
    acceptFirstMouse: true, // 非焦点窗口上的 ✓/✕ 第一次点击即生效
    hiddenInMissionControl: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // 隐藏/被遮挡时也要按时处理音频分片
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType：否则 Electron 会把整个应用切成 UIElement（Dock 图标消失、⌘Tab 切不到）
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  attachRendererDiagnostics(win, 'floating-bar')
  loadRenderer(win, 'floating-bar')
  win.on('closed', () => (floatingBar = null))
  return win
}

/** 悬浮条出现在鼠标所在的屏幕 */
const FLOATING_BAR_SIZE = { width: 420, height: 120 }

/** 悬浮胶囊贴在鼠标所在屏幕的底部居中（D-010） */
function positionFloatingBar(win: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { width, height } = win.getBounds()
  win.setPosition(Math.round(workArea.x + workArea.width / 2 - width / 2), Math.round(workArea.y + workArea.height - height - 12))
}

function ensureFloatingBar(): BrowserWindow {
  if (!floatingBar || floatingBar.isDestroyed()) floatingBar = createFloatingBar()
  return floatingBar
}

function showFloatingBar(): void {
  const win = ensureFloatingBar()
  if (!win.isVisible()) positionFloatingBar(win)
  win.showInactive()
}

/** Windows 标题栏按钮（最小化 / 最大化 / 关闭）的底色与图标色，跟随主窗口的 --bg / --fg */
function hubTitleBarOverlay(): Electron.TitleBarOverlay {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: dark ? '#1c1c1e' : '#f7f7f5', symbolColor: dark ? '#f2f2f4' : '#1d1d1f', height: 36 }
}

function createHub(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'MyTypeless',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f7f7f5',
    // 界面自带拖动区（.sidebar-drag / .content-drag）：macOS 保留红绿灯，Windows 用系统绘制的标题栏按钮
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: hubTitleBarOverlay() }),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  })
  if (!isMac) {
    const syncOverlay = () => !win.isDestroyed() && win.setTitleBarOverlay(hubTitleBarOverlay())
    nativeTheme.on('updated', syncOverlay)
    win.on('closed', () => nativeTheme.off('updated', syncOverlay))
  }
  attachRendererDiagnostics(win, 'hub')
  loadRenderer(win, 'hub')
  win.on('closed', () => (hub = null))
  return win
}

function createAnswerCard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    hiddenInMissionControl: true,
    acceptFirstMouse: true, // 浮卡不抢焦点显示，第一次点击即可触发按钮
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  })
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setPosition(workArea.x + workArea.width - 440, workArea.y + workArea.height - 340)
  attachRendererDiagnostics(win, 'answer-card')
  answerCardReady = new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
  loadRenderer(win, 'answer-card')
  win.on('closed', () => (answerCard = null))
  return win
}

interface AnswerPayload {
  question: string
  answer: string
  pending?: boolean
  error?: string
}

/** 浮卡首次创建时页面尚未加载完，必须等加载完成再推送，否则第一次的回答会丢 */
async function updateAnswerCard(payload: AnswerPayload): Promise<void> {
  if (!answerCard || answerCard.isDestroyed()) answerCard = createAnswerCard()
  const win = answerCard
  await answerCardReady
  if (win.isDestroyed()) return
  win.webContents.send(IPC.answerCardUpdate, payload)
  if (!win.isVisible()) win.showInactive()
}

function showHub(anchor?: string): void {
  if (!hub || hub.isDestroyed()) hub = createHub()
  const win = hub
  win.show()
  win.focus()
  if (anchor) {
    const send = () => win.webContents.send(IPC.navigate, anchor)
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }
}

/** 托盘图标的强调色（主窗口浅色 --accent #2f6bff） */
const TRAY_TINT = { r: 0x2f, g: 0x6b, b: 0xff }

function trayImage(): Electron.NativeImage {
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_2X_BASE64, 'base64'), { scaleFactor: 2 })
  if (isMac) {
    img.setTemplateImage(true)
    return img
  }
  // 其他平台不会给模板图反色（黑图在深色任务栏上看不见）：保留轮廓的透明度，涂成强调色
  const { width, height } = img.getSize() // 逻辑尺寸；位图是 @2x 像素
  const px = img.toBitmap({ scaleFactor: 2 }) // BGRA，预乘透明度
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    px[i] = Math.round((TRAY_TINT.b * a) / 255)
    px[i + 1] = Math.round((TRAY_TINT.g * a) / 255)
    px[i + 2] = Math.round((TRAY_TINT.r * a) / 255)
  }
  return nativeImage.createFromBitmap(px, { width: width * 2, height: height * 2, scaleFactor: 2 })
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip('MyTypeless')
  // Windows / Linux：单击托盘图标打开主窗口（macOS 单击即弹菜单）
  if (!isMac) tray.on('click', () => showHub())
  rebuildTrayMenu()
}

/** "opt+space" → "⌥Space"；Windows："rctrl+space" → "右Ctrl+空格" */
function prettyCombo(combo: string): string {
  if (!isMac) return comboKeys(combo, process.platform).join('+')
  const sym: Record<string, string> = { opt: '⌥', option: '⌥', alt: '⌥', cmd: '⌘', command: '⌘', ctrl: '⌃', control: '⌃', shift: '⇧', fn: 'fn ' }
  return combo
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .map((p) => sym[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join('')
}

function rebuildTrayMenu(): void {
  const s = loadSettings()
  const combo = prettyCombo(s.bindings?.dictation ?? s.hotkeyKey)
  const busy = session?.isBusy()
  const recording = session?.isActive()
  const menu = Menu.buildFromTemplate([
    { label: `MyTypeless ${versionLabel()}`, enabled: false },
    ...updateTrayItems(),
    { type: 'separator' },
    {
      label: recording ? '停止听写' : `按住 ${combo} 说话`,
      enabled: recording || !busy,
      click: () => void toggleDictation()
    },
    { type: 'separator' },
    ...meetingTrayItems(),
    { type: 'separator' },
    { label: '打开 MyTypeless', click: () => showHub() },
    { label: '历史记录', click: () => showHub('#history') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray?.setContextMenu(menu)
}

/** 托盘：有新版本 / 已下载时的入口（D-028） */
function updateTrayItems(): Electron.MenuItemConstructorOptions[] {
  const u = updater.updateState()
  if (u.state === 'available') return [{ label: `有新版本 ${u.version}，查看…`, click: () => showHub('#settings/about') }]
  if (u.state === 'downloading') return [{ label: `正在下载新版本 ${u.version}（${u.percent ?? 0}%）`, enabled: false }]
  if (u.state === 'downloaded') return [{ label: `重启并更新到 ${u.version}`, click: () => installUpdate() }]
  return []
}

function installUpdate(): void {
  const r = updater.install()
  if (!r.ok && r.error) dialog.showMessageBox({ type: 'info', message: '暂时不能重启更新', detail: r.error })
}

/** 正在录音、会议或整理中：不重启更新 */
function updateBusyReason(): string | null {
  if (meetingLive.state === 'recording' || meetingLive.state === 'paused') return '会议进行中，结束会议后再重启更新'
  if (meetingLive.state === 'processing') return '会议纪要正在整理，完成后再重启更新'
  if (session?.isBusy()) return '正在听写，完成后再重启更新'
  return null
}

/** 托盘：开始 / 暂停 / 继续 / 结束会议（D-015） */
function meetingTrayItems(): Electron.MenuItemConstructorOptions[] {
  if (!meeting) return []
  const st = meetingLive.state
  if (st === 'recording' || st === 'paused') {
    return [
      { label: st === 'paused' ? '继续会议' : '暂停会议', click: () => (st === 'paused' ? meeting.resume() : meeting.pause()) },
      { label: '结束会议并生成纪要', click: () => void meeting.stop({ minutes: true }) },
      { label: '结束会议（只保存记录）', click: () => void meeting.stop({ minutes: false }) }
    ]
  }
  if (st === 'processing') return [{ label: '会议纪要整理中…', enabled: false }]
  return [{ label: '开始会议', enabled: !session?.isBusy(), click: () => void startMeetingFromTray() }]
}

/** 浮动条上点「结束」：问一下要不要生成纪要 */
async function requestMeetingStop(): Promise<void> {
  if (!meeting.isActive()) return
  app.focus({ steal: true })
  const parent = hub && !hub.isDestroyed() && hub.isVisible() ? hub : undefined
  const opts = {
    type: 'question' as const,
    buttons: ['生成纪要', '只保存记录', '继续开会'],
    defaultId: 0,
    cancelId: 2,
    message: '结束会议',
    detail: '生成纪要会把转写文字发给你配置的 LLM；只保存记录则不生成，之后随时可以在会议详情里生成。'
  }
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  if (response === 2) return
  void meeting.stop({ minutes: response === 0 })
}

function onMeetingChanged(meetingId: string): void {
  if (hub && !hub.isDestroyed()) hub.webContents.send(IPC.meetingChanged, meetingId)
}

async function startMeetingFromTray(): Promise<void> {
  const r = await meeting.start({})
  if (!r.ok) {
    showHub('#meeting')
    return
  }
  showHub(`#meeting/${r.meetingId}`)
}

function onMeetingLive(live: MeetingLive): void {
  meetingLive = live
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.meetingLive, live)
  if (live.state !== 'idle') showFloatingBar()
  else if (!session.isBusy()) floatingBar?.hide()
  rebuildTrayMenu()
}

async function toggleDictation(): Promise<void> {
  if (session.isActive()) await session.stop()
  else if (!session.isBusy()) {
    await session.start('dictation')
    session.enterHandsFree() // 从托盘开始没有“松键”，按免手持处理
  }
}

/** 会话进行中临时接管 Esc 用于取消；结束后立即归还 */
function syncEscShortcut(p: SessionProgress): void {
  const want = p.state === 'recording' || p.state === 'transcribing' || p.state === 'polishing'
  if (want && !escRegistered) {
    escRegistered = globalShortcut.register('Escape', () => session.cancel())
  } else if (!want && escRegistered) {
    globalShortcut.unregister('Escape')
    escRegistered = false
  }
}

let hideTimer: NodeJS.Timeout | null = null

function onSessionProgress(p: SessionProgress): void {
  syncEscShortcut(p)
  // 内置引擎缺模型：直接把用户带到下载入口
  if (p.errorCode === 'LOCAL_MODEL_MISSING') showHub('#home')
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  if (p.state === 'idle') {
    hideTimer = setTimeout(() => {
      if (!session.isBusy() && meetingLive.state === 'idle') floatingBar?.hide()
    }, 250)
  } else {
    showFloatingBar()
  }

  if (p.mode === 'ask') {
    if (p.state === 'polishing') void updateAnswerCard({ question: p.rawText ?? '', answer: '', pending: true })
    else if (p.state === 'done') void updateAnswerCard({ question: p.rawText ?? '', answer: p.polishedText ?? '' })
    else if (p.state === 'error' && answerCard?.isVisible()) void updateAnswerCard({ question: '', answer: '', error: p.error })
  }
  rebuildTrayMenu()
}

function applyLoginItem(s: Settings): void {
  if (!app.isPackaged) return // dev 模式下会把 Electron 本体注册为登录项
  const want = !!s.launchAtLogin
  if (app.getLoginItemSettings().openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want })
}

let permissionHostCache: string | undefined | null = null

/**
 * 开发模式下系统隐私权限归属于“负责进程”——启动 npm run dev 的终端应用（iTerm、终端、VS Code…），
 * 而不是 Electron 或 MyTypeless。沿父进程链找到第一个 .app，提示用户给它授权。
 */
function permissionHost(): string | undefined {
  if (app.isPackaged || !isMac) return undefined // 只有 macOS 的隐私权限（TCC）归属于负责进程
  if (permissionHostCache !== null) return permissionHostCache
  permissionHostCache = undefined
  let pid = process.ppid
  for (let i = 0; i < 12 && pid > 1; i++) {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
      const m = out.match(/^(\d+)\s+(.*)$/)
      if (!m) break
      const bundle = m[2].match(/([^/]+)\.app\/Contents\/MacOS\//)
      if (bundle) {
        permissionHostCache = bundle[1]
        break
      }
      pid = Number(m[1])
    } catch {
      break
    }
  }
  return permissionHostCache
}

/**
 * 主键含 Fn 时，系统「按下 🌐 键时」若不是「无操作」，松开 Fn 会弹表情面板 / 切换输入法。
 * AppleFnUsageType：0 无操作，1 切换输入法，2 表情与符号，3 开始听写；未设置 = 系统默认（非无操作）。
 */
function fnKeyConflict(): boolean {
  if (!isMac) return false
  const s = loadSettings()
  const usesFn = [s.bindings?.dictation, s.bindings?.ask, s.bindings?.translate, s.bindings?.rewrite].some((c) => /(^|\+)fn(\+|$)/i.test(c ?? ''))
  if (!usesFn) return false
  try {
    return execFileSync('defaults', ['read', 'com.apple.HIToolbox', 'AppleFnUsageType'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '0'
  } catch {
    return true
  }
}

async function permissionStatus(): Promise<PermissionStatus> {
  return {
    accessibility: await checkAccessibility(),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    nativeHotkey: hotkeys.isNativeReady(),
    permissionHost: permissionHost(),
    fnKeyConflict: fnKeyConflict()
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.sessionStart, async (_e, mode?: FeatureMode) => {
    if (session.isBusy()) return
    await session.start(mode ?? 'dictation')
    session.enterHandsFree() // 程序化开始没有“松键”，按免手持处理
  })
  ipcMain.handle(IPC.sessionStop, async () => session.stop())
  ipcMain.handle(IPC.sessionCancel, () => session.cancel())
  ipcMain.handle(IPC.sessionGetState, () => session.lastProgress)
  ipcMain.handle(IPC.sessionAudioChunk, (_e, buf: ArrayBuffer) => {
    session.pushAudio(new Int16Array(buf))
  })
  ipcMain.handle(IPC.sessionAudioFinal, () => session.audioFinal())

  ipcMain.handle(IPC.settingsGet, () => {
    const s = structuredClone(loadSettings())
    // 不解密：打开主窗口不触发钥匙串授权
    s.asr.hasApiKey = hasKey('asr')
    s.asr.apiKeyMasked = keyMask('asr')
    s.llm.hasApiKey = hasKey('llm')
    s.llm.apiKeyMasked = keyMask('llm')
    return s
  })
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => {
    const next = saveSettings(patch)
    if (!next.learnFromEdits) stopTracking() // 关闭“从修改中学习”：立即停止进行中的追踪
    // 不再使用内置引擎，或换了模型：释放当前引擎（下次开口按新设置启动）
    const running = whisperEngine.runningModel()
    if (running && (next.asr.provider !== 'builtin' || running !== modelManager.installedPath(selectedModelId(next)))) {
      whisperEngine.stop()
    }
    if (next.asr.provider !== 'builtin' || selectedEngine(next) !== 'firered') fireredEngine.stop()
    hotkeys.registerAll()
    applyLoginItem(next)
    updater.schedule()
    rebuildTrayMenu()
    return next
  })
  ipcMain.handle(IPC.settingsSetKey, (_e, which: 'asr' | 'llm', key: string) => {
    try {
      setKey(which, key.trim())
      return { ok: true, masked: maskKey(key.trim()) }
    } catch {
      return { ok: false, masked: '' }
    }
  })
  ipcMain.handle(IPC.modelList, () => modelManager.list(asrLanguage(loadSettings())))
  ipcMain.handle(IPC.modelDownload, (_e, id: string) => modelManager.download(id))
  ipcMain.handle(IPC.modelCancel, (_e, id: string) => modelManager.cancel(id))
  ipcMain.handle(IPC.modelRemove, (_e, id: string) => {
    const path = modelManager.installedPath(id)
    if (path && whisperEngine.runningModel() === path) whisperEngine.stop()
    if (findModel(id)?.engine === 'firered') fireredEngine.stop()
    modelManager.remove(id)
    return modelManager.list(asrLanguage(loadSettings()))
  })
  modelManager.onProgress((p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.modelProgress, p)
    }
  })

  ipcMain.handle(IPC.asrHealth, async (_e, baseUrl?: string) => {
    return checkLocalAsrHealth(baseUrl || loadSettings().asr.baseUrl)
  })

  // 测试 LLM 设置（设置页当前填写的值，不必先保存）：Key 栏留空时用已保存的 Key（会访问钥匙串）
  ipcMain.handle(IPC.llmTest, async (_e, cfg: { baseUrl: string; model: string; apiKey?: string }) => {
    try {
      const settings = { ...loadSettings(), llm: { baseUrl: cfg.baseUrl, model: cfg.model } }
      const key = cfg.apiKey?.trim() || (hasKey('llm') ? getKey('llm') : '')
      const ms = await new LlmPolisher(settings, key, 30_000).ping()
      return { ok: true, ms }
    } catch (err) {
      return { ok: false, error: describeLlmError(err) }
    }
  })

  ipcMain.handle(IPC.historyList, (_e, limit?: number, offset?: number) => listHistory(limit, offset))
  ipcMain.handle(IPC.historyDelete, (_e, id: string) => deleteHistory(id))
  ipcMain.handle(IPC.historyClear, () => clearHistory())
  ipcMain.handle(IPC.historyCopy, (_e, id: string) => {
    const rec = getHistory(id)
    if (!rec) return false
    clipboard.writeText(rec.polishedText || rec.rawText)
    return true
  })

  ipcMain.handle(IPC.dictList, () => listWords())
  ipcMain.handle(IPC.dictAdd, (_e, word: string) => {
    addWord(word, 'manual')
    return listWords()
  })
  ipcMain.handle(IPC.dictRemove, (_e, word: string) => {
    removeWord(word)
    return listWords()
  })
  ipcMain.handle(IPC.historyStats, () => historyStats())
  ipcMain.handle(IPC.appInfo, () => appInfo())

  // —— 在线更新（D-028）——
  ipcMain.handle(IPC.updateGetState, () => updater.updateState())
  ipcMain.handle(IPC.updateCheck, () => updater.check(true))
  ipcMain.handle(IPC.updateDownload, () => updater.download())
  ipcMain.handle(IPC.updateCancel, () => updater.cancelDownload())
  ipcMain.handle(IPC.updateInstall, () => updater.install())
  ipcMain.handle(IPC.updateOpenDownload, () => {
    const url = updater.updateState().dmgUrl
    if (url && /^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  // —— 会议模式（D-015）——
  ipcMain.handle(IPC.meetingStart, (_e, opts?: MeetingStartOptions) => {
    if (session.isBusy()) return { ok: false, error: '正在听写，请先结束' }
    return meeting.start(opts ?? {})
  })
  ipcMain.handle(IPC.meetingPause, () => meeting.pause())
  ipcMain.handle(IPC.meetingResume, () => meeting.resume())
  ipcMain.handle(IPC.meetingStop, (_e, opts?: { minutes?: boolean }) => void meeting.stop(opts ?? {}))
  ipcMain.handle(IPC.meetingRequestStop, () => void requestMeetingStop())
  ipcMain.handle(IPC.meetingGetLive, () => meeting.live())
  ipcMain.handle(IPC.meetingAudioChunk, (_e, buf: ArrayBuffer) => meeting.pushAudio(new Int16Array(buf)))
  ipcMain.handle(IPC.meetingList, () => meetingStore.listMeetings())
  ipcMain.handle(IPC.meetingGet, (_e, id: string) => meetingStore.getMeetingDetail(id))
  ipcMain.handle(IPC.meetingDelete, (_e, id: string) => meeting.delete(id))
  ipcMain.handle(IPC.meetingSetTitle, (_e, id: string, title: string) => {
    if (title.trim()) meetingStore.updateMeeting(id, { title: title.trim() })
    onMeetingChanged(id)
  })
  ipcMain.handle(IPC.meetingRenameSpeaker, (_e, id: string, speakerId: number, name: string, remember: boolean) => meeting.renameSpeaker(id, speakerId, name, remember))
  ipcMain.handle(IPC.meetingAssignSegment, (_e, id: string, segmentId: number, speakerId: number | 'new') => meeting.assignSegment(id, segmentId, speakerId))
  ipcMain.handle(IPC.meetingMergeSpeakers, (_e, id: string, from: number, into: number) => meeting.mergeSpeakers(id, from, into))
  ipcMain.handle(IPC.meetingSaveMinutes, (_e, id: string, markdown: string) => {
    meetingStore.updateMeeting(id, { minutes: markdown, minutesError: null })
    onMeetingChanged(id)
  })
  ipcMain.handle(IPC.meetingRegenerate, (_e, id: string) => meeting.regenerate(id))
  ipcMain.handle(IPC.meetingSetExpected, (_e, id: string, n: number, track?: MeetingTrack) => meeting.setExpected(id, n, track === 1 ? 1 : 0))
  ipcMain.handle(IPC.meetingAudioApps, async () => ({ supported: appAudioSupported(), apps: await listAudioApps() }))
  ipcMain.handle(IPC.meetingPrepareAppAudio, () => prepareAppAudio())
  ipcMain.handle(IPC.meetingFinish, (_e, id: string, opts?: { minutes?: boolean }) => meeting.finish(id, opts ?? {}))
  ipcMain.handle(IPC.meetingExport, async (e, id: string) => {
    const d = meetingStore.getMeetingDetail(id)
    if (!d) return false
    const names = new Map(d.speakerList.map((s) => [s.id, s.displayName]))
    const transcript = buildTranscript(d.segments.map((s) => ({ startMs: s.startMs, speaker: (s.speakerId !== null && names.get(s.speakerId)) || '未区分', text: s.text })))
    const parent = BrowserWindow.fromWebContents(e.sender)
    const opts = { defaultPath: `${d.title.replace(/[\\/:*?"<>|]/g, '_')}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] }
    const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return false
    writeFileSync(res.filePath, exportMarkdown(d.minutes, transcript), 'utf-8')
    return true
  })
  ipcMain.handle(IPC.speakerModelAction, (_e, action: 'download' | 'cancel' | 'remove') => meeting.speakerModelAction(action))
  ipcMain.handle(IPC.voiceprintList, () => meetingStore.listVoiceprints())
  ipcMain.handle(IPC.voiceprintRename, (_e, id: number, name: string) => {
    if (name.trim()) meetingStore.renameVoiceprint(id, name.trim())
    return meetingStore.listVoiceprints()
  })
  ipcMain.handle(IPC.voiceprintDelete, (_e, id: number) => {
    meetingStore.deleteVoiceprint(id)
    return meetingStore.listVoiceprints()
  })

  ipcMain.handle(IPC.answerInsert, async (_e, text: string) => {
    // 点击浮卡按钮会让本 app 成为前台：先藏起浮卡、把焦点还给提问时的应用，再粘贴
    answerCard?.hide()
    const front = await session.frontApp()
    if (front.pid) await activateApp(front.pid)
    await new Promise((r) => setTimeout(r, 180))
    const r = await injectText(text, 'paste')
    return r.ok
  })

  ipcMain.handle(IPC.checkPermissions, () => permissionStatus())
  ipcMain.handle(IPC.resetAccessibility, async () => {
    if (!isMac) return false
    // 只清除本应用（按 bundle id）的辅助功能记录：旧版本签名不同，系统里开关看着是开的但对新版本无效
    const ok = await new Promise<boolean>((resolve) => {
      execFile('tccutil', ['reset', 'Accessibility', 'com.mytypeless.desktop'], (err) => resolve(!err))
    })
    await checkAccessibility(true) // 重新加入列表并弹出系统授权提示
    await openAccessibilitySettings()
    return ok
  })
  ipcMain.handle(IPC.openKeyboardSettings, () => {
    if (isMac) void shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension')
  })
  ipcMain.on(IPC.barInteractive, (_e, interactive: boolean) => {
    floatingBar?.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.handle(IPC.openPermissionSettings, async () => {
    await checkAccessibility(true) // 系统弹窗引导，并把本 app 加入辅助功能列表
    await openAccessibilitySettings()
  })
  ipcMain.on(IPC.windowClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide()
  })
}

const gotLock = app.requestSingleInstanceLock()
devlog('module evaluated, gotLock =', gotLock, 'isPackaged =', app.isPackaged)
// 文本/语音应用无需 GPU 加速；规避部分环境下 GPU 初始化卡顿
app.disableHardwareAcceleration()
// Windows：系统通知按应用标识归属，须与安装包快捷方式的标识（electron-builder.yml 的 appId）一致，否则通知不显示（D-036）
if (process.platform === 'win32') app.setAppUserModelId('com.mytypeless.desktop')
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showHub())

  app.whenReady().then(async () => {
    devlog('app ready, starting services')
    session = new DictationSessionManager()
    session.onProgress(onSessionProgress)
    meeting = new MeetingManager({
      onLive: onMeetingLive,
      onChanged: onMeetingChanged,
      setCapture: (on, micDeviceId) => {
        const win = ensureFloatingBar()
        const send = () => win.webContents.send(IPC.meetingCapture, { on, micDeviceId })
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
        else send()
      }
    })
    meeting.markInterrupted()
    const orphans = killOrphanEngines()
    if (orphans) devlog('killed orphan engines:', orphans)
    // 会议进行中暂停 Fn 听写（D-015），避免抢麦克风、把听写混进会议记录
    session.setBlocker(() => (meeting.isActive() ? '会议进行中，听写已暂停' : null))
    hotkeys = new HotkeyController(session)
    hotkeys.registerAll()

    registerIpc()
    const info = appInfo()
    app.setAboutPanelOptions({ applicationName: 'MyTypeless', applicationVersion: info.version, version: info.build === 'dev' ? 'dev' : `${info.build} · ${info.commit}` })
    createTray()
    updater.initUpdater({
      enabled: () => loadSettings().autoCheckUpdates !== false,
      busyReason: updateBusyReason,
      onState: (u) => {
        for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.updateState, u)
        rebuildTrayMenu()
      },
      showAbout: () => showHub('#settings/about')
    })
    ensureFloatingBar() // 预建采集窗口：首次按键即可录音
    applyLoginItem(loadSettings())

    // 升级迁移：快捷键仍是旧默认值（⌥+空格 / ⌥T / ⌥R / ⌥A）→ 换成 Fn 系列新默认值（D-010）
    const b = loadSettings().bindings
    if (isMac && b?.dictation === 'opt+space' && b.translate === 'opt+t' && b.rewrite === 'opt+r' && b.ask === 'opt+a') {
      saveSettings({ hotkeyKey: 'fn', bindings: { dictation: 'fn', translate: 'fn+shift', rewrite: '', ask: 'fn+space' } })
      hotkeys.registerAll()
    }
    // 非 macOS 读不到 Fn：主键仍是 fn（如从 macOS 拷来的设置）→ 换成本平台默认（Windows 右 Ctrl，GAP-008）
    if (!isMac && /(^|\+)fn(\+|$)/i.test(b?.dictation ?? '')) {
      saveSettings(defaultBindings(process.platform))
      hotkeys.registerAll()
    }
    // 升级迁移：选了云端但从未配置识别 Key（无法使用）→ 改用内置本地引擎（D-009）
    if (loadSettings().asr.provider === 'openai' && !hasKey('asr')) {
      saveSettings({ asr: { ...loadSettings().asr, provider: 'builtin' } })
    }
    // 升级迁移：最长录音时长仍是旧默认值 2 分钟（界面从未提供修改）→ 20 分钟（D-014）
    if (loadSettings().maxRecordingMs === 120_000) saveSettings({ maxRecordingMs: 20 * 60_000 })
    // 首次启动 / 未完成配置：打开主窗口引导
    const s = loadSettings()
    // 内置引擎：模型未下载（首次安装后）；云端：未配置 Key
    const needsSetup = s.asr.provider === 'builtin' ? !builtinReady(s) : s.asr.provider === 'openai' && !hasKey('asr')
    if (needsSetup || !(await checkAccessibility())) {
      devlog('setup incomplete, showing hub')
      showHub()
    }
    // askForMediaAccess 只有 macOS 有；Windows 由系统设置统一控制桌面应用的麦克风访问
    if (isMac && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      void systemPreferences.askForMediaAccess('microphone')
    }

    app.on('activate', () => showHub())
  })

  app.on('before-quit', (e) => {
    if (!meeting?.isActive()) return
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['结束会议并退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '会议正在录音',
      detail: '退出前会先结束会议；纪要会在下次打开时继续整理。'
    })
    if (choice === 1) e.preventDefault()
    else meeting.pause()
  })
  app.on('will-quit', () => {
    whisperEngine.stop()
    fireredEngine.stop()
    diarizer.stop()
    denoiser.stop()
    hotkeys?.unregisterAll()
    globalShortcut.unregisterAll()
  })
  app.on('window-all-closed', () => {
    // 托盘常驻；不退出
  })
}
