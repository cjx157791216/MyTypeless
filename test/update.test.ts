// 在线更新（D-028）：发布地址、错误提示、发布脚本生成的版本说明
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compareVersions as cmp, DEFAULT_UPDATE_URL, friendlyUpdateError, needsManualInstall, pendingIsInstalled, UPDATER_CACHE_DIR, updateUrl } from '../src/main/update-info.ts'

const require = createRequire(import.meta.url)
const { compareVersions, parseArtifact, buildFeed, githubAssetUrl } = require('../scripts/publish.cjs')
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
