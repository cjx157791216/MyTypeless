#!/usr/bin/env node
/**
 * 打包（npm run dist）：生成本次的构建号，依次编译代码与原生助手、准备签名证书、调用 electron-builder。
 * - 版本号：package.json 的 version（发布新版本时手动升级）
 * - 构建号：打包时的本地时间 YYYYMMDD.HHmm，写进应用（关于、主窗口、托盘）、CFBundleVersion 与安装包文件名
 * - 提交：git 短哈希（有未提交改动时加 -dirty），显示在应用的“关于”里，便于对照代码
 * 产物：release/MyTypeless-<版本>-<构建号>-arm64.dmg / -mac.zip
 */
const { execSync } = require('child_process')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const build = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`
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
run('npm run build')
run('npm run native')
run('npm run whisper')
run('npm run diarize')
run('bash scripts/setup-signing.sh')
run(`npx electron-builder --mac --publish never -c.buildVersion=${build}`)
// 发布（npm run release）据此核对：发布的版本必须对应已合并到 GitHub main、没有未提交改动的提交
writeFileSync(join(root, 'release/build-info.json'), JSON.stringify({ version, build, sha, dirty }, null, 2) + '\n')
console.log(`→ release/MyTypeless-${version}-${build}-arm64.dmg`)
