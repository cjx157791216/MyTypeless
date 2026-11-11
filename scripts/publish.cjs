#!/usr/bin/env node
/**
 * 发布新版本（npm run release，D-028、D-032）：在代码仓库（src/main/update-info.ts 的 GITHUB_REPO）建 Release
 * v<版本号>（标签打在这次构建的提交上），上传当前版本最新构建的 zip、DMG 与版本说明 latest-mac.yml，最后转为正式发布——
 * 已安装的应用读取 releases/latest/download/latest-mac.yml 发现新版本、下载 zip 自动安装。
 * 旧发布仓库（LEGACY_REPOS，0.2.1 读取的地址）同时发一个只含版本说明的 Release，安装包地址指向代码仓库，旧版本由此更新过来。
 *
 *   GH_TOKEN=$(gh auth token) npm run release -- --notes "更新内容" --yes
 *   npm run release -- --dry-run --feed http://127.0.0.1:8788/latest --assets http://127.0.0.1:8788 --notes "…"
 *     # 只生成 release/latest-mac.yml（本机测试；安装包地址为 <assets>/<版本号>/<文件>）
 *
 * 令牌：`gh auth token`，或细粒度令牌（授权代码仓库与旧发布仓库的 Contents 读写）。
 * 规则：版本号必须比已发布的大（package.json 的 version，发布前手动升级）；应用必须用本机证书签名（自签名证书相同才能自动安装）；
 * 打包时不能有未提交的改动，且那次提交已合并到 GitHub 的 main（release/build-info.json，由 npm run dist 写入）。
 * 终端设了 HTTPS_PROXY 时自动让 fetch 走代理；发布后读到的版本有缓存延迟，会重读最多约 2 分钟。
 * 先建草稿、传完全部文件再转正式：传到一半失败时，已安装的应用看不到不完整的新版本；重跑会删掉同版本的旧草稿。
 * Windows（D-036）：Mac 的文件传完后触发 GitHub Actions 的 release-windows.yml，在 Windows 机器上按同一提交打包，
 * 把安装包与 latest.yml 传到同一个草稿（scripts/publish-win.cjs）；等它成功、文件齐了才转正式——两个平台同时看到新版本，
 * 发布者不需要 Windows 电脑。--no-windows 只发 Mac（Windows 版停在上一个版本，不推荐）。
 * 上传属于对外分发（人工门禁）：不带 --yes 只打印计划。
 */
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const { createReadStream, existsSync, openAsBlob, readdirSync, readFileSync, statSync, writeFileSync } = require('fs')
const { basename, join } = require('path')

const root = join(__dirname, '..')
const API = 'https://api.github.com'
/** 旧发布仓库：0.2.1 从这里检查更新（D-029）；只同步版本说明 */
const LEGACY_REPOS = ['cjx157791216/mytypeless-releases']
/** Windows 安装包的构建工作流（.github/workflows/，D-036） */
const WIN_WORKFLOW = 'release-windows.yml'

/** "0.2.10" > "0.2.9"：只比较数字部分 */
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** MyTypeless-0.2.0-20261015.2347-arm64.zip → { version, build, ext } */
function parseArtifact(name) {
  const m = /^MyTypeless-(\d+\.\d+\.\d+)-(\d{8}\.\d{4})-arm64\.(zip|dmg)$/.exec(name)
  return m ? { version: m[1], build: m[2], ext: m[3] } : null
}

/** MyTypeless-0.3.1-20261018.1015-win-x64.exe → { version, build }（Windows 安装包，D-036） */
function parseWinArtifact(name) {
  const m = /^MyTypeless-(\d+\.\d+\.\d+)-(\d{8}\.\d{4})-win-x64\.exe$/.exec(name)
  return m ? { version: m[1], build: m[2] } : null
}

/** MyTypeless-0.3.1-20261018.1015-win-x64.zip → { version, build }（Windows 解压即用版，D-036） */
function parseWinZip(name) {
  const m = /^MyTypeless-(\d+\.\d+\.\d+)-(\d{8}\.\d{4})-win-x64\.zip$/.exec(name)
  return m ? { version: m[1], build: m[2] } : null
}

/** GitHub Release 里某个文件的下载地址 */
function githubAssetUrl(repo, version, file) {
  return `https://github.com/${repo}/releases/download/v${version}/${file}`
}

/** 版本说明（electron-updater generic 格式 + build、dmgUrl）。zipUrl 为自动更新下载的文件（macOS zip、Windows 安装包 exe；Windows 没有 dmgUrl） */
function buildFeed({ version, build, zipUrl, dmgUrl, sha512, size, notes, date }) {
  const yaml = require('js-yaml')
  return yaml.dump({
    version,
    build,
    files: [{ url: zipUrl, sha512, size }],
    path: zipUrl,
    sha512,
    releaseDate: date,
    releaseNotes: notes || '',
    ...(dmgUrl ? { dmgUrl } : {})
  }, { lineWidth: -1 })
}

function githubRepo() {
  const src = readFileSync(join(root, 'src/main/update-info.ts'), 'utf-8')
  const m = /GITHUB_REPO = '([^']+)'/.exec(src)
  if (!m) throw new Error('src/main/update-info.ts 里找不到 GITHUB_REPO')
  return m[1]
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha512')
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('base64'))).on('error', reject)
  })
}

/** 匿名读取已发布的版本说明（与已安装的应用读法相同）→ 版本号；还没有发布过为 null。file：macOS latest-mac.yml、Windows latest.yml */
async function publishedVersion(feed, file = 'latest-mac.yml') {
  const r = await fetch(`${feed}/${file}`, { signal: AbortSignal.timeout(30_000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`读取已发布的版本说明失败：HTTP ${r.status}`)
  return require('js-yaml').load(await r.text())?.version ?? null
}

/** 发布后核对版本：GitHub 的 latest 地址有缓存，刚发布时可能还读到旧版本，隔一会儿重读，直到读到本次版本或次数用完 */
async function waitForVersion(read, version, { tries = 12, delayMs = 10_000 } = {}) {
  let v = null
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, delayMs))
    v = await read()
    if (v === version) return v
  }
  return v
}

async function gh(token, method, url, body) {
  const r = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...(body instanceof Blob ? { 'Content-Type': 'application/octet-stream' } : {})
    },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body instanceof Blob ? 30 * 60_000 : 30_000)
  })
  if (!r.ok) throw new Error(`GitHub ${method} ${url} 失败：HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
  return r.status === 204 ? null : r.json()
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const dry = process.argv.includes('--dry-run')
  const withWindows = !process.argv.includes('--no-windows')
  const repo = githubRepo()
  const feed = (arg('--feed') || `https://github.com/${repo}/releases/latest/download`).replace(/\/+$/, '')
  const assets = arg('--assets')?.replace(/\/+$/, '')
  if (dry && arg('--feed') && !assets) throw new Error('本机测试需要同时给 --feed 与 --assets')
  const notes = arg('--notes-file') ? readFileSync(arg('--notes-file'), 'utf-8').trim() : (arg('--notes') || '').trim()
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  const tag = `v${version}`

  // 当前版本最新的构建
  const dir = join(root, 'release')
  const builds = readdirSync(dir).map((n) => ({ n, a: parseArtifact(n) })).filter((x) => x.a && x.a.version === version)
  const build = builds.map((x) => x.a.build).sort().pop()
  if (!build) throw new Error(`release/ 里没有 ${version} 的安装包，先运行 npm run dist`)
  const zipName = `MyTypeless-${version}-${build}-arm64.zip`
  const dmgName = `MyTypeless-${version}-${build}-arm64.dmg`
  for (const n of [zipName, dmgName]) if (!existsSync(join(dir, n))) throw new Error(`缺少 release/${n}`)

  // 必须是本机证书签名的那次构建（自签名证书相同，已安装的应用才能自动替换）
  const app = join(dir, 'mac-arm64/MyTypeless.app')
  const plistBuild = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', join(app, 'Contents/Info.plist')], { encoding: 'utf-8' }).trim()
  if (plistBuild !== build) throw new Error(`release/mac-arm64 是构建 ${plistBuild}，不是 ${build}；请重新 npm run dist`)
  const req = execFileSync('codesign', ['-dr', '-', app], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!/certificate leaf/.test(req)) throw new Error('应用不是证书签名（adhoc），已安装的版本无法自动更新到它：检查 .vendor/signing/ 后重新 npm run dist')

  // 发布的版本必须对应公开的代码：打包时没有未提交改动，且那次提交已在 GitHub 的 main 上
  let sha = ''
  if (!dry) {
    const infoFile = join(dir, 'build-info.json')
    if (!existsSync(infoFile)) throw new Error('缺少 release/build-info.json：请用 npm run dist 重新打包')
    const info = JSON.parse(readFileSync(infoFile, 'utf-8'))
    if (info.build !== build) throw new Error(`release/build-info.json 是构建 ${info.build}，不是 ${build}；请重新 npm run dist`)
    if (info.dirty) throw new Error('打包时有未提交的改动：发布的版本必须对应已提交、已合并的代码，提交并合并后重新 npm run dist')
    sha = info.sha
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: root })
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root })
    } catch {
      throw new Error(`构建所用的提交 ${sha.slice(0, 7)} 还没合并到 GitHub 的 main：先合并 PR、拉取 main 后重新 npm run dist`)
    }
  }

  if (!dry) {
    const current = await publishedVersion(feed)
    if (current && compareVersions(version, current) <= 0) {
      throw new Error(`已发布 ${current}，本次 ${version} 不比它新：先升级 package.json 的 version 再打包`)
    }
    console.log(`已发布：${current ?? '（无）'} → 本次：${version}（构建 ${build}）`)
  }

  const url = (file) => (assets ? `${assets}/${version}/${file}` : githubAssetUrl(repo, version, file))
  const zipPath = join(dir, zipName)
  const feedFile = join(dir, 'latest-mac.yml')
  writeFileSync(feedFile, buildFeed({
    version,
    build,
    zipUrl: url(zipName),
    dmgUrl: url(dmgName),
    sha512: await sha512(zipPath),
    size: statSync(zipPath).size,
    notes,
    date: new Date().toISOString()
  }))
  console.log(`版本说明 → release/latest-mac.yml\n  ${url(zipName)}\n  ${url(dmgName)}\n  ${feed}/latest-mac.yml`)
  if (dry) return

  if (!process.argv.includes('--yes')) {
    const win = withWindows ? '，再由 GitHub Actions 打包 Windows 安装包传到同一个 Release' : '（--no-windows：不发 Windows 版）'
    console.log(`\n将在 https://github.com/${repo} 发布 ${tag}（提交 ${sha.slice(0, 7)}），上传以上三个文件${win}，并在 ${LEGACY_REPOS.join('、')} 同步版本说明（对外可见）。确认后加 --yes 重新运行。`)
    process.exit(1)
  }
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('缺少环境变量 GH_TOKEN：用 GH_TOKEN=$(gh auth token) 或有代码仓库与旧发布仓库 Contents 读写权限的令牌')

  const pub = await release(token, repo, {
    tag,
    sha,
    name: `MyTypeless ${version}`,
    body: `${notes}\n\n构建 ${build}`.trim(),
    files: [zipPath, join(dir, dmgName), feedFile],
    beforePublish: withWindows ? (rel) => buildWindows(token, repo, rel, { sha, tag, notes }) : null
  })
  const now = await waitForVersion(() => publishedVersion(feed), version)
  if (now !== version) throw new Error(`发布后读到的版本是 ${now}，不是 ${version}`)
  if (withWindows) {
    const w = await waitForVersion(() => publishedVersion(feed, 'latest.yml'), version)
    if (w !== version) throw new Error(`发布后读到的 Windows 版本是 ${w}，不是 ${version}`)
  }
  console.log(`已发布 ${version}（构建 ${build}）：${pub.html_url}`)

  // 旧发布仓库：只放版本说明（安装包地址指向代码仓库），让还在读旧地址的版本更新过来
  for (const legacy of LEGACY_REPOS) {
    await release(token, legacy, { tag, name: `MyTypeless ${version}`, body: `已迁移到 ${pub.html_url}\n\n${notes}`.trim(), files: [feedFile] })
    const v = await waitForVersion(() => publishedVersion(`https://github.com/${legacy}/releases/latest/download`), version)
    if (v !== version) throw new Error(`${legacy} 发布后读到的版本是 ${v}，不是 ${version}`)
    console.log(`已同步版本说明到 ${legacy}`)
  }
}

/**
 * Windows 安装包（D-036）：触发 release-windows.yml（在 GitHub 的 Windows 机器上按 sha 打包，传到草稿 rel），
 * 等它结束并核对草稿里有安装包与 latest.yml。失败时抛错，草稿保留、不转正式（重跑 npm run release 会删掉它重来）
 */
async function buildWindows(token, repo, rel, { sha, tag, notes, ref = 'main' }) {
  const since = Date.now() - 60_000
  await gh(token, 'POST', `/repos/${repo}/actions/workflows/${WIN_WORKFLOW}/dispatches`, { ref, inputs: { sha, tag, notes } })
  console.log('已触发 Windows 安装包构建（GitHub Actions，约 20～40 分钟）…')
  const title = winRunTitle(tag)
  let run = null
  for (let i = 0; i < 30 && !run; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    const list = await gh(token, 'GET', `/repos/${repo}/actions/workflows/${WIN_WORKFLOW}/runs?event=workflow_dispatch&per_page=20`)
    run = list.workflow_runs.find((x) => x.display_title === title && Date.parse(x.created_at) >= since) ?? null
  }
  if (!run) throw new Error(`没有找到 ${WIN_WORKFLOW} 的运行：确认 main 上有这个工作流、令牌有 Actions 读写权限`)
  console.log(`  ${run.html_url}`)
  const deadline = Date.now() + 90 * 60_000
  while (run.status !== 'completed') {
    if (Date.now() > deadline) throw new Error(`Windows 安装包构建超过 90 分钟还没结束：${run.html_url}`)
    await new Promise((r) => setTimeout(r, 30_000))
    run = await gh(token, 'GET', `/repos/${repo}/actions/runs/${run.id}`)
  }
  if (run.conclusion !== 'success') throw new Error(`Windows 安装包构建失败（${run.conclusion}）：${run.html_url}；草稿已保留，修好后重跑 npm run release`)
  const names = (await gh(token, 'GET', `/repos/${repo}/releases/${rel.id}/assets?per_page=100`)).map((a) => a.name)
  const exe = names.find((n) => parseWinArtifact(n)?.version === tag.slice(1))
  const zip = names.find((n) => parseWinZip(n)?.version === tag.slice(1))
  if (!exe || !zip || !names.includes('latest.yml')) throw new Error(`草稿里缺少 Windows 安装包、解压即用版或 latest.yml（现有：${names.join('、')}）`)
  console.log(`  Windows 安装包：${exe}`)
}

/** Windows 构建那次运行的标题（与 release-windows.yml 的 run-name 一致），用来找到本次触发的运行 */
function winRunTitle(tag) {
  return `Windows 安装包 ${tag}`
}

/** 上传失败后的重试间隔（毫秒）：弱网下大文件常被 GitHub 掐断（HTTP 408 Upload body timed out）；末几轮也给被掐断的上传会话时间过期（残骸资产 started → 可删） */
const UPLOAD_RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000]

/** 删掉草稿里的同名资产：上传被服务端掐断时 GitHub 会留下不完整的资产条目，重传同名会 422 already_exists。返回是否删了东西；DELETE 404（会话已回收）不算错误 */
async function deleteAssetByName(token, repo, relId, name, ghFn = gh) {
  let deleted = false
  for (const a of await ghFn(token, 'GET', `/repos/${repo}/releases/${relId}/assets?per_page=100`)) {
    if (a.name !== name) continue
    try {
      await ghFn(token, 'DELETE', `/repos/${repo}/releases/${relId}/assets/${a.id}`)
      deleted = true
    } catch (err) {
      if (!/\b404\b/.test(String(err))) throw err
    }
  }
  return deleted
}

/** 上传一个文件到草稿 Release：失败时先清理同名残骸资产（清理失败只记录，不阻塞重试），再按 UPLOAD_RETRY_MS 退避重试（ghFn / readBlob / retryMs 可注入供测试） */
async function uploadAsset(token, repo, relId, uploadBase, file, { ghFn = gh, readBlob = (f) => openAsBlob(f), retryMs = UPLOAD_RETRY_MS, log = console.log } = {}) {
  const name = basename(file)
  for (let i = 0; ; i++) {
    try {
      await ghFn(token, 'POST', `${uploadBase}?name=${encodeURIComponent(name)}`, await readBlob(file))
      return
    } catch (err) {
      if (i >= retryMs.length) throw err
      const wait = retryMs[i]
      log(`  上传 ${name} 第 ${i + 1} 次失败（${String(err.message || err).slice(0, 160)}），${Math.round(wait / 1000)}s 后重试`)
      await new Promise((r) => setTimeout(r, wait))
      try {
        await deleteAssetByName(token, repo, relId, name, ghFn)
      } catch (cleanup) {
        log(`  清理同名残骸失败（继续重试）：${String(cleanup.message || cleanup).slice(0, 120)}`)
      }
    }
  }
}

/** 建草稿 Release → 上传文件 →（beforePublish：Windows 安装包）→ 转为正式并设为最新；同版本的旧草稿（上次传到一半失败）先删掉，已正式发布的同版本不覆盖 */
async function release(token, repo, { tag, sha, name, body, files, beforePublish = null }) {
  for (const r of await gh(token, 'GET', `/repos/${repo}/releases?per_page=30`)) {
    if (r.tag_name !== tag) continue
    if (!r.draft) throw new Error(`${repo} 的 ${tag} 已经发布过：先升级 package.json 的 version`)
    await gh(token, 'DELETE', `/repos/${repo}/releases/${r.id}`)
  }
  const rel = await gh(token, 'POST', `/repos/${repo}/releases`, { tag_name: tag, ...(sha ? { target_commitish: sha } : {}), name, body, draft: true })
  const uploadBase = rel.upload_url.replace(/\{.*\}$/, '')
  for (const file of files) {
    console.log(`上传 ${basename(file)} → ${repo}…`)
    await uploadAsset(token, repo, rel.id, uploadBase, file)
  }
  if (beforePublish) await beforePublish(rel)
  return gh(token, 'PATCH', `/repos/${repo}/releases/${rel.id}`, { draft: false, make_latest: 'true' })
}

module.exports = { compareVersions, parseArtifact, parseWinArtifact, parseWinZip, buildFeed, githubAssetUrl, waitForVersion, winRunTitle, githubRepo, sha512, gh, buildWindows, uploadAsset, deleteAssetByName }

if (require.main === module) {
  // 终端设了代理（HTTPS_PROXY）时 Node 的 fetch 默认不走代理，大文件直连 GitHub 会传到一半断开：带上 NODE_USE_ENV_PROXY 重新运行自己
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
    const r = require('child_process').spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
    process.exit(r.status ?? 1)
  }
  main().catch((err) => {
    console.error(String(err?.message ?? err))
    process.exit(1)
  })
}
