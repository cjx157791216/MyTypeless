#!/usr/bin/env node
/**
 * 打包（npm run dist）：生成本次的构建号，依次编译代码与原生助手、准备签名证书、调用 electron-builder。
 * - 版本号：package.json 的 version（发布新版本时手动升级）
 * - 构建号：打包时间（北京时间）YYYYMMDD.HHmm，写进应用（关于、主窗口、托盘）、CFBundleVersion 与安装包文件名
 * - 提交：git 短哈希（有未提交改动时加 -dirty），显示在应用的“关于”里，便于对照代码
 * 产物：macOS release/MyTypeless-<版本>-<构建号>-arm64.dmg / .zip；Windows release/MyTypeless-<版本>-<构建号>-win-x64.exe（D-036）
 */
const { execFileSync, execSync } = require('child_process')
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const pad = (n) => String(n).padStart(2, '0')
// 构建号一律按北京时间（UTC+8，与发布者 Mac 的时间一致）：Windows 包在 GitHub 的机器（UTC）上打，各地贡献者的时区也不同
const BUILD_UTC_OFFSET_HOURS = 8
const now = new Date(Date.now() + BUILD_UTC_OFFSET_HOURS * 3600_000)
// 分钟尾 0 必须避开：electron-builder 写 Info.plist 时把 buildVersion 当数字，"…2250" 会变成 "…225"，
// 发布脚本的 plist 校验即失败（0.3.11 首次发布实测）；分钟 +1 退出这个坑
let minute = now.getUTCMinutes()
if (minute % 10 === 0) minute += 1
const build = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}.${pad(now.getUTCHours())}${pad(minute)}`
let commit = 'unknown'
let sha = ''
let dirty = false
try {
  sha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim()
  commit = sha.slice(0, 7)
  dirty = !!execSync('git status --porcelain', { cwd: root, encoding: 'utf-8' }).trim()
  if (dirty) commit += '-dirty'
} catch {
  /* 不是 git 仓库 */
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
const env = { ...process.env, MT_BUILD: build, MT_COMMIT: commit, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
console.log(`MyTypeless ${version} 构建 ${build}（${commit}）`)

const run = (cmd) => execSync(cmd, { cwd: root, env, stdio: 'inherit' })

// 与 electron-builder 自己下载（校验过 sha512）的那份逐字节相同
const WIN_CODE_SIGN_SHA256 = 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4'
/**
 * electron-builder 给 exe 写图标和版本信息要用 winCodeSign 工具包，但包里有 macOS 的符号链接：没开“开发者模式”的
 * 普通用户解压时报错，打包中止。预先解压到它的缓存目录（跳过用不到的 darwin 目录），electron-builder 见到就直接用
 */
function prepareWinCodeSign() {
  const cache = process.env.ELECTRON_BUILDER_CACHE || join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache')
  const dir = join(cache, 'winCodeSign', 'winCodeSign-2.6.0')
  if (existsSync(join(dir, 'rcedit-x64.exe'))) return
  const archive = join(cache, 'winCodeSign', 'winCodeSign-2.6.0.7z')
  mkdirSync(join(cache, 'winCodeSign'), { recursive: true })
  run(`curl -fL --retry 3 -o "${archive}" https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z`)
  const sha = require('crypto').createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (sha !== WIN_CODE_SIGN_SHA256) {
    rmSync(archive, { force: true })
    throw new Error(`winCodeSign-2.6.0.7z 的 SHA256 不符：期望 ${WIN_CODE_SIGN_SHA256}，实际 ${sha}`)
  }
  execFileSync(require('7zip-bin').path7za, ['x', '-y', '-bd', `-o${dir}`, '-xr!darwin', archive], { stdio: 'inherit' })
  rmSync(archive, { force: true })
}

const win = process.platform === 'win32'
run('npm run build')
if (win) {
  // Windows（D-036）：没有代码签名证书，不签名
  run('npm run native:win')
  run('npm run diarize:win')
  run('npm run whisper:win')
  prepareWinCodeSign()
  // 不传 buildVersion：Windows 的文件版本每段最大 65535，构建号 YYYYMMDD 放不下（构建号已由 MT_BUILD 写进应用与文件名）
  run('npx electron-builder --win --x64 --publish never')
} else {
  run('npm run native')
  run('npm run whisper')
  run('npm run diarize')
  run('bash scripts/setup-signing.sh')
  run(`npx electron-builder --mac --publish never -c.buildVersion=${build}`)
}
// 发布（npm run release）据此核对：发布的版本必须对应已合并到 GitHub main、没有未提交改动的提交
writeFileSync(join(root, 'release/build-info.json'), JSON.stringify({ version, build, sha, dirty }, null, 2) + '\n')
console.log(`→ release/MyTypeless-${version}-${build}-${win ? 'win-x64.exe / .zip' : 'arm64.dmg'}`)
