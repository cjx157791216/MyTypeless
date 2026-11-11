// 在线更新（D-028）：发布地址、错误提示、发布脚本生成的版本说明
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compareVersions as cmp, DEFAULT_UPDATE_URL, friendlyUpdateError, isUnpackedWin, needsManualInstall, pendingIsInstalled, releasePageUrl, releasesLatestUrl, UPDATER_CACHE_DIR, updateUrl } from '../src/main/update-info.ts'

const require = createRequire(import.meta.url)
const { compareVersions, parseArtifact, parseWinArtifact, parseWinZip, buildFeed, githubAssetUrl, waitForVersion, winRunTitle, uploadAsset } = require('../scripts/publish.cjs')
const yaml = require('js-yaml')

test('发布地址：GitHub 公开仓库最新 Release 的下载目录，MT_UPDATE_URL 只用于本机测试', () => {
  assert.equal(updateUrl({}), DEFAULT_UPDATE_URL)
  assert.equal(DEFAULT_UPDATE_URL, 'https://github.com/cjx157791216/MyTypeless/releases/latest/download')
  assert.equal(updateUrl({ MT_UPDATE_URL: 'http://127.0.0.1:8787/latest/' }), 'http://127.0.0.1:8787/latest')
})

test('打包配置的发布地址与代码一致（electron-updater 读包内 app-update.yml）', () => {
  const cfg = yaml.load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf-8'))
  assert.equal(cfg.publish.provider, 'generic')
  assert.equal(cfg.publish.url, DEFAULT_UPDATE_URL)
  assert.equal(cfg.publish.updaterCacheDirName, UPDATER_CACHE_DIR)
})

test('错误提示：网络、未发布、未公开、签名不一致、不在应用程序文件夹', () => {
  assert.equal(friendlyUpdateError('getaddrinfo ENOTFOUND github.com'), '连不上发布地址，请检查网络后重试')
  assert.equal(friendlyUpdateError('net::ERR_INTERNET_DISCONNECTED'), '连不上发布地址，请检查网络后重试')
  assert.equal(friendlyUpdateError('Cannot find latest-mac.yml in the latest release artifacts (https://x/latest-mac.yml): HttpError: 404'), '发布地址上还没有版本信息')
  assert.match(friendlyUpdateError('HttpError: 401 Unauthorized'), /公开/)
  const sig = 'Code signature at URL file:///x/MyTypeless.app/ did not pass validation: code failed to satisfy specified code requirement(s)'
  assert.match(friendlyUpdateError(sig), /手动安装/)
  assert.equal(needsManualInstall(sig), true)
  assert.equal(needsManualInstall('ENOTFOUND'), false)
  assert.match(friendlyUpdateError('Cannot update while running on a read-only volume'), /应用程序/)
  assert.match(friendlyUpdateError('something odd\nstack…'), /^更新失败：something odd$/)
})

test('更新完成后清理缓存：只删已装上（不比当前新）的安装包', () => {
  assert.equal(cmp('0.2.10', '0.2.9'), 1)
  assert.equal(pendingIsInstalled('MyTypeless-0.2.2-20261017.1017-arm64.zip', '0.2.2'), true)
  assert.equal(pendingIsInstalled('MyTypeless-0.2.1-20261017.1017-arm64.zip', '0.2.2'), true)
  assert.equal(pendingIsInstalled('MyTypeless-0.2.3-20261017.1017-arm64.zip', '0.2.2'), false) // 已下载、还没重启
  assert.equal(pendingIsInstalled('', '0.2.2'), false)
})

test('Windows 解压即用版（zip）：程序旁没有卸载程序即为解压即用，只提示新版本、打开 Release 页面手动下载', () => {
  assert.equal(isUnpackedWin('win32', ['MyTypeless.exe', 'resources', 'locales']), true)
  assert.equal(isUnpackedWin('win32', ['MyTypeless.exe', 'Uninstall MyTypeless.exe', 'resources']), false) // 安装版
  assert.equal(isUnpackedWin('darwin', ['MyTypeless']), false)
  assert.equal(releasePageUrl('0.3.1'), 'https://github.com/cjx157791216/MyTypeless/releases/tag/v0.3.1')
  assert.equal(releasesLatestUrl(), 'https://github.com/cjx157791216/MyTypeless/releases/latest')
  assert.deepEqual(parseWinZip('MyTypeless-0.3.1-20261018.1015-win-x64.zip'), { version: '0.3.1', build: '20261018.1015' })
  assert.equal(parseWinZip('MyTypeless-0.3.1-20261018.1015-arm64.zip'), null) // macOS 的 zip 不是
  assert.equal(parseArtifact('MyTypeless-0.3.1-20261018.1015-win-x64.zip'), null)
})

test('发布脚本：版本比较与安装包文件名', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0)
  assert.equal(compareVersions('0.2.0', '1.0.0'), -1)
  assert.deepEqual(parseArtifact('MyTypeless-0.2.1-20261017.1015-arm64.zip'), { version: '0.2.1', build: '20261017.1015', ext: 'zip' })
  assert.deepEqual(parseArtifact('MyTypeless-0.2.1-20261017.1015-arm64.dmg')?.ext, 'dmg')
  assert.equal(parseArtifact('MyTypeless-0.2.1-20261017.1015-arm64.zip.blockmap'), null)
  assert.equal(parseArtifact('latest-mac.yml'), null)
  assert.equal(
    githubAssetUrl('cjx157791216/MyTypeless', '0.2.1', 'MyTypeless-0.2.1-20261017.1015-arm64.zip'),
    'https://github.com/cjx157791216/MyTypeless/releases/download/v0.2.1/MyTypeless-0.2.1-20261017.1015-arm64.zip'
  )
})

test('发布脚本：版本说明是 electron-updater 能读的格式（zip 绝对地址、sha512、构建号、DMG 地址）', () => {
  const zipUrl = 'https://github.com/o/r/releases/download/v0.2.1/MyTypeless-0.2.1-20261017.1015-arm64.zip'
  const text = buildFeed({
    version: '0.2.1',
    build: '20261017.1015',
    zipUrl,
    dmgUrl: zipUrl.replace(/zip$/, 'dmg'),
    sha512: 'abc==',
    size: 123,
    notes: '中文识别更准\n修复会议分人',
    date: '2026-10-17T02:15:00.000Z'
  })
  const feed = yaml.load(text)
  assert.equal(feed.version, '0.2.1')
  assert.equal(feed.build, '20261017.1015') // 字符串，不能被解析成数字
  assert.deepEqual(feed.files, [{ url: zipUrl, sha512: 'abc==', size: 123 }])
  assert.equal(feed.path, zipUrl)
  assert.equal(feed.releaseNotes, '中文识别更准\n修复会议分人')
  assert.match(feed.dmgUrl, /\.dmg$/)
})

test('Windows（D-036）：安装包文件名解析；版本说明没有 DMG 地址，安装包为绝对地址', () => {
  assert.deepEqual(parseWinArtifact('MyTypeless-0.3.1-20261018.1015-win-x64.exe'), { version: '0.3.1', build: '20261018.1015' })
  assert.equal(parseWinArtifact('MyTypeless-0.3.1-20261018.1015-win-x64.exe.blockmap'), null)
  assert.equal(parseWinArtifact('MyTypeless-0.3.1-20261018.1015-x64.exe'), null) // 文件名必须带操作系统
  assert.equal(parseWinArtifact('MyTypeless-0.3.1-20261018.1015-arm64.zip'), null)
  assert.equal(parseArtifact('MyTypeless-0.3.1-20261018.1015-win-x64.exe'), null) // Mac 的发布流程不会拿到 Windows 安装包
  const url = 'https://github.com/o/r/releases/download/v0.3.1/MyTypeless-0.3.1-20261018.1015-win-x64.exe'
  const feed = yaml.load(buildFeed({ version: '0.3.1', build: '20261018.1015', zipUrl: url, sha512: 'abc==', size: 9, notes: '', date: '2026-10-18T02:15:00.000Z' }))
  assert.deepEqual(feed.files, [{ url, sha512: 'abc==', size: 9 }])
  assert.equal('dmgUrl' in feed, false)
})

test('Windows（D-036）：发布脚本按运行标题找到它触发的构建，与工作流的 run-name 一致', () => {
  const wf = yaml.load(readFileSync(new URL('../.github/workflows/release-windows.yml', import.meta.url), 'utf-8'))
  assert.equal(wf['run-name'].replace(/\$\{\{.*\}\}/, 'v0.3.1'), winRunTitle('v0.3.1'))
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs).sort(), ['notes', 'sha', 'tag'])
  const cfg = yaml.load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf-8'))
  assert.equal(cfg.nsis.oneClick, true)
  assert.equal(cfg.nsis.perMachine, false) // 装到当前用户，静默更新不需要管理员权限
  assert.match(cfg.win.artifactName, /-win-\$\{arch\}\.\$\{ext\}$/) // 与发布脚本解析的文件名一致
})

test('waitForVersion：发布后 latest 地址有缓存，读到旧版本时重读，读到本次版本即返回；次数用完返回最后读到的', async () => {
  const reads = ['0.2.1', '0.2.1', '0.3.0']
  let n = 0
  assert.equal(await waitForVersion(async () => reads[n++], '0.3.0', { tries: 5, delayMs: 1 }), '0.3.0')
  assert.equal(n, 3)
  let m = 0
  assert.equal(await waitForVersion(async () => (m++, '0.2.1'), '0.3.0', { tries: 3, delayMs: 1 }), '0.2.1')
  assert.equal(m, 3)
})

test('上传重试：失败后清理同名残骸资产再重传，不同名的资产不动；次数用完抛最后的错误', async () => {
  const calls: string[] = []
  let postCount = 0
  // 模拟 408：zip 前两次上传被掐断（GitHub 会留下不完整资产），第三次成功；latest-mac.yml 一次成功
  const fakeGh = async (_token: unknown, method: string, url: string) => {
    calls.push(`${method} ${url.split('?')[0].replace(/^(https:\/\/(uploads\.)?github\.com)?\/repos\/o\/r\/releases\/9/, 'REL')}`)
    if (method === 'GET' && url.includes('/assets')) return [{ id: 1, name: 'MyTypeless-0.3.10-20261111.2323-arm64.zip' }, { id: 2, name: 'latest-mac.yml' }]
    if (method === 'POST') {
      postCount++
      if (url.includes('arm64.zip') && postCount <= 2) throw new Error('GitHub POST … 失败：HTTP 408 {"message":"Upload body timed out due to inactivity"}')
      return null
    }
    return null
  }
  const opts = { ghFn: fakeGh, readBlob: async () => new Blob(), retryMs: [1, 1], log: () => {} }
  await uploadAsset('t', 'o/r', 9, 'https://uploads.github.com/repos/o/r/releases/9', '/x/MyTypeless-0.3.10-20261111.2323-arm64.zip', opts)
  assert.equal(postCount, 3)
  assert.equal(calls.filter((c) => c.startsWith('DELETE')).length, 2) // 两次失败后各清一次同名残骸
  assert.deepEqual(calls.filter((c) => c.startsWith('DELETE')), ['DELETE REL/assets/1', 'DELETE REL/assets/1']) // 只删 zip，latest-mac.yml 不动
  await uploadAsset('t', 'o/r', 9, 'https://uploads.github.com/repos/o/r/releases/9', '/x/latest-mac.yml', opts)
  assert.equal(calls.filter((c) => c.includes('assets/2')).length, 0)

  let remaining = 99
  const alwaysFail = async (_t: unknown, method: string, url: string) => {
    if (method === 'GET' && url.includes('/assets')) return []
    if (method === 'POST') { assert.ok(remaining-- > 0); throw new Error('HTTP 408') }
    return null
  }
  await assert.rejects(
    uploadAsset('t', 'o/r', 9, 'https://uploads.github.com/repos/o/r/releases/9', '/x/latest-mac.yml', { ghFn: alwaysFail, readBlob: async () => new Blob(), retryMs: [1, 1], log: () => {} }),
    /HTTP 408/
  )
})

test('上传重试：残骸资产 DELETE 404（上传会话已回收）不算错误，继续重传成功', async () => {
  let postCount = 0
  const fakeGh = async (_t: unknown, method: string, url: string) => {
    if (method === 'GET' && url.includes('/assets')) return [{ id: 7, name: 'MyTypeless-0.3.10-20261111.2323-arm64.zip' }]
    if (method === 'POST') {
      postCount++
      if (postCount === 1) throw new Error('GitHub POST … 失败：HTTP 408 Upload body timed out')
      return null
    }
    if (method === 'DELETE') throw new Error('GitHub DELETE … 失败：HTTP 404 {"message":"Not Found"}')
    return null
  }
  await uploadAsset('t', 'o/r', 9, 'https://uploads.github.com/repos/o/r/releases/9', '/x/MyTypeless-0.3.10-20261111.2323-arm64.zip', { ghFn: fakeGh, readBlob: async () => new Blob(), retryMs: [1], log: () => {} })
  assert.equal(postCount, 2)
})
