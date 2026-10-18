import { app, safeStorage } from 'electron'
import { defaultBindings } from '../shared/platform'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { Settings } from '../shared/types'

/**
 * 设置存储：普通设置 JSON 明文；API key 用 Electron safeStorage 加密后单独存放。
 * safeStorage 在 macOS 上走 Keychain，满足“key 不落明文盘”的目标。
 */

const SETTINGS_FILE = 'settings.json'
const KEYS_FILE = 'keys.bin'

interface KeyBag {
  [which: string]: string // base64(encrypted)
}

function userDataDir(): string {
  return app.getPath('userData')
}

function settingsPath(): string {
  return join(userDataDir(), SETTINGS_FILE)
}

function keysPath(): string {
  return join(userDataDir(), KEYS_FILE)
}

export const DEFAULT_SETTINGS: Settings = {
  hotkeyMode: 'hold',
  // D-010：按住主键说话 / 轻按免手持；主键+空格 提问；主键+Shift 翻译；主键 macOS 为 Fn、Windows 为右 Ctrl
  ...defaultBindings(process.platform),
  hotkeyToggle: 'Alt+Space',
  translateTarget: 'English',
  autoStopSilenceMs: 0, // hold 模式下默认关（松键即停）；toggle 模式建议开
  maxRecordingMs: 20 * 60_000, // 20 分钟（D-014）；最后 1 分钟浮动条倒计时
  polishEnabled: true,
  injectMethod: 'auto',
  asr: {
    provider: 'builtin',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-transcribe',
    builtinModel: '', // 空 = 按识别语言推荐（中文、英文用 FireRedASR2，D-027）
    language: 'system',
    chineseScript: 'system'
  },
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna'
  },
  launchAtLogin: false,
  keepMicWarm: true,
  micDeviceId: '',
  livePreview: true,
  showLiveText: false,
  learnFromEdits: true,
  learnFrequentTerms: true,
  polishContext: false,
  learnStyle: false,
  styleNote: '',
  appMode: 'personal',
  meetingSpeakers: 2,
  meetingSource: 'mic',
  meetingApp: '',
  meetingRemoteSpeakers: 2,
  autoCheckUpdates: true
}

let cached: Settings | null = null

export function loadSettings(): Settings {
  if (cached) return cached
  try {
    const p = settingsPath()
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      cached = deepMerge(structuredClone(DEFAULT_SETTINGS), raw)
    } else {
      cached = structuredClone(DEFAULT_SETTINGS)
    }
  } catch {
    cached = structuredClone(DEFAULT_SETTINGS)
  }
  return cached
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const merged = deepMerge(structuredClone(loadSettings()), patch)
  mkdirSync(userDataDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf-8')
  cached = merged
  return merged
}

/**
 * 读写 API Key。每次解密都要访问钥匙串（macOS 可能弹出授权框），所以：
 * - 界面判断“有没有 Key”和显示掩码不解密（hasKey / keyMask，掩码只存末 4 位）
 * - 只在真正要用时解密（润色、翻译、改写、提问、会议纪要、云端识别），本次运行内缓存
 */
const keyCache = new Map<string, string>()

function readBag(): KeyBag {
  try {
    const p = keysPath()
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as KeyBag) : {}
  } catch {
    return {}
  }
}

export function hasKey(which: 'asr' | 'llm'): boolean {
  return !!readBag()[which]
}

/** 界面显示用的掩码：••••末4位；旧数据没有存末位时只显示 •••• */
export function keyMask(which: 'asr' | 'llm'): string {
  const bag = readBag()
  if (!bag[which]) return ''
  const tail = bag[`${which}Tail`]
  return tail ? `••••${tail}` : '••••'
}

export function getKey(which: 'asr' | 'llm'): string {
  const cached = keyCache.get(which)
  if (cached !== undefined) return cached
  try {
    const enc = readBag()[which]
    if (!enc || !safeStorage.isEncryptionAvailable()) return ''
    const key = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    keyCache.set(which, key)
    return key
  } catch {
    return ''
  }
}

export function setKey(which: 'asr' | 'llm', key: string): void {
  const bag = readBag()
  if (!key) {
    delete bag[which]
    delete bag[`${which}Tail`]
    keyCache.delete(which)
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      // 开发环境下 Linux headless 可能不可用；macOS 桌面始终可用
      throw new Error('safeStorage unavailable')
    }
    bag[which] = safeStorage.encryptString(key).toString('base64')
    bag[`${which}Tail`] = key.length > 8 ? key.slice(-4) : ''
    keyCache.set(which, key)
  }
  mkdirSync(userDataDir(), { recursive: true })
  writeFileSync(keysPath(), JSON.stringify(bag, null, 2), 'utf-8')
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base
  if (typeof base !== 'object' || base === null) return patch as T
  if (Array.isArray(base) || Array.isArray(patch)) return patch as T
  const out = base as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out as T
}

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return '••••' + key.slice(-4)
}
