#!/usr/bin/env node
/**
 * 编译 Windows 版内置识别引擎（npm run whisper:win，GAP-008）：whisper.cpp（MIT）的 whisper-server，
 * 与 scripts/build-whisper.sh 同一版本源码；静态链接（含 C/C++ 运行库），产物 native/bin/mt-whisper.exe 只依赖系统 DLL。
 * 只用 CPU：开 AVX2 / FMA / F16C（2013 年以后的 x64 处理器都有；Vulkan 需要另装 SDK，暂不做）。
 * 需要：git、Visual Studio 2022 生成工具（自带 CMake）。已编译同版本则跳过（--force 重新编译）。
 */
const { execFileSync } = require('child_process')
const { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('fs')
const { join } = require('path')

if (process.platform !== 'win32') {
  console.error('只用于 Windows；macOS 用 npm run whisper')
  process.exit(1)
}

// 与 scripts/build-whisper.sh 的 WHISPER_VERSION 保持一致
const WHISPER_VERSION = 'v1.9.5'
const root = join(__dirname, '..')
const src = join(root, '.vendor', 'whisper.cpp')
const build = join(src, 'build-mt-win')
const out = join(root, 'native', 'bin')
const dest = join(out, 'mt-whisper.exe')
const stamp = join(out, '.mt-whisper-win-version')

if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, 'utf-8').trim() === WHISPER_VERSION && !process.argv.includes('--force')) {
  console.log(`mt-whisper.exe ${WHISPER_VERSION} 已存在（--force 重新编译）`)
  process.exit(0)
}

const git = (args) => execFileSync('git', args, { stdio: 'inherit' })
if (!existsSync(join(src, '.git'))) {
  git(['clone', '--depth', '1', '--branch', WHISPER_VERSION, 'https://github.com/ggml-org/whisper.cpp.git', src])
} else {
  git(['-C', src, 'fetch', '--depth', '1', 'origin', 'tag', WHISPER_VERSION])
  git(['-C', src, 'checkout', '-q', WHISPER_VERSION])
}

const cmake = require('./win-cmake.cjs').findCmake()
const run = (args) => execFileSync(cmake, args, { stdio: 'inherit' })
run([
  '-S', src, '-B', build, '-A', 'x64',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
  '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF'
])
run(['--build', build, '--config', 'Release', '--target', 'whisper-server', '--parallel'])

mkdirSync(out, { recursive: true })
const built = join(build, 'bin', 'Release', 'whisper-server.exe')
try {
  copyFileSync(built, dest)
} catch (err) {
  if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err
  // 识别引擎正在运行：挪开旧文件再放新的（重启引擎后生效）
  renameSync(dest, join(out, `mt-whisper.old-${Date.now()}.exe`))
  copyFileSync(built, dest)
}
writeFileSync(stamp, WHISPER_VERSION + '\n')
console.log(`mt-whisper.exe ${WHISPER_VERSION} → ${dest}`)
