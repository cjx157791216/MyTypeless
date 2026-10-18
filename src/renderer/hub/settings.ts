import type { AsrProviderConfig, MeetingLive, ModelInfo, ModelProgress, Settings, StyleSample } from '../../shared/types'
import { $, api } from './util'
import { defaultBindings } from '../../shared/platform'

// 设置页：识别/润色配置、模型下载、快捷键、麦克风；首页的模型横幅与权限状态也在这里维护

const settingsListeners = new Set<() => void>()
/** 设置保存后通知（首页快捷键速查等） */
export function onSettingsSaved(l: () => void): void {
  settingsListeners.add(l)
}

let savedSettings: Settings | null = null

export function currentSettings(): Settings | null {
  return savedSettings
}

export async function loadSettingsIntoUi(): Promise<void> {
  const s = await api.settings.get()
  const defaults = defaultBindings(api.platform).bindings
  ;($('bind-dictation') as HTMLInputElement).placeholder = defaults.dictation
  ;($('bind-ask') as HTMLInputElement).placeholder = defaults.ask
  ;($('bind-translate') as HTMLInputElement).placeholder = defaults.translate
  // Windows 上有的程序（VS Code 编辑器、Notepad++）读不到选区，主键会按普通听写覆盖选中内容，需要单独的改写键
  if (api.platform !== 'darwin') ($('bind-rewrite') as HTMLInputElement).placeholder = '留空：选中文字后按主键即可（VS Code、Notepad++ 等读不到选区的程序除外）'
  savedSettings = s
  ;($('asr-provider') as HTMLSelectElement).value = s.asr.provider
  ;($('asr-language') as HTMLSelectElement).value = s.asr.language ?? 'system'
  ;($('asr-script') as HTMLSelectElement).value = s.asr.chineseScript ?? 'system'
  ;($('asr-base-url') as HTMLInputElement).value = s.asr.baseUrl
  ;($('asr-model') as HTMLInputElement).value = s.asr.model
  ;($('asr-local-url') as HTMLInputElement).value = s.asr.baseUrl.includes('127.0.0.1') || s.asr.baseUrl.includes('localhost') ? s.asr.baseUrl : 'http://127.0.0.1:8178'
  ;($('llm-base-url') as HTMLInputElement).value = s.llm.baseUrl
  ;($('llm-model') as HTMLInputElement).value = s.llm.model
  ;($('polish-enabled') as HTMLInputElement).checked = s.polishEnabled
  ;($('auto-stop') as HTMLInputElement).checked = s.autoStopSilenceMs > 0
  const maxSel = $('max-recording') as HTMLSelectElement
  if (![...maxSel.options].some((o) => o.value === String(s.maxRecordingMs))) {
    maxSel.add(new Option(`${Math.round(s.maxRecordingMs / 60_000)} 分钟`, String(s.maxRecordingMs)))
  }
  maxSel.value = String(s.maxRecordingMs)
  ;($('bind-dictation') as HTMLInputElement).value = s.bindings?.dictation ?? s.hotkeyKey
  ;($('bind-translate') as HTMLInputElement).value = s.bindings?.translate ?? ''
  ;($('bind-rewrite') as HTMLInputElement).value = s.bindings?.rewrite ?? ''
  ;($('bind-ask') as HTMLInputElement).value = s.bindings?.ask ?? ''
  ;($('translate-target') as HTMLSelectElement).value = s.translateTarget ?? 'English'
  ;($('inject-method') as HTMLSelectElement).value = s.injectMethod
  ;($('launch-at-login') as HTMLInputElement).checked = !!s.launchAtLogin
  ;($('keep-mic-warm') as HTMLInputElement).checked = s.keepMicWarm !== false
  ;($('live-preview') as HTMLInputElement).checked = s.showLiveText === true
  ;($('learn-edits') as HTMLInputElement).checked = s.learnFromEdits !== false
  ;($('learn-frequent') as HTMLInputElement).checked = s.learnFrequentTerms !== false
  ;($('polish-context') as HTMLInputElement).checked = s.polishContext === true
  ;($('learn-style') as HTMLInputElement).checked = s.learnStyle === true
  ;($('style-note') as HTMLTextAreaElement).value = s.styleNote ?? ''
  ;($('auto-update') as HTMLInputElement).checked = s.autoCheckUpdates !== false
  await loadMicDevices(s.micDeviceId ?? '')
  ;($('asr-key-state') as HTMLElement).textContent = s.asr.hasApiKey ? `已配置（${s.asr.apiKeyMasked}）` : '未配置'
  ;($('llm-key-state') as HTMLElement).textContent = s.llm.hasApiKey ? `已配置（${s.llm.apiKeyMasked}）` : '未配置'
  applyAsrProviderUi()
  await refreshModels()
}

const VIRTUAL_INPUT = /screaming bee|blackhole|soundflower|loopback audio|vb-cable|vb-audio|zoomaudiodevice|zoom audio|teams audio|aggregate|聚集设备|多输出|multi-output|background music|eqmac/i

/** 麦克风列表：系统默认是虚拟设备时，“自动”会改用真实麦克风 */
async function loadMicDevices(selected: string): Promise<void> {
  const select = $('mic-device') as HTMLSelectElement
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  const def = inputs.find((d) => d.deviceId === 'default')
  const defLabel = (def?.label ?? '').replace(/^(Default|默认)\s*-\s*/, '')
  select.innerHTML = ''
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = defLabel && VIRTUAL_INPUT.test(defLabel)
    ? `自动（系统默认「${defLabel}」是虚拟设备，将改用真实麦克风）`
    : `自动（跟随系统默认${defLabel ? `：${defLabel}` : ''}；无声时自动换）`
  select.appendChild(auto)
  let n = 0
  for (const d of inputs) {
    if (d.deviceId === 'default' || d.deviceId === 'communications') continue
    const opt = document.createElement('option')
    opt.value = d.deviceId
    opt.textContent = (d.label || `麦克风 ${++n}`) + (VIRTUAL_INPUT.test(d.label) ? '（虚拟设备）' : '')
    select.appendChild(opt)
  }
  select.value = [...select.options].some((o) => o.value === selected) ? selected : ''
}
navigator.mediaDevices.addEventListener('devicechange', () => void loadMicDevices(($('mic-device') as HTMLSelectElement).value))

function applyAsrProviderUi(): void {
  const provider = ($('asr-provider') as HTMLSelectElement).value
  const isCloud = provider === 'openai'
  for (const id of ['asr-cloud-row', 'asr-cloud-model', 'asr-cloud-key', 'asr-key-state']) {
    $(id).style.display = isCloud ? '' : 'none'
  }
  $('asr-local-rows').classList.toggle('show', provider === 'local-whisper')
  $('asr-builtin-rows').classList.toggle('show', provider === 'builtin')
}

/** 保存时只写入设置字段（去掉 hasApiKey 等计算字段） */
function asrFromSaved(patch: Partial<AsrProviderConfig>): AsrProviderConfig {
  const a = savedSettings!.asr
  return {
    provider: a.provider,
    baseUrl: a.baseUrl,
    model: a.model,
    builtinModel: a.builtinModel,
    language: a.language,
    chineseScript: a.chineseScript,
    ...patch
  }
}

// —— 内置引擎模型 ——
let models: ModelInfo[] = []
const progress = new Map<string, ModelProgress>()
let lastResult: ModelProgress | null = null

const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)
const fmtSpeed = (bps?: number) => (bps ? `${(bps / 1e6).toFixed(1)} MB/s` : '')
const isActive = (p?: ModelProgress) => !!p && (p.state === 'downloading' || p.state === 'verifying')

function selectedModelId(): string {
  const id = savedSettings?.asr.builtinModel
  return id && models.some((m) => m.id === id) ? id : models.find((m) => m.recommended)?.id ?? models[0]?.id ?? ''
}

function progressText(p: ModelProgress): string {
  if (p.state === 'verifying') return '校验中…'
  const pct = p.totalBytes ? Math.floor((p.receivedBytes / p.totalBytes) * 100) : 0
  return `${pct}% · ${fmtSize(p.receivedBytes)} / ${fmtSize(p.totalBytes)}${p.bytesPerSec ? ` · ${fmtSpeed(p.bytesPerSec)}` : ''}`
}

async function refreshModels(): Promise<void> {
  models = await api.models.list()
  renderModels()
  renderBanner()
}

function renderModels(): void {
  const list = $('model-list')
  list.innerHTML = ''
  const selected = selectedModelId()
  for (const m of models) {
    const p = progress.get(m.id)
    const row = document.createElement('div')
    row.className = `model-row${m.id === selected ? ' selected' : ''}`
    const head = document.createElement('div')
    head.className = 'model-head'
    const title = document.createElement('span')
    title.textContent = `${m.label} · ${fmtSize(m.sizeBytes)}`
    const actions = document.createElement('span')
    actions.className = 'actions'
    const button = (text: string, onClick: () => void, cls = 'mini') => {
      const b = document.createElement('button')
      b.className = cls
      b.textContent = text
      b.addEventListener('click', onClick)
      actions.appendChild(b)
    }
    if (isActive(p)) {
      const t = document.createElement('span')
      t.className = 'hint'
      t.textContent = progressText(p!)
      actions.appendChild(t)
      button('取消', () => void api.models.cancel(m.id))
    } else if (m.installed) {
      if (m.id === selected) {
        const pill = document.createElement('span')
        pill.className = 'pill ok'
        pill.textContent = '使用中'
        actions.appendChild(pill)
      } else {
        button('使用', () => void useModel(m.id))
      }
      button('删除', () => void removeModel(m))
    } else {
      button('下载', () => void api.models.download(m.id))
    }
    head.append(title, actions)
    const desc = document.createElement('div')
    desc.className = 'hint'
    desc.textContent = m.description
    row.append(head, desc)
    if (isActive(p)) {
      const bar = document.createElement('div')
      bar.className = 'progress'
      bar.innerHTML = '<div class="progress-fill"></div>'
      ;(bar.firstElementChild as HTMLElement).style.width = `${(p!.receivedBytes / p!.totalBytes) * 100}%`
      row.appendChild(bar)
    }
    list.appendChild(row)
  }
}

/** 首次使用横幅：内置引擎且所选模型未下载时显示 */
function renderBanner(): void {
  const banner = $('model-banner')
  const usingBuiltin = savedSettings?.asr.provider === 'builtin'
  const model = models.find((m) => m.id === selectedModelId())
  const justDone = lastResult?.state === 'done' && lastResult.id === model?.id
  if (!usingBuiltin || !model || (model.installed && !justDone)) {
    banner.style.display = 'none'
    return
  }
  banner.style.display = ''
  const p = progress.get(model.id)
  const bar = $('model-banner-progress')
  const btn = $('btn-model-banner') as HTMLButtonElement
  const state = $('model-banner-state')
  if (justDone) {
    $('model-banner-title').textContent = '语音模型已就绪'
    $('model-banner-desc').textContent = '现在可以在任意输入框按住快捷键说话了，识别完全在本机进行。'
    bar.classList.add('hidden')
    btn.style.display = 'none'
    state.textContent = ''
    return
  }
  $('model-banner-title').textContent = '首次使用：下载语音识别模型'
  $('model-banner-desc').textContent = `「${model.label}」约 ${fmtSize(model.sizeBytes)}，只需下载一次，之后识别完全在本机进行、无需联网。`
  btn.style.display = ''
  if (isActive(p)) {
    bar.classList.remove('hidden')
    ;(bar.firstElementChild as HTMLElement).style.width = `${(p!.receivedBytes / p!.totalBytes) * 100}%`
    btn.textContent = '取消'
    state.textContent = progressText(p!)
  } else {
    bar.classList.add('hidden')
    btn.textContent = lastResult?.state === 'error' && lastResult.id === model.id ? '重试' : '下载模型'
    state.textContent = lastResult?.state === 'error' && lastResult.id === model.id ? `下载失败：${lastResult.error ?? ''}（已下载部分会保留，重试从断点继续）` : ''
  }
}

$('btn-model-banner').addEventListener('click', () => {
  const id = selectedModelId()
  if (isActive(progress.get(id))) void api.models.cancel(id)
  else void api.models.download(id)
})

api.models.onProgress((p) => {
  if (isActive(p)) {
    progress.set(p.id, p)
    renderModels()
    renderBanner()
    return
  }
  progress.delete(p.id)
  lastResult = p
  void refreshModels()
  if (p.state === 'done') setTimeout(() => {
    if (lastResult === p) {
      lastResult = null
      renderBanner()
    }
  }, 6000)
})

async function useModel(id: string): Promise<void> {
  savedSettings = await api.settings.set({ asr: asrFromSaved({ builtinModel: id }) })
  savedSettings = await api.settings.get()
  renderModels()
  renderBanner()
}

async function removeModel(m: ModelInfo): Promise<void> {
  if (!confirm(`删除模型「${m.label}」（${fmtSize(m.sizeBytes)}）？之后使用需要重新下载。`)) return
  models = await api.models.remove(m.id)
  renderModels()
  renderBanner()
}

$('asr-provider').addEventListener('change', applyAsrProviderUi)

$('btn-asr-health').addEventListener('click', async () => {
  const state = $('asr-health-state') as HTMLElement
  state.textContent = '检测中…'
  const baseUrl = ($('asr-local-url') as HTMLInputElement).value.trim() || 'http://127.0.0.1:8178'
  const r = await api.settings.asrHealth(baseUrl)
  state.textContent = r.ok ? `✓ 引擎在线 ${r.detail ?? ''}` : `✗ 不在线（${r.detail ?? 'unknown'}）`
})

// 测试润色 LLM：用当前填写的地址、模型（与保存时的默认值一致）和 Key（留空则用已保存的）
$('btn-llm-test').addEventListener('click', async () => {
  const btn = $('btn-llm-test') as HTMLButtonElement
  const state = $('llm-test-state') as HTMLElement
  btn.disabled = true
  state.className = 'hint'
  state.textContent = '测试中…'
  try {
    const r = await api.settings.llmTest({
      baseUrl: ($('llm-base-url') as HTMLInputElement).value.trim() || 'https://api.openai.com/v1',
      model: ($('llm-model') as HTMLInputElement).value.trim() || 'gpt-6-luna',
      apiKey: ($('llm-key') as HTMLInputElement).value.trim() || undefined
    })
    state.classList.add(r.ok ? 'ok' : 'bad')
    state.textContent = r.ok ? `✓ 连通正常（${((r.ms ?? 0) / 1000).toFixed(1)} 秒）` : `✗ ${r.error ?? '测试失败'}`
  } finally {
    btn.disabled = false
  }
})

$('btn-save').addEventListener('click', async () => {
  const hotkeyKey = ($('bind-dictation') as HTMLInputElement).value.trim() || defaultBindings(api.platform).hotkeyKey
  const provider = ($('asr-provider') as HTMLSelectElement).value as AsrProviderConfig['provider']
  const localUrl = ($('asr-local-url') as HTMLInputElement).value.trim() || 'http://127.0.0.1:8178'
  const toAccel = (combo: string) =>
    combo
      .split('+')
      .map((m) => ({ opt: 'Alt', option: 'Alt', alt: 'Alt', cmd: 'Command', command: 'Command', ctrl: 'Control', control: 'Control', shift: 'Shift' }[m.trim().toLowerCase()] ?? m.trim().toUpperCase()))
      .join('+')
  await api.settings.set({
    polishEnabled: ($('polish-enabled') as HTMLInputElement).checked,
    autoStopSilenceMs: ($('auto-stop') as HTMLInputElement).checked ? 1500 : 0,
    maxRecordingMs: Number(($('max-recording') as HTMLSelectElement).value) || 20 * 60_000,
    hotkeyKey,
    hotkeyToggle: toAccel(hotkeyKey),
    bindings: {
      dictation: hotkeyKey,
      translate: ($('bind-translate') as HTMLInputElement).value.trim(),
      rewrite: ($('bind-rewrite') as HTMLInputElement).value.trim(),
      ask: ($('bind-ask') as HTMLInputElement).value.trim()
    },
    translateTarget: ($('translate-target') as HTMLSelectElement).value,
    injectMethod: ($('inject-method') as HTMLSelectElement).value as 'auto' | 'type' | 'paste',
    launchAtLogin: ($('launch-at-login') as HTMLInputElement).checked,
    keepMicWarm: ($('keep-mic-warm') as HTMLInputElement).checked,
    showLiveText: ($('live-preview') as HTMLInputElement).checked,
    learnFromEdits: ($('learn-edits') as HTMLInputElement).checked,
    learnFrequentTerms: ($('learn-frequent') as HTMLInputElement).checked,
    micDeviceId: ($('mic-device') as HTMLSelectElement).value,
    asr: asrFromSaved({
      provider,
      baseUrl:
        provider === 'local-whisper'
          ? localUrl
          : ($('asr-base-url') as HTMLInputElement).value.trim() || 'https://api.openai.com/v1',
      model: ($('asr-model') as HTMLInputElement).value.trim() || 'gpt-transcribe',
      language: ($('asr-language') as HTMLSelectElement).value,
      chineseScript: ($('asr-script') as HTMLSelectElement).value as AsrProviderConfig['chineseScript']
    }),
    llm: {
      baseUrl: ($('llm-base-url') as HTMLInputElement).value.trim() || 'https://api.openai.com/v1',
      model: ($('llm-model') as HTMLInputElement).value.trim() || 'gpt-6-luna'
    }
  })
  let keyOk = true
  for (const which of ['asr', 'llm'] as const) {
    const input = $(`${which}-key`) as HTMLInputElement
    const key = input.value.trim()
    if (!key) continue
    const r = await api.settings.setKey(which, key)
    if (r.ok) input.value = ''
    else keyOk = false
  }
  await loadSettingsIntoUi()
  flashSaved(keyOk ? undefined : 'API Key 保存失败：系统钥匙串不可用')
  setTimeout(() => void refreshPermissions(), 1200) // 快捷键助手重启后再刷新状态
})

function flashSaved(error?: string): void {
  const btn = $('btn-save')
  btn.textContent = error ? error : '已保存 ✓'
  btn.classList.toggle('save-error', !!error)
  settingsListeners.forEach((l) => l())
  setTimeout(() => {
    btn.textContent = '保存设置'
    btn.classList.remove('save-error')
  }, error ? 3000 : 1200)
}

// —— 权限 / 状态 ——
function setPill(id: string, ok: boolean, text: string): void {
  const el = $(id)
  el.textContent = text
  el.classList.toggle('ok', ok)
  el.classList.toggle('bad', !ok)
}

export async function refreshPermissions(): Promise<void> {
  const p = await api.system.checkPermissions()
  setPill('perm-ax', p.accessibility, p.accessibility ? '已授权' : '未授权')
  // 开发模式下权限归属于启动它的终端应用，给 MyTypeless 授权不起作用
  const host = $('perm-host')
  host.textContent = p.permissionHost
    ? `开发模式：系统权限归属于「${p.permissionHost}」，请在辅助功能和麦克风里给「${p.permissionHost}」授权（不是 MyTypeless），授权后几秒内自动生效`
    : ''
  host.style.display = p.permissionHost ? '' : 'none'
  $('fn-conflict').style.display = p.fnKeyConflict ? '' : 'none'
  const micText: Record<string, string> = { granted: '已授权', denied: '已拒绝（系统设置中开启）', restricted: '受限', 'not-determined': '首次录音时询问' }
  setPill('perm-mic', p.microphone === 'granted' || p.microphone === 'not-determined', micText[p.microphone] ?? p.microphone)
  setPill('perm-hotkey', p.nativeHotkey, p.nativeHotkey ? '原生（支持按住说话）' : '兜底模式（按住说话退化为按一下开始/结束）')
  $('btn-perm').style.display = p.accessibility ? 'none' : ''
  // 打包版未授权时提示“旧授权记录”并提供重置（开发模式下权限属于终端，重置无意义）
  const stale = !p.accessibility && !p.permissionHost
  $('perm-stale').style.display = stale ? '' : 'none'
  $('btn-perm-reset').style.display = stale ? '' : 'none'
}

$('btn-perm').addEventListener('click', () => void api.system.openPermissionSettings())
$('btn-perm-refresh').addEventListener('click', () => void refreshPermissions())
$('btn-keyboard-settings').addEventListener('click', () => void api.system.openKeyboardSettings())
$('btn-perm-reset').addEventListener('click', async () => {
  await api.system.resetAccessibility()
  setTimeout(() => void refreshPermissions(), 1500)
})

// —— 单项开关即时保存（词典页的学习开关等，带 data-autosave="设置字段名"）——
for (const el of document.querySelectorAll<HTMLInputElement>('input[data-autosave]')) {
  el.addEventListener('change', async () => {
    savedSettings = await api.settings.set({ [el.dataset.autosave!]: el.checked } as Partial<Settings>)
  })
}

// —— 润色个性化（D-040、D-041）：默认关闭；打开时说明会读取 / 保存什么、发给谁 ——
function llmHost(): string {
  const url = ($('llm-base-url') as HTMLInputElement).value.trim() || savedSettings?.llm.baseUrl || ''
  try {
    return new URL(url).host
  } catch {
    return url || '所配置的模型服务'
  }
}

function consentToggle(id: string, field: 'polishContext' | 'learnStyle', message: () => string): void {
  const el = $(id) as HTMLInputElement
  el.addEventListener('change', async () => {
    if (el.checked && !confirm(message())) {
      el.checked = false
      return
    }
    savedSettings = await api.settings.set({ [field]: el.checked } as Partial<Settings>)
  })
}

consentToggle('polish-context', 'polishContext', () =>
  `开启后，每次听写会读取光标前最多 300 字，随润色请求发送到 ${llmHost()}，只用于这一次整理，不保存。\n\n密码框不读。确定开启？`
)
consentToggle('learn-style', 'learnStyle', () =>
  `开启后，听写写入后你又改过的内容会保存在本机（最多 50 条，可随时删除），润色时挑最近几条发送到 ${llmHost()} 作参考。\n\n确定开启？`
)
$('style-note').addEventListener('change', async () => {
  savedSettings = await api.settings.set({ styleNote: ($('style-note') as HTMLTextAreaElement).value.trim() })
})

export async function loadStyleSamples(): Promise<void> {
  renderStyleSamples(await api.styleSamples.list())
}

function renderStyleSamples(samples: StyleSample[]): void {
  const list = $('style-sample-list')
  list.innerHTML = ''
  ;($('btn-style-clear') as HTMLButtonElement).disabled = !samples.length
  if (!samples.length) {
    const empty = document.createElement('span')
    empty.className = 'hint'
    empty.textContent = '还没有修改记录：开启“学习我的修改习惯”后，听写写入后你又改过的内容会出现在这里'
    list.appendChild(empty)
    return
  }
  for (const x of samples) {
    const row = document.createElement('div')
    row.className = 'style-sample-row'
    row.title = `${new Date(x.createdAt).toLocaleString()}${x.appName ? ` · ${x.appName}` : ''}`
    const before = document.createElement('span')
    before.className = 'before'
    before.textContent = x.before
    const arrow = document.createElement('span')
    arrow.className = 'hint'
    arrow.textContent = '→'
    const after = document.createElement('span')
    after.className = 'after'
    after.textContent = x.after
    const del = document.createElement('button')
    del.className = 'btn mini'
    del.textContent = '删除'
    del.addEventListener('click', async () => renderStyleSamples(await api.styleSamples.remove(x.id)))
    row.append(before, arrow, after, del)
    list.appendChild(row)
  }
}

$('btn-style-clear').addEventListener('click', async () => {
  if (!confirm('清空全部修改记录？之后的润色不再参考它们。')) return
  renderStyleSamples(await api.styleSamples.clear())
})

// —— 声纹（D-016）——
export async function loadVoiceprints(): Promise<void> {
  const list = $('voiceprint-list')
  const prints = await api.voiceprints.list()
  list.innerHTML = ''
  if (!prints.length) {
    list.innerHTML = '<span class="hint">还没有保存的声纹</span>'
    return
  }
  for (const p of prints) {
    const row = document.createElement('div')
    row.className = 'voiceprint-row'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = p.name
    input.addEventListener('change', async () => {
      if (input.value.trim()) await api.voiceprints.rename(p.id, input.value.trim())
    })
    const info = document.createElement('span')
    info.className = 'hint'
    info.textContent = `${p.samples} 句`
    const del = document.createElement('button')
    del.className = 'btn mini danger'
    del.textContent = '删除'
    del.addEventListener('click', async () => {
      if (!confirm(`删除「${p.name}」的声纹？之后的会议不会再自动认出这个人。`)) return
      await api.voiceprints.remove(p.id)
      void loadVoiceprints()
    })
    row.append(input, info, del)
    list.appendChild(row)
  }
}

// —— 声纹模型（会议模式）——
export function renderSpeakerModel(live: MeetingLive): void {
  const actions = $('speaker-model-actions')
  const bar = $('speaker-model-progress')
  const state = live.speakerModel ?? 'missing'
  actions.innerHTML = ''
  const add = (el: HTMLElement) => actions.appendChild(el)
  const button = (text: string, onClick: () => void, cls = 'btn mini') => {
    const b = document.createElement('button')
    b.className = cls
    b.textContent = text
    b.addEventListener('click', onClick)
    add(b)
  }
  const label = (text: string, cls = 'hint') => add(Object.assign(document.createElement('span'), { className: cls, textContent: text }))
  bar.classList.toggle('hidden', state !== 'downloading')
  if (state === 'downloading') {
    const pct = Math.round((live.speakerModelProgress ?? 0) * 100)
    ;(bar.firstElementChild as HTMLElement).style.width = `${pct}%`
    label(`${pct}%`)
    button('取消', () => void api.voiceprints.model('cancel'))
  } else if (state === 'ready') {
    label('已下载', 'pill ok')
    button('删除', async () => {
      if (!confirm('删除声纹模型（74 MB）？之后开会时会重新下载；已保存的声纹不受影响。')) return
      const r = await api.voiceprints.model('remove')
      if (!r.ok && r.error) alert(r.error)
    })
  } else {
    if (state === 'error') label('下载失败，可重试（从断点继续）', 'hint warn')
    button(state === 'error' ? '重试' : '下载', () => void api.voiceprints.model('download'), 'btn mini primary')
  }
}
