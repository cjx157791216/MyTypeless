#!/usr/bin/env node
/**
 * 编译 Windows 原生助手（npm run native:win，GAP-008）：native/win/*.cpp → native/bin/mt-*.exe。
 * --diarize（npm run diarize:win）：另外编译 mt-diarize.exe（native/diarize-helper.c，与 macOS 同一份源码），
 *   首次下载 sherpa-onnx 的 Windows 静态库（约 120MB，GitHub Releases）到 .vendor/sherpa-onnx-win/；
 *   网络慢时可手动下载 SHERPA_PKG 后解压到该目录（需含 include/ 与 lib/）。
 * 需要 Visual Studio 2022 生成工具（“使用 C++ 的桌面开发”，自带 CMake）；PATH 里有 cmake 时优先用它。
 */
const { execFileSync } = require('child_process')
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } = require('fs')
const os = require('os')
const { createHash } = require('crypto')
const { join } = require('path')
const { findCmake } = require('./win-cmake.cjs')

if (process.platform !== 'win32') {
  console.error('只用于 Windows；macOS 用 npm run native')
  process.exit(1)
}

const root = join(__dirname, '..')
const src = join(root, 'native', 'win')
const build = join(root, '.vendor', 'native-win-build')
const out = join(root, 'native', 'bin')
const HELPERS = ['mt-text', 'mt-focus', 'mt-inject', 'mt-hotkey', 'mt-audiotap']
// 与 scripts/build-diarize.sh 的 SHERPA_VERSION 保持一致
const SHERPA_VERSION = 'v1.13.8'
const SHERPA_PKG = `sherpa-onnx-${SHERPA_VERSION}-win-x64-static-MT-Release-no-tts-lib`
// 下载内容的 SHA256（换版本时一起更新）：静态库包取 GitHub Release 资源的官方摘要；c-api.h 为该 tag 的源码文件
const SHERPA_SHA256 = 'f0aa074ddc39553b30208b53e84c12275d09702911c9faa8d34fa932428e4641'
const C_API_SHA256 = '2a1b95084be8fd1deb3228fcad2fd3f7f0258b64582f7402281ec174c7b7f4ce'
const sherpaDir = join(root, '.vendor', 'sherpa-onnx-win')
const withDiarize = process.argv.includes('--diarize')
if (withDiarize) {
  ensureSherpa()
  HELPERS.push('mt-diarize')
}

const cmake = findCmake()
const run = (args) => execFileSync(cmake, args, { stdio: 'inherit' })
run(['-S', src, '-B', build, '-A', 'x64', `-DSHERPA_DIR=${withDiarize ? sherpaDir.replace(/\\/g, '/') : ''}`])
run(['--build', build, '--config', 'Release', '--parallel'])

mkdirSync(out, { recursive: true })
// 上次替换时改名留下的旧文件：已经没有进程在用的就删掉
for (const f of readdirSync(out)) {
  if (!/\.old-\d+\.exe$/.test(f)) continue
  try {
    rmSync(join(out, f))
  } catch {
    /* 仍在运行，删不掉：下次再删 */
  }
}
for (const name of HELPERS) {
  const dest = join(out, `${name}.exe`)
  try {
    copyFileSync(join(build, 'Release', `${name}.exe`), dest)
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err
    // 应用开着、助手正在运行：Windows 不能覆盖运行中的程序，但可以改名——挪开旧的再放新的（重启助手后生效）
    renameSync(dest, join(out, `${name}.old-${Date.now()}.exe`))
    copyFileSync(join(build, 'Release', `${name}.exe`), dest)
    console.warn(`${name}.exe 正在运行，旧文件已改名挪开；重启应用后用上新版本`)
  }
  console.log(`${name}.exe → ${dest}`)
}

function ensureSherpa() {
  const stamp = join(sherpaDir, 'VERSION')
  if (existsSync(stamp) && readFileSync(stamp, 'utf-8').trim() === SHERPA_VERSION) return
  const tmp = mkdtempSync(join(os.tmpdir(), 'mt-sherpa-'))
  const pkg = join(tmp, 'pkg.tar.bz2')
  console.log(`下载 ${SHERPA_PKG}（约 120MB）…`)
  execFileSync('curl', ['-fL', '--retry', '5', '-o', pkg, `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VERSION}/${SHERPA_PKG}.tar.bz2`], { stdio: 'inherit' })
  verifySha256(pkg, SHERPA_SHA256, tmp)
  execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xjf', pkg, '-C', tmp], { stdio: 'inherit' })
  rmSync(sherpaDir, { recursive: true, force: true })
  mkdirSync(sherpaDir, { recursive: true })
  cpSync(join(tmp, SHERPA_PKG, 'lib'), join(sherpaDir, 'lib'), { recursive: true })
  // -lib 包不带头文件：C API 只有一个头文件（只依赖 stdint.h），按同一版本标签从源码取
  const header = join(sherpaDir, 'include', 'sherpa-onnx', 'c-api', 'c-api.h')
  mkdirSync(join(header, '..'), { recursive: true })
  execFileSync('curl', ['-fsSL', '--retry', '5', '-o', header, `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/${SHERPA_VERSION}/sherpa-onnx/c-api/c-api.h`], { stdio: 'inherit' })
  verifySha256(header, C_API_SHA256, sherpaDir)
  writeFileSync(stamp, SHERPA_VERSION + '\n')
  rmSync(tmp, { recursive: true, force: true })
}

/** 下载的文件与登记的 SHA256 不符：删掉 cleanup 目录（下次重新下载）并中止，不拿来编译 */
function verifySha256(file, expected, cleanup) {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual === expected) return
  rmSync(cleanup, { recursive: true, force: true })
  throw new Error(`${file} 的 SHA256 不符：期望 ${expected}，实际 ${actual}`)
}
