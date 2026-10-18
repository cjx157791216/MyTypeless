// 线上会议选择截取哪个应用（D-033）：只突出能语音通话的软件和浏览器，其他应用收在「其他应用…」里
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appKind, classifyAudioApps } from '../src/main/meeting/call-apps.ts'

const app = (bundleId: string, name: string, output = false) => ({ bundleId, name, audio: output, output })

test('appKind：macOS 按 bundleId（含子标识），Windows 按 exe 文件名（不分大小写）', () => {
  assert.equal(appKind('com.tencent.meeting'), 'call')
  assert.equal(appKind('com.tencent.xinWeChat'), 'call')
  assert.equal(appKind('com.electron.lark'), 'call')
  assert.equal(appKind('com.electron.lark.iron'), 'call') // 同一应用的其他版本
  assert.equal(appKind('com.apple.FaceTime'), 'call')
  assert.equal(appKind('com.google.Chrome'), 'browser')
  assert.equal(appKind('com.apple.Safari'), 'browser')
  assert.equal(appKind('wemeetapp.exe'), 'call')
  assert.equal(appKind('Weixin.exe'), 'call')
  assert.equal(appKind('msedge.exe'), 'browser')
  assert.equal(appKind('com.apple.Preview'), 'other')
  assert.equal(appKind('com.electron.larkx'), 'other') // 只认整段前缀
  assert.equal(appKind('excel.exe'), 'other')
})

test('classifyAudioApps：通话软件在前（按常用程度），浏览器其次，其他应用最后；去掉 MyTypeless 自己', () => {
  // 取自真实机器上 mt-audiotap --apps 的输出
  const apps = [
    app('com.google.Chrome', 'Google Chrome'),
    app('com.electron.lark', '飞书', true),
    app('com.apple.Preview', '预览'),
    app('org.mozilla.firefox', 'Firefox'),
    app('com.tencent.xinWeChat', '微信'),
    app('com.microsoft.Excel', 'Microsoft Excel'),
    app('com.openai.codex', 'ChatGPT', true),
    app('com.tencent.meeting', '腾讯会议'),
    app('com.mytypeless.desktop', 'MyTypeless', true)
  ]
  const out = classifyAudioApps(apps, 'com.github.Electron') // 开发运行：打包版 MyTypeless 开着也要去掉
  assert.deepEqual(
    out.map((a) => [a.name, a.kind]),
    [
      ['腾讯会议', 'call'],
      ['微信', 'call'],
      ['飞书', 'call'],
      ['Google Chrome', 'browser'],
      ['Firefox', 'browser'],
      ['ChatGPT', 'other'], // 其他应用里正在发声的在前
      ['预览', 'other'], // 同类按中文排序（与系统语言无关，#37）：中文名按拼音在前、英文名按字母在后
      ['Microsoft Excel', 'other']
    ]
  )
})
