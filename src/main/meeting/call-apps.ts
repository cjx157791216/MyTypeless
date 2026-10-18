/**
 * 线上会议截取哪个应用的声音（D-033）：认出能语音通话的软件和浏览器（网页会议），选择列表只突出这些，
 * 其他正在运行的应用收在「其他应用…」里。纯逻辑，不依赖 electron。
 * 应用标识：macOS 为 bundleId（同时认它的子标识，如 com.electron.lark.iron），Windows 为 exe 文件名（不分大小写）。
 */

import type { AudioApp, AudioAppKind } from '../../shared/types.ts'

/** 能语音通话的软件，按常用程度排序（列表里按这个顺序） */
const CALL_APPS: string[][] = [
  ['com.tencent.meeting', 'wemeetapp.exe'], // 腾讯会议
  ['com.tencent.xinWeChat', 'weixin.exe', 'wechat.exe'], // 微信
  ['com.tencent.WeWorkMac', 'wxwork.exe'], // 企业微信
  ['com.tencent.qq', 'qq.exe'], // QQ
  ['com.electron.lark', 'feishu.exe', 'lark.exe'], // 飞书 / Lark
  ['com.alibaba.DingTalkMac', 'dingtalk.exe'], // 钉钉
  ['com.huawei.cloud.welink', 'welink.exe'], // 华为云 WeLink
  ['us.zoom.xos', 'zoom.exe'], // Zoom
  ['com.microsoft.teams2', 'com.microsoft.teams', 'ms-teams.exe', 'teams.exe'], // Microsoft Teams（新版 / 经典版）
  ['Cisco-Systems.Spark', 'com.cisco.webexmeetingsapp', 'ciscocollabhost.exe', 'webexhost.exe', 'atmgr.exe'], // Webex
  ['com.tinyspeck.slackmacgap', 'slack.exe'], // Slack
  ['com.hnc.Discord', 'discord.exe'], // Discord
  ['com.apple.FaceTime'], // FaceTime
  ['ru.keepcoder.Telegram', 'com.tdesktop.Telegram', 'telegram.exe'], // Telegram
  ['net.whatsapp.WhatsApp', 'desktop.WhatsApp', 'whatsapp.exe', 'whatsapp.root.exe'], // WhatsApp
  ['org.whispersystems.signal-desktop', 'signal.exe'], // Signal
  ['jp.naver.line.mac', 'line.exe'] // LINE
]

/** 浏览器：Google Meet、Teams 网页版、腾讯会议网页版等网页会议的声音由浏览器播放 */
const BROWSERS: string[][] = [
  ['com.google.Chrome', 'chrome.exe'],
  ['com.microsoft.edgemac', 'msedge.exe'],
  ['com.apple.Safari'],
  ['org.mozilla.firefox', 'firefox.exe'],
  ['company.thebrowser.Browser', 'arc.exe'], // Arc
  ['com.brave.Browser', 'brave.exe'],
  ['com.operasoftware.Opera', 'opera.exe'],
  ['com.vivaldi.Vivaldi', 'vivaldi.exe']
]

/** MyTypeless 的打包版（开发运行时打包版也可能开着）：任何情况下都不列出 */
const MYTYPELESS_IDS = ['com.mytypeless', 'mytypeless.exe']

function rankIn(table: string[][], bundleId: string): number {
  const id = bundleId.toLowerCase()
  return table.findIndex((ids) => ids.some((known) => id === known.toLowerCase() || id.startsWith(`${known.toLowerCase()}.`)))
}

export function appKind(bundleId: string): AudioAppKind {
  if (rankIn(CALL_APPS, bundleId) >= 0) return 'call'
  if (rankIn(BROWSERS, bundleId) >= 0) return 'browser'
  return 'other'
}

/**
 * 同类应用按名字排序的语言区域：固定为中文（界面是中文；中文名按拼音、英文名按字母，中文在前）。
 * 不指定时用系统语言，中文系统与英文系统排出的顺序不同（#37）
 */
const NAME_LOCALE = 'zh-CN'

/**
 * 给 mt-audiotap --apps 的结果分类并排序：通话软件（按常用程度）→ 浏览器 → 其他应用（正在发声的在前，再按名字）；
 * 去掉 MyTypeless 自己（ownId 为本进程的 bundleId 前缀或 exe 名；打包版无论如何都去掉）。
 */
export function classifyAudioApps(apps: Omit<AudioApp, 'kind'>[], ownId: string): AudioApp[] {
  const rank = (a: AudioApp) => {
    if (a.kind === 'call') return rankIn(CALL_APPS, a.bundleId)
    if (a.kind === 'browser') return 100 + rankIn(BROWSERS, a.bundleId)
    return 200 + (a.output ? 0 : a.audio ? 1 : 2)
  }
  return apps
    .filter((a) => ![ownId, ...MYTYPELESS_IDS].some((id) => a.bundleId.toLowerCase().startsWith(id.toLowerCase())))
    .map((a) => ({ ...a, kind: appKind(a.bundleId) }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, NAME_LOCALE))
}
