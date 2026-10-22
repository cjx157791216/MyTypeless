import { AUTO_SPEAKERS, type AudioApp, type MeetingDetail, type MeetingLive, type MeetingSegment, type MeetingSource, type MeetingSpeaker, type MeetingSummary, type MeetingTrack } from '../../shared/types'
import { renderMarkdown } from '../../shared/markdown'
import { $, api, escapeHtml, fmtClock, fmtDate, fmtDuration, fmtTime, hidePopover, showPopover, showPopoverContent, speakerColor, toast, type PopoverItem } from './util'

// 会议页（D-015）：会议列表 / 开始会议 / 会议详情（实时转写、说话人纠正、纪要）
// 线上会议（D-033）：声音来源三选一；麦克风 + 会议软件时分「现场」「线上」两路，各自的人数与说话人

type Tab = 'minutes' | 'transcript' | 'speakers'

let live: MeetingLive = { state: 'idle' }
let liveAt = 0
let currentId: string | null = null
let detail: MeetingDetail | null = null
let tab: Tab = 'transcript'
let tabChosen = false
let editing = false
let navigate: (hash: string) => void = () => {}
let reloadTimer: number | null = null


export function initMeeting(nav: (hash: string) => void): void {
  navigate = nav
}

export function currentLive(): MeetingLive {
  return live
}

export function liveElapsed(): number {
  return (live.elapsedMs ?? 0) + (live.running ? Date.now() - liveAt : 0)
}

/** 路由进入会议页：有 id 显示详情，否则显示列表 */
export async function showMeetingPage(id?: string): Promise<void> {
  if (id !== currentId) {
    tabChosen = false
    editing = false
    $('meeting-detail-scroll').scrollTop = 0
  }
  currentId = id ?? null
  $('page-meeting').classList.toggle('detail-mode', !!id)
  $('meeting-list-view').classList.toggle('hidden', !!id)
  $('meeting-detail-view').classList.toggle('hidden', !id)
  if (id) await loadDetail()
  else await loadList()
}

// —— 列表 ——

const STATUS_TEXT: Record<MeetingSummary['status'], string> = {
  recording: '进行中',
  paused: '已暂停',
  processing: '整理中',
  done: '',
  interrupted: '待整理'
}

/** 参会人数选项：自动（按声音判断，D-042）或 1～10 人 */
const SPEAKER_COUNTS = [AUTO_SPEAKERS, 1, 2, 3, 4, 5, 6, 7, 8, 10]

/** 选择框里的人数值：自动为 AUTO_SPEAKERS */
function countValue(sel: HTMLSelectElement): number {
  const n = Number(sel.value)
  return Number.isInteger(n) && n >= 0 ? n : AUTO_SPEAKERS
}

/** 开始会议卡片的说明：开启保存会议录音（D-044）时写明存到哪 */
async function renderAudioNote(): Promise<void> {
  const s = await api.settings.get()
  $('meeting-audio-note').textContent = s.meetingSaveAudio
    ? `录音结束后保存到「${s.meetingAudioDir || '应用数据目录'}」（设置 → 会议录音）。`
    : '录音只在本机临时保存，整理完自动删除。'
}

let startInited = false
let appsSupported = true

async function loadList(): Promise<void> {
  const meetings = await api.meeting.list()
  if (!startInited) {
    startInited = true
    const s = await api.settings.get()
    for (const [id, n] of [['meeting-speakers', s.meetingSpeakers], ['meeting-remote', s.meetingRemoteSpeakers]] as const) {
      const sel = $(id) as HTMLSelectElement
      for (const c of SPEAKER_COUNTS) sel.add(new Option(String(c), String(c)))
      sel.value = String(SPEAKER_COUNTS.includes(n) ? n : AUTO_SPEAKERS)
    }
    ;($('meeting-source') as HTMLSelectElement).value = s.meetingSource || 'mic'
    // 上次只用麦克风（没用过或没在用线上会议）：当作没有偏好，默认选第一个通话软件；否则沿用上次的选择（空 = 全部系统声音）
    await loadApps(s.meetingSource && s.meetingSource !== 'mic' ? (s.meetingApp ?? '') : null)
  } else await loadApps(($('meeting-app') as HTMLSelectElement).value)
  updateSourceUi()
  void prepareAppAudio()
  renderStartCard()
  void renderAudioNote()
  const box = $('meeting-interrupted')
  box.innerHTML = ''
  for (const m of meetings.filter((x) => x.status === 'interrupted')) {
    const card = document.createElement('div')
    card.className = 'card interrupted'
    const text = document.createElement('span')
    text.textContent = `「${m.title}」上次意外中断，录音还在本机，可以继续整理`
    const btn = document.createElement('button')
    btn.className = 'btn primary'
    btn.textContent = '继续整理'
    btn.addEventListener('click', () => endChoice(btn, (minutes) => void finishMeeting(m.id, minutes), '整理'))
    card.append(text, btn)
    box.appendChild(card)
  }

  const list = $('meeting-list')
  list.innerHTML = ''
  if (!meetings.length) {
    list.innerHTML = '<div class="empty">还没有会议记录</div>'
    return
  }
  for (const m of meetings) {
    const el = document.createElement('div')
    el.className = 'meeting-item'
    const status = m.status === 'done' && !m.hasMinutes ? '无纪要' : STATUS_TEXT[m.status]
    const badgeCls = m.status === 'recording' || m.status === 'paused' ? 'live' : m.status === 'interrupted' || status === '无纪要' ? 'warn' : ''
    el.innerHTML = `
      <div class="main">
        <span class="title"></span>
        <span class="meta"></span>
      </div>
      ${status ? `<span class="status-badge ${badgeCls}">${status}</span>` : ''}`
    ;(el.querySelector('.title') as HTMLElement).textContent = m.title
    ;(el.querySelector('.meta') as HTMLElement).textContent = [
      `${fmtDate(m.startedAt)} ${fmtTime(m.startedAt)}`,
      m.durationMs ? fmtDuration(m.durationMs) : '',
      m.speakers.length ? m.speakers.join('、') : ''
    ]
      .filter(Boolean)
      .join(' · ')
    el.addEventListener('click', () => navigate(`#meeting/${m.id}`))
    list.appendChild(el)
  }
}

/** 「其他应用…」选项的值（选它时展开其余正在运行的应用） */
const OTHER_APPS = '__other_apps__'
let audioApps: AudioApp[] = []
let showOtherApps = false

/**
 * 可截取声音的应用（D-033）：只列正在运行的通话软件和浏览器（网页会议），然后是「全部系统声音」；
 * 其余应用收在「其他应用…」里，选它或上次选的就是其他应用时才展开
 */
async function loadApps(selected: string | null): Promise<void> {
  const { supported, apps } = await api.meeting.audioApps()
  appsSupported = supported
  audioApps = apps
  if (apps.some((a) => a.kind === 'other' && a.bundleId === selected)) showOtherApps = true
  renderApps(selected)
  const source = $('meeting-source') as HTMLSelectElement
  for (const o of Array.from(source.options)) if (o.value !== 'mic') o.disabled = !supported
  if (!supported) source.value = 'mic'
}

/** selected 为 null：没有偏好，选第一个通话软件 / 浏览器 */
function renderApps(selected: string | null): void {
  const sel = $('meeting-app') as HTMLSelectElement
  sel.innerHTML = ''
  const main = audioApps.filter((a) => a.kind !== 'other')
  const others = audioApps.filter((a) => a.kind === 'other')
  for (const a of main) sel.add(appOption(a))
  sel.add(new Option('全部系统声音', ''))
  if (others.length && showOtherApps) {
    const group = document.createElement('optgroup')
    group.label = '其他应用'
    for (const a of others) group.appendChild(appOption(a))
    sel.appendChild(group)
  } else if (others.length) sel.add(new Option('其他应用…', OTHER_APPS))
  const pickable = showOtherApps ? audioApps : main
  // 默认：第一个通话软件 / 浏览器；都没开着时为全部系统声音
  sel.value = selected !== null && (selected === '' || pickable.some((a) => a.bundleId === selected)) ? selected : (main[0]?.bundleId ?? '')
}

function appOption(a: AudioApp): HTMLOptionElement {
  const notes = [a.kind === 'browser' ? '网页会议' : '', a.output ? '正在发声' : ''].filter(Boolean)
  const o = new Option(notes.length ? `${a.name}（${notes.join('，')}）` : a.name, a.bundleId)
  o.dataset.name = a.name
  return o
}

$('meeting-app').addEventListener('change', () => {
  const sel = $('meeting-app') as HTMLSelectElement
  if (sel.value !== OTHER_APPS) return
  showOtherApps = true
  renderApps(audioApps.find((a) => a.kind === 'other')?.bundleId ?? '')
})

// 用户去打开会议软件后回到主窗口：刷新正在运行的应用（窗口失焦时下拉框不会是展开的，重建选项不打断操作）
window.addEventListener('focus', () => {
  if (live.state !== 'idle' || ($('meeting-source') as HTMLSelectElement).value === 'mic') return
  void loadApps(($('meeting-app') as HTMLSelectElement).value)
})

const APP_LIST_HINT = '列表里只有正在运行的通话软件和浏览器：没看到要用的软件就先打开它，回到这里会自动刷新。'

/** 按声音来源显示应用与人数选择 */
function updateSourceUi(): void {
  const source = ($('meeting-source') as HTMLSelectElement).value as MeetingSource
  const local = $('meeting-speakers') as HTMLSelectElement
  const remote = $('meeting-remote') as HTMLSelectElement
  $('meeting-app').classList.toggle('hidden', source === 'mic')
  local.classList.toggle('hidden', source === 'app')
  remote.classList.toggle('hidden', source === 'mic')
  const label = (o: HTMLOptionElement, who: string) => (o.text = Number(o.value) === AUTO_SPEAKERS ? `${who}人数：自动` : `${who} ${o.value} 人`)
  for (const o of Array.from(local.options)) label(o, source === 'mixed' ? '现场' : '参会')
  for (const o of Array.from(remote.options)) label(o, source === 'mixed' ? '线上' : '参会')
  $('meeting-source-hint').textContent = !appsSupported
    ? api.platform === 'darwin'
      ? '截取会议软件的声音需要 macOS 14.2 或更新版本'
      : api.platform === 'win32'
        ? '截取会议软件的声音需要 Windows 11（Windows 10 build 20348 以上），请用麦克风'
        : '当前平台暂不支持截取会议软件的声音，请用麦克风'
    : source === 'mixed'
      ? '现场的人走麦克风，会议软件里的人走软件的声音，分开区分说话人。建议戴耳机：外放时对方的声音会被麦克风再录一遍（重复的部分会自动去掉）。' + APP_LIST_HINT + (api.platform === 'darwin' ? '首次使用时系统会请求「录制系统音频」权限。' : '')
      : source === 'app'
        ? '只转写会议软件播放出来的声音（对方的声音），你自己说的话不会被录下。' + APP_LIST_HINT + (api.platform === 'darwin' ? '首次使用时系统会请求「录制系统音频」权限。' : '')
        : ''
}

$('meeting-source').addEventListener('change', async () => {
  // 切到会议软件时刷新正在运行的应用（不在下拉框展开时刷新：重建选项会把展开的下拉框关掉）
  if (($('meeting-source') as HTMLSelectElement).value !== 'mic') await loadApps(($('meeting-app') as HTMLSelectElement).value)
  updateSourceUi()
  void prepareAppAudio()
})

/** 选了会议软件的声音：先完成「录制系统音频」授权（允许后 MyTypeless 会被系统重新打开，必须在开会前） */
async function prepareAppAudio(): Promise<void> {
  if (($('meeting-source') as HTMLSelectElement).value === 'mic') return
  if ((await api.meeting.prepareAppAudio()) === 'waiting') {
    $('meeting-source-hint').textContent = '请在系统弹出的对话框里允许 MyTypeless 录制系统音频；允许后 MyTypeless 会自动重新打开，再开始会议即可。'
  }
}

function renderStartCard(): void {
  const busy = live.state !== 'idle'
  const btn = $('btn-meeting-start') as HTMLButtonElement
  btn.disabled = busy
  const state = $('meeting-start-state')
  if (busy && live.meetingId) {
    state.innerHTML = live.state === 'processing' ? '上一场会议正在整理中…' : '有会议正在进行：<a class="link" href="#meeting/' + escapeHtml(live.meetingId) + '">查看</a>'
  } else if (live.speakerModel === 'downloading') {
    state.textContent = `正在下载声纹模型 ${Math.round((live.speakerModelProgress ?? 0) * 100)}%（首次使用，约 31MB）`
  } else if (live.speakerModel === 'error') {
    state.textContent = '声纹模型下载失败：会议照常转写，下次开会时会重试下载'
  } else state.textContent = ''
}

$('btn-meeting-start').addEventListener('click', async () => {
  const title = ($('meeting-title') as HTMLInputElement).value.trim()
  const source = ($('meeting-source') as HTMLSelectElement).value as MeetingSource
  const appSel = $('meeting-app') as HTMLSelectElement
  const r = await api.meeting.start({
    title,
    source,
    expectedSpeakers: countValue($('meeting-speakers') as HTMLSelectElement),
    expectedRemote: countValue($('meeting-remote') as HTMLSelectElement),
    appBundleId: appSel.value,
    appName: appSel.value ? (appSel.selectedOptions[0]?.dataset.name ?? appSel.value) : '系统声音'
  })
  if (!r.ok) {
    $('meeting-start-state').textContent = r.error ?? '无法开始会议'
    return
  }
  ;($('meeting-title') as HTMLInputElement).value = ''
  toast('会议已开始：请告知参会者正在录音转写')
  navigate(`#meeting/${r.meetingId}`)
})

/** 结束/整理时选择：生成纪要，或只保存记录 */
function endChoice(anchor: HTMLElement, go: (minutes: boolean) => void, verb = '结束'): void {
  showPopover(anchor, [
    { label: `${verb}并生成纪要`, onClick: () => go(true) },
    { label: `${verb}，只保存记录`, onClick: () => go(false) }
  ])
}

async function finishMeeting(id: string, minutes: boolean): Promise<void> {
  const r = await api.meeting.finish(id, { minutes })
  if (!r.ok) toast(r.error ?? '无法整理')
  else navigate(`#meeting/${id}`)
}

// —— 详情 ——

async function loadDetail(): Promise<void> {
  if (!currentId) return
  const d = await api.meeting.get(currentId)
  if (!d) {
    navigate('#meeting')
    return
  }
  detail = d
  if (!tabChosen) tab = d.status === 'done' && (d.minutes || d.minutesError) ? 'minutes' : 'transcript'
  renderDetail()
}

function isLiveHere(): boolean {
  return !!detail && live.meetingId === detail.id && (live.state === 'recording' || live.state === 'paused')
}

function renderDetail(): void {
  const d = detail
  if (!d) return
  const titleInput = $('meeting-detail-title') as HTMLInputElement
  if (document.activeElement !== titleInput) titleInput.value = d.title
  $('meeting-detail-meta').textContent = [
    `${fmtDate(d.startedAt)} ${fmtTime(d.startedAt)}`,
    d.durationMs ? fmtDuration(d.durationMs) : '',
    d.source === 'mixed' ? `现场 + ${d.appName ?? '会议软件'}` : d.source === 'app' ? (d.appName ?? '会议软件') : '',
    d.speakerList.length ? `${d.speakerList.length} 位说话人` : '',
    STATUS_TEXT[d.status]
  ]
    .filter(Boolean)
    .join(' · ')
  renderBars()
  for (const b of document.querySelectorAll<HTMLButtonElement>('#meeting-tabs button')) b.classList.toggle('active', b.dataset.tab === tab)
  for (const p of document.querySelectorAll<HTMLElement>('#meeting-detail-view .tab-panel')) p.classList.toggle('active', p.dataset.tab === tab)
  const audio = $('btn-meeting-reveal-audio')
  audio.classList.toggle('hidden', !d.savedAudioPath)
  audio.title = d.savedAudioPath ?? ''
  ;($('btn-meeting-delete') as HTMLButtonElement).disabled = isLiveHere() || (live.state === 'processing' && live.meetingId === d.id)
  renderSpeakerBar()
  renderTranscript()
  renderSpeakers()
  renderMinutes()
}

/** 说话人栏：按声音自动区分出的每个人，点击改名 */
function renderSpeakerBar(): void {
  const bar = $('speaker-bar')
  const d = detail!
  bar.innerHTML = ''
  // 每一路：说话人 + 人数（麦克风 + 会议软件时分现场、线上两组）
  const tracks: MeetingTrack[] = d.source === 'mixed' ? [0, 1] : d.source === 'app' ? [1] : [0]
  for (const track of tracks) {
    if (d.source === 'mixed') {
      const label = document.createElement('span')
      label.className = 'track-label'
      label.textContent = track === 0 ? '现场' : `线上（${d.appName ?? '会议软件'}）`
      bar.appendChild(label)
    }
    for (const sp of d.speakerList.filter((x) => x.track === track)) {
      const chip = speakerChip(sp.id)
      const count = document.createElement('span')
      count.className = 'count'
      count.textContent = ` · ${sp.segmentCount}`
      chip.appendChild(count)
      bar.appendChild(chip)
    }
    bar.appendChild(countSelect(d, track))
  }
  const hint = document.createElement('span')
  hint.className = 'hint'
  const model = live.speakerModel
  hint.textContent =
    isLiveHere() && model === 'downloading'
      ? `声纹模型下载中 ${Math.round((live.speakerModelProgress ?? 0) * 100)}%，完成后自动区分说话人`
      : model === 'error' || model === 'missing'
        ? '声纹模型未就绪，暂时无法区分说话人（可在 设置 → 声纹 下载）'
        : d.speakerList.length
          ? (d.source === 'app' ? [d.expectedRemote] : d.source === 'mixed' ? [d.expectedSpeakers, d.expectedRemote] : [d.expectedSpeakers]).includes(AUTO_SPEAKERS)
            ? '按声音自动判断人数，判错时可改人数或合并说话人 · 点名字改名'
            : '按参会人数和声音区分 · 点名字改名'
          : isLiveHere()
            ? '有人说话后自动区分说话人'
            : ''
  bar.appendChild(hint)
}

/** 某一路的人数：随时改，立即按新人数重新区分（D-020、D-033）；自动时显示目前分出的人数（D-042） */
function countSelect(d: MeetingDetail, track: MeetingTrack): HTMLSelectElement {
  const expected = track === 1 ? d.expectedRemote : d.expectedSpeakers
  const count = document.createElement('select')
  count.className = 'count-select'
  count.title = '改人数后立即按新人数重新区分说话人'
  if (expected === null) {
    const unset = new Option('人数：未设置', '')
    unset.disabled = true
    count.add(unset)
  }
  const found = d.speakerList.filter((x) => x.track === track).length
  for (const n of SPEAKER_COUNTS) count.add(new Option(n === AUTO_SPEAKERS ? (expected === AUTO_SPEAKERS && found ? `自动（${found} 人）` : '自动') : `${n} 人`, String(n)))
  count.value = expected === null ? '' : String(expected)
  count.addEventListener('change', async () => {
    if (count.value === '') return
    const n = countValue(count)
    const r = await api.meeting.setExpected(d.id, n, track)
    toast(r.ok ? (n === AUTO_SPEAKERS ? '已改为按声音自动判断人数' : `已按 ${n} 人重新区分说话人`) : (r.error ?? '无法重新区分'), r.ok ? 2200 : 4000)
  })
  return count
}

/** 说话人颜色：线上的人从调色板后半段取，与现场同号的人不同色 */
function colorOf(sp: Pick<MeetingSpeaker, 'label' | 'track'> | undefined): string {
  return speakerColor(sp ? sp.label + (sp.track === 1 ? 4 : 0) : null)
}

function speakerOf(id: number | null): MeetingSpeaker | undefined {
  return id === null ? undefined : detail?.speakerList.find((s) => s.id === id)
}

/** 说话人标签（点击改名或合并） */
function speakerChip(speakerId: number | null): HTMLButtonElement {
  const color = colorOf(speakerOf(speakerId))
  const chip = document.createElement('button')
  chip.className = 'speaker-chip'
  chip.style.color = color
  chip.style.background = `${color}1f`
  chip.innerHTML = '<i></i>'
  chip.appendChild(document.createTextNode(speakerName(speakerId)))
  if (speakerId !== null) {
    chip.title = '点击改名'
    chip.addEventListener('click', () => renamePopover(chip, speakerId))
  }
  return chip
}

/** 改名小窗：名字 + 记住这个声音（默认勾选，D-018）+ 合并到其他人 */
function renamePopover(anchor: HTMLElement, speakerId: number): void {
  const d = detail!
  const sp = d.speakerList.find((s) => s.id === speakerId)
  if (!sp) return
  const form = document.createElement('div')
  form.className = 'rename-form'
  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = `「${sp.displayName}」叫什么名字？`
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = defaultName(sp)
  input.value = sp.name ?? ''
  const remember = document.createElement('label')
  remember.className = 'check'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = rememberDefault(sp)
  remember.append(cb, document.createTextNode('记住这个声音（下次会议自动认出）'))
  const actions = document.createElement('div')
  actions.className = 'row-actions'
  const ok = document.createElement('button')
  ok.className = 'btn mini primary'
  ok.textContent = '确定'
  actions.appendChild(ok)
  const submit = async () => {
    hidePopover()
    await saveSpeaker(sp.id, input.value, cb.checked)
  }
  ok.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
  form.append(title, input, remember, actions)
  const others = d.speakerList.filter((s) => s.id !== sp.id && s.track === sp.track)
  if (others.length) {
    form.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
    form.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: '其实是同一个人？合并到' }))
    for (const o of others) {
      const b = document.createElement('button')
      const dot = document.createElement('i')
      dot.style.background = colorOf(o)
      b.append(dot, document.createTextNode(o.displayName))
      b.addEventListener('click', () => {
        hidePopover()
        void merge(sp.id, o.id)
      })
      form.appendChild(b)
    }
  }
  showPopoverContent(anchor, form)
  input.focus()
  input.select()
}

/** 没起名字时的默认名（与主进程 displayName 一致） */
function defaultName(sp: MeetingSpeaker): string {
  if (detail?.source !== 'mixed') return `说话人 ${sp.label}`
  return `${sp.track === 1 ? '线上' : '现场'} ${sp.label}`
}

/** “记住这个声音”默认勾选；只有用户之前命名时明确取消过（有名字但没有声纹）才默认不勾 */
function rememberDefault(sp: { name: string | null; voiceprintId: number | null }): boolean {
  return sp.voiceprintId !== null || !sp.name
}

async function saveSpeaker(speakerId: number, name: string, remember: boolean): Promise<void> {
  const r = await api.meeting.renameSpeaker(detail!.id, speakerId, name, remember)
  if (remember && name.trim() && !r.remembered) toast('已改名；这个人说的话还太少（或声纹模型未就绪），暂时记不住声音')
  else toast(name.trim() ? '已改名' : '已恢复默认名')
}

function renderBars(): void {
  const d = detail!
  const liveBar = $('meeting-live-bar')
  const procBar = $('meeting-processing-bar')
  const here = isLiveHere()
  liveBar.classList.toggle('hidden', !here)
  liveBar.classList.toggle('paused', here && live.state === 'paused')
  if (here) {
    $('meeting-live-time').textContent = fmtClock(liveElapsed())
    $('btn-meeting-pause').textContent = live.state === 'paused' ? '继续' : '暂停'
    $('meeting-live-hint').textContent =
      live.state === 'paused'
        ? '已暂停，不录音'
        : live.speakerModel === 'downloading'
          ? `正在下载声纹模型 ${Math.round((live.speakerModelProgress ?? 0) * 100)}%，下载完成后补做说话人区分`
          : '每句话说完 1～3 秒出现'
  }
  const processingHere = live.state === 'processing' && live.meetingId === d.id
  const interrupted = d.status === 'interrupted'
  procBar.classList.toggle('hidden', !processingHere && !interrupted)
  procBar.querySelector('.spinner')!.classList.toggle('hidden', !processingHere)
  procBar.querySelector('button')?.remove()
  if (processingHere) $('meeting-processing-text').textContent = live.stage ?? '正在整理…'
  else if (interrupted) {
    $('meeting-processing-text').textContent = '这场会议上次意外中断，录音还在本机'
    const btn = document.createElement('button')
    btn.className = 'btn primary'
    btn.textContent = '继续整理'
    btn.style.marginLeft = 'auto'
    btn.addEventListener('click', () => endChoice(btn, (minutes) => void finishMeeting(d.id, minutes), '整理'))
    procBar.appendChild(btn)
  }
}

function speakerName(id: number | null): string {
  if (id === null) return '未区分'
  return detail?.speakerList.find((s) => s.id === id)?.displayName ?? '未区分'
}

function renderTranscript(): void {
  const box = $('transcript')
  const scroller = $('meeting-detail-scroll')
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  box.innerHTML = ''
  const d = detail!
  if (!d.segments.length) {
    box.innerHTML = `<div class="empty">${isLiveHere() ? '等待发言…说完一句话后会出现在这里' : '没有转写内容'}</div>`
    return
  }
  // 同一人连续的句子合并成一段
  const turns: Array<{ speakerId: number | null; segs: MeetingSegment[] }> = []
  for (const s of d.segments) {
    const last = turns.at(-1)
    if (last && last.speakerId === s.speakerId && last.segs[0].track === s.track) last.segs.push(s)
    else turns.push({ speakerId: s.speakerId, segs: [s] })
  }
  for (const t of turns) {
    const row = document.createElement('div')
    row.className = 'turn'
    const time = document.createElement('span')
    time.className = 't'
    time.textContent = fmtClock(t.segs[0].startMs)
    const body = document.createElement('div')
    body.className = 'body'
    const chip = speakerChip(t.speakerId)
    const line = document.createElement('div')
    line.className = 'line'
    for (const s of t.segs) {
      const span = document.createElement('span')
      span.className = 'seg'
      span.textContent = s.text
      span.title = '点击：改为其他说话人'
      span.addEventListener('click', () => segmentMenu(span, s))
      line.appendChild(span)
      line.appendChild(document.createTextNode(/[\p{Script=Han}，。！？]$/u.test(s.text) ? '' : ' '))
    }
    body.append(chip, line)
    row.append(time, body)
    box.appendChild(row)
  }
  if (isLiveHere() && tab === 'transcript' && nearBottom) scroller.scrollTop = scroller.scrollHeight
}

function segmentMenu(anchor: HTMLElement, seg: MeetingSegment): void {
  const d = detail!
  const items: PopoverItem[] = [{ header: '这句话是谁说的' }]
  for (const s of d.speakerList) {
    if (s.id === seg.speakerId || s.track !== seg.track) continue
    items.push({ label: s.displayName, color: colorOf(s), onClick: () => void api.meeting.assignSegment(d.id, seg.id, s.id) })
  }
  items.push('sep', { label: '新的说话人', onClick: () => void api.meeting.assignSegment(d.id, seg.id, 'new') })
  showPopover(anchor, items)
}

async function merge(from: number, into: number): Promise<void> {
  if (!confirm(`把「${speakerName(from)}」的所有发言合并到「${speakerName(into)}」？`)) return
  await api.meeting.mergeSpeakers(detail!.id, from, into)
}

function renderSpeakers(): void {
  const box = $('speaker-list')
  const d = detail!
  // 正在编辑的输入框不打断
  if (box.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return
  box.innerHTML = ''
  if (!d.speakerList.length) {
    box.innerHTML = '<div class="empty">还没有区分出说话人</div>'
    return
  }
  for (const sp of d.speakerList) {
    const row = document.createElement('div')
    row.className = 'speaker-row'
    const dot = document.createElement('i')
    dot.className = 'dot'
    dot.style.background = colorOf(sp)
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = defaultName(sp)
    input.value = sp.name ?? ''
    input.dataset.speakerInput = String(sp.id)
    const remember = document.createElement('label')
    remember.className = 'check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = rememberDefault(sp)
    remember.append(cb, document.createTextNode('记住这个声音'))
    const count = document.createElement('span')
    count.className = 'count'
    count.textContent = `${sp.segmentCount} 句`
    const save = document.createElement('button')
    save.className = 'btn mini'
    save.textContent = '保存'
    const doSave = async () => {
      input.blur()
      await saveSpeaker(sp.id, input.value, cb.checked)
    }
    save.addEventListener('click', () => void doSave())
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void doSave()
    })
    const mergeSel = document.createElement('select')
    mergeSel.innerHTML = '<option value="">合并到…</option>'
    const peers = d.speakerList.filter((o) => o.id !== sp.id && o.track === sp.track)
    for (const o of peers) mergeSel.add(new Option(o.displayName, String(o.id)))
    mergeSel.disabled = !peers.length
    mergeSel.addEventListener('change', () => {
      const into = Number(mergeSel.value)
      mergeSel.value = ''
      if (into) void merge(sp.id, into)
    })
    row.append(dot, input, remember, count, save, mergeSel)
    box.appendChild(row)
  }
}

function renderMinutes(): void {
  const d = detail!
  const view = $('minutes-view')
  const editor = $('minutes-editor') as HTMLTextAreaElement
  const state = $('minutes-state')
  const processingHere = live.state === 'processing' && live.meetingId === d.id
  $('minutes-edit-actions').classList.toggle('hidden', !editing)
  editor.classList.toggle('hidden', !editing)
  view.classList.toggle('hidden', editing)
  ;($('btn-minutes-edit') as HTMLButtonElement).disabled = !d.minutes || editing
  ;($('btn-minutes-copy') as HTMLButtonElement).disabled = !d.minutes
  const regen = $('btn-minutes-regen') as HTMLButtonElement
  regen.textContent = d.minutes ? '重新生成' : '生成纪要'
  regen.disabled = isLiveHere() || processingHere || d.status === 'interrupted' || !d.segments.length
  if (editing) return
  if (d.minutes) {
    view.innerHTML = renderMarkdown(d.minutes)
    markSpeakers(view, d.speakerList)
    state.textContent = ''
  } else {
    view.innerHTML = ''
    state.textContent = processingHere
      ? live.stage ?? '正在生成…'
      : isLiveHere()
        ? '会议结束后自动生成纪要'
        : d.minutesError ?? '这场会议只保存了记录，需要时点「生成纪要」'
  }
}

/** 纪要原文里加粗的说话人名字（生成时本地加的 `**名字**`）显示成说话人颜色；改名后旧名字只是普通粗体 */
function markSpeakers(root: HTMLElement, speakers: MeetingSpeaker[]): void {
  const colors = new Map<string, string>()
  for (const sp of speakers) if (!colors.has(sp.displayName)) colors.set(sp.displayName, colorOf(sp))
  for (const el of root.querySelectorAll<HTMLElement>('strong')) {
    const color = colors.get(el.textContent ?? '')
    if (!color) continue
    el.classList.add('speaker-mention')
    el.style.color = color
    el.style.background = `${color}1f`
  }
}

function selectTab(t: Tab): void {
  tab = t
  tabChosen = true
  renderDetail()
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#meeting-tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab as Tab))

$('btn-meeting-back').addEventListener('click', () => navigate('#meeting'))
$('meeting-detail-title').addEventListener('change', () => {
  const v = ($('meeting-detail-title') as HTMLInputElement).value.trim()
  if (detail && v) void api.meeting.setTitle(detail.id, v)
})
$('btn-meeting-pause').addEventListener('click', () => void (live.state === 'paused' ? api.meeting.resume() : api.meeting.pause()))
$('btn-meeting-stop').addEventListener('click', () => endChoice($('btn-meeting-stop'), (minutes) => void api.meeting.stop({ minutes })))
$('btn-meeting-reveal-audio').addEventListener('click', async () => {
  if (detail && !(await api.meeting.revealAudio(detail.id))) toast('录音文件已被移走或删除')
})
$('btn-meeting-export').addEventListener('click', async () => {
  if (detail && (await api.meeting.exportMarkdown(detail.id))) toast('已导出')
})
$('btn-meeting-delete').addEventListener('click', async () => {
  const kept = detail?.savedAudioPath ? `\n\n保存到文件夹里的录音（${detail.savedAudioPath}）不会删除。` : ''
  if (!detail || !confirm(`删除会议「${detail.title}」？文字、说话人和临时录音都会删除，不可恢复。${kept}`)) return
  if (await api.meeting.remove(detail.id)) navigate('#meeting')
  else toast('会议进行中或整理中，不能删除')
})
$('btn-minutes-edit').addEventListener('click', () => {
  if (!detail?.minutes) return
  editing = true
  ;($('minutes-editor') as HTMLTextAreaElement).value = detail.minutes
  renderMinutes()
  $('minutes-editor').focus()
})
$('btn-minutes-cancel').addEventListener('click', () => {
  editing = false
  renderMinutes()
})
$('btn-minutes-save').addEventListener('click', async () => {
  if (!detail) return
  await api.meeting.saveMinutes(detail.id, ($('minutes-editor') as HTMLTextAreaElement).value)
  editing = false
  toast('纪要已保存')
})
$('btn-minutes-copy').addEventListener('click', async () => {
  if (!detail?.minutes) return
  await navigator.clipboard.writeText(detail.minutes)
  toast('已复制 Markdown')
})
$('btn-minutes-regen').addEventListener('click', async () => {
  if (!detail) return
  if (detail.minutes && !confirm('重新生成会覆盖当前纪要（包括你的编辑），继续？')) return
  tab = 'minutes'
  tabChosen = true
  const r = await api.meeting.regenerate(detail.id)
  if (!r.ok && r.error) toast(r.error, 4000)
})

// —— 实时更新 ——

api.meeting.onChanged((id) => {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => {
    if (!$('page-meeting').classList.contains('active')) return
    if (currentId === id) void loadDetail()
    else if (!currentId) void loadList()
  }, 200)
})

export function onMeetingLive(next: MeetingLive): void {
  const prev = live
  live = next
  liveAt = Date.now()
  if (!$('page-meeting').classList.contains('active')) return
  if (currentId && detail) {
    // 会议刚结束：切到纪要页
    if (prev.meetingId === currentId && prev.state !== 'idle' && next.state === 'idle') {
      tab = 'minutes'
      tabChosen = true
      void loadDetail()
      return
    }
    renderDetail()
  } else if (!currentId) renderStartCard()
}

window.setInterval(() => {
  if (live.state === 'recording' && detail && isLiveHere()) $('meeting-live-time').textContent = fmtClock(liveElapsed())
}, 1000)
