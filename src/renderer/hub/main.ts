import type { AppMode } from '../../shared/types'
import { $, api, fmtClock } from './util'
import { loadSettingsIntoUi, loadStyleSamples, loadVoiceprints, onSettingsSaved, refreshPermissions, renderSpeakerModel } from './settings'
import { loadHome, renderShortcuts } from './home'
import { loadHistory } from './history'
import { loadDict } from './dict'
import { currentLive, initMeeting, liveElapsed, onMeetingLive, showMeetingPage } from './meeting'
import { initUpdate } from './update'

/**
 * 主窗口（D-017）：左侧导航 + 页面路由（location.hash）。
 * 个人模式：首页 / 历史 / 词典；会议模式：会议（D-015）；设置两种模式共用。
 * body[data-platform] 标出运行平台：.mac-only 的元素只在 macOS 上显示（辅助功能授权等）。
 * #home · #history · #dict · #settings · #meeting · #meeting/<会议 id>
 */

document.body.dataset.platform = api.platform

const PAGES = ['home', 'history', 'dict', 'settings', 'meeting'] as const
type Page = (typeof PAGES)[number]

let mode: AppMode = 'personal'
let currentPage: Page | null = null

function setMode(next: AppMode): void {
  if (next !== mode) void api.settings.set({ appMode: next })
  mode = next
  for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-switch button')) b.classList.toggle('active', b.dataset.mode === mode)
  for (const n of document.querySelectorAll<HTMLElement>('.nav[data-for]')) n.classList.toggle('show', n.dataset.for === mode)
}

function navigate(hash: string): void {
  if (location.hash === hash) void route()
  else location.hash = hash
}

async function route(): Promise<void> {
  const raw = location.hash.replace(/^#/, '') || (mode === 'meeting' ? 'meeting' : 'home')
  const [name, arg] = raw.split('/')
  const page: Page = (PAGES as readonly string[]).includes(name) ? (name as Page) : 'home'
  if (page === 'meeting') setMode('meeting')
  else if (page !== 'settings') setMode('personal')
  for (const p of document.querySelectorAll<HTMLElement>('.page')) p.classList.toggle('active', p.id === `page-${page}`)
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav button')) b.classList.toggle('active', b.dataset.page === page)
  const changed = page !== currentPage
  currentPage = page
  if (changed) (document.querySelector('.content') as HTMLElement).scrollTop = 0
  if (page === 'home') {
    void loadHome()
    void refreshPermissions()
  } else if (page === 'history') void loadHistory()
  else if (page === 'dict') void loadDict()
  else if (page === 'settings') {
    void loadStyleSamples()
    // 声纹列表加载完再滚动：列表在「关于」上方，加载后会把它往下推
    void loadVoiceprints().then(() => arg && document.getElementById(`settings-${arg}`)?.scrollIntoView({ block: 'start' }))
  }
  else if (page === 'meeting') await showMeetingPage(arg)
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.nav button')) b.addEventListener('click', () => navigate(`#${b.dataset.page}`))
for (const b of document.querySelectorAll<HTMLButtonElement>('.mode-switch button')) {
  b.addEventListener('click', () => navigate(b.dataset.mode === 'meeting' ? '#meeting' : '#home'))
}
window.addEventListener('hashchange', () => void route())
api.system.onNavigate((anchor) => navigate(anchor.startsWith('#') ? anchor : `#${anchor}`))

// 侧栏的会议状态：会议进行中时始终可见，点一下回到会议
function renderSidebarLive(): void {
  const live = currentLive()
  const el = $('sidebar-live')
  el.classList.toggle('hidden', live.state === 'idle')
  if (live.state === 'idle') return
  $('sidebar-live-text').textContent =
    live.state === 'processing' ? '纪要整理中…' : `${live.state === 'paused' ? '会议已暂停' : '会议中'} ${fmtClock(liveElapsed())}`
}
$('sidebar-live').addEventListener('click', () => {
  const id = currentLive().meetingId
  if (id) navigate(`#meeting/${id}`)
})
api.meeting.onLive((live) => {
  onMeetingLive(live)
  renderSpeakerModel(live)
  renderSidebarLive()
})
window.setInterval(renderSidebarLive, 1000)
initMeeting(navigate)
initUpdate(navigate)
onSettingsSaved(renderShortcuts)

// 用户去系统设置授权后切回来，自动刷新
window.addEventListener('focus', () => {
  if (currentPage === 'home') void refreshPermissions()
})

// 版本：侧栏底部与 设置 → 关于
void api.system.appInfo().then((info) => {
  const dev = info.build === 'dev'
  $('app-version').textContent = dev ? `v${info.version} · 开发版` : `v${info.version} · ${info.build}`
  $('about-version').textContent = info.version
  $('about-build').textContent = dev ? '开发版（未打包）' : info.build
  $('about-commit').textContent = info.commit
})

void (async () => {
  await loadSettingsIntoUi()
  renderShortcuts() // 也填好各页写着主键名的地方（会议页说明等）
  const s = await api.settings.get()
  setMode(s.appMode === 'meeting' ? 'meeting' : 'personal')
  const live = await api.meeting.getLive()
  onMeetingLive(live)
  renderSpeakerModel(live)
  renderSidebarLive()
  await route()
})()
