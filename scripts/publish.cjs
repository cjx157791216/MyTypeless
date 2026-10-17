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

/** GitHub Release 里某个文件的下载地址 */
function githubAssetUrl(repo, version, file) {
  return `https://github.com/${repo}/releases/download/v${version}/${file}`
}

/** 版本说明（electron-updater generic 格式 + build、dmgUrl） */
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
    dmgUrl
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

/** 匿名读取已发布的版本说明（与已安装的应用读法相同）→ 版本号；还没有发布过为 null */
async function publishedVersion(feed) {
  const r = await fetch(`${feed}/latest-mac.yml`, { signal: AbortSignal.timeout(30_000) })
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
    console.log(`\n将在 https://github.com/${repo} 发布 ${tag}（提交 ${sha.slice(0, 7)}），上传以上三个文件，并在 ${LEGACY_REPOS.join('、')} 同步版本说明（对外可见）。确认后加 --yes 重新运行。`)
    process.exit(1)
  }
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('缺少环境变量 GH_TOKEN：用 GH_TOKEN=$(gh auth token) 或有代码仓库与旧发布仓库 Contents 读写权限的令牌')

  const pub = await release(token, repo, { tag, sha, name: `MyTypeless ${version}`, body: `${notes}\n\n构建 ${build}`.trim(), files: [zipPath, join(dir, dmgName), feedFile] })
  const now = await waitForVersion(() => publishedVersion(feed), version)
  if (now !== version) throw new Error(`发布后读到的版本是 ${now}，不是 ${version}`)
  console.log(`已发布 ${version}（构建 ${build}）：${pub.html_url}`)

  // 旧发布仓库：只放版本说明（安装包地址指向代码仓库），让还在读旧地址的版本更新过来
  for (const legacy of LEGACY_REPOS) {
    await release(token, legacy, { tag, name: `MyTypeless ${version}`, body: `已迁移到 ${pub.html_url}\n\n${notes}`.trim(), files: [feedFile] })
    const v = await waitForVersion(() => publishedVersion(`https://github.com/${legacy}/releases/latest/download`), version)
    if (v !== version) throw new Error(`${legacy} 发布后读到的版本是 ${v}，不是 ${version}`)
    console.log(`已同步版本说明到 ${legacy}`)
  }
}

/** 建草稿 Release → 上传文件 → 转为正式并设为最新；同版本的旧草稿（上次传到一半失败）先删掉，已正式发布的同版本不覆盖 */
async function release(token, repo, { tag, sha, name, body, files }) {
  for (const r of await gh(token, 'GET', `/repos/${repo}/releases?per_page=30`)) {
    if (r.tag_name !== tag) continue
    if (!r.draft) throw new Error(`${repo} 的 ${tag} 已经发布过：先升级 package.json 的 version`)
    await gh(token, 'DELETE', `/repos/${repo}/releases/${r.id}`)
  }
  const rel = await gh(token, 'POST', `/repos/${repo}/releases`, { tag_name: tag, ...(sha ? { target_commitish: sha } : {}), name, body, draft: true })
  const uploadBase = rel.upload_url.replace(/\{.*\}$/, '')
  for (const file of files) {
    console.log(`上传 ${basename(file)} → ${repo}…`)
    await gh(token, 'POST', `${uploadBase}?name=${encodeURIComponent(basename(file))}`, await openAsBlob(file))
  }
  return gh(token, 'PATCH', `/repos/${repo}/releases/${rel.id}`, { draft: false, make_latest: 'true' })
}

module.exports = { compareVersions, parseArtifact, buildFeed, githubAssetUrl, waitForVersion }

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
