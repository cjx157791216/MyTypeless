// Windows 编译脚本共用：找 CMake（PATH 里有就用，否则用 Visual Studio 2022 生成工具自带的）
const { execFileSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

function findCmake() {
  try {
    execFileSync('cmake', ['--version'], { stdio: 'ignore' })
    return 'cmake'
  } catch {
    /* 不在 PATH 里：找 Visual Studio 自带的 */
  }
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (existsSync(vswhere)) {
    const found = execFileSync(vswhere, ['-latest', '-products', '*', '-find', 'Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe'], { encoding: 'utf-8' })
      .split(/\r?\n/)
      .find(Boolean)
    if (found) return found
  }
  console.error('找不到 cmake：请安装 Visual Studio 2022 生成工具（使用 C++ 的桌面开发），或把 cmake 加入 PATH')
  process.exit(1)
}

module.exports = { findCmake }
