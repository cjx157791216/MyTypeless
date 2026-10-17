// 在线更新的纯逻辑（D-028）：发布地址、错误提示。不依赖 electron，供 test/ 导入

/** 发布仓库：代码仓库本身的 Releases（D-032）。0.2.1 读取的旧发布仓库见 scripts/publish.cjs 的 LEGACY_REPOS */
export const GITHUB_REPO = 'cjx157791216/MyTypeless'

/**
 * 默认发布地址：最新正式 Release 的下载目录（GitHub 跳转到 releases/download/v<版本>/），不用登录即可读取。
 * 其中 latest-mac.yml 是版本说明，安装包在同一个 Release 里；由 scripts/publish.cjs 发布。
 */
export const DEFAULT_UPDATE_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download`

/** 下载缓存目录名（~/Library/Caches/<名>/pending/），与 electron-builder.yml 的 publish.updaterCacheDirName 一致 */
export const UPDATER_CACHE_DIR = 'mytypeless-updater'

/** 启动后首次检查的延迟与之后的检查间隔 */
export const UPDATE_FIRST_CHECK_MS = 60_000
export const UPDATE_INTERVAL_MS = 6 * 3600_000

/** 发布地址：环境变量 MT_UPDATE_URL（只用于本机测试）优先 */
export function updateUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.MT_UPDATE_URL || DEFAULT_UPDATE_URL).replace(/\/+$/, '')
}

/** "0.2.10" > "0.2.9"：只比较数字部分 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** 缓存里的安装包已装上（版本不比当前新）：可以删掉（约 110MB）。fileName 形如 MyTypeless-0.2.2-20261017.1017-arm64.zip */
export function pendingIsInstalled(fileName: string, current: string): boolean {
  const v = /^MyTypeless-(\d+\.\d+\.\d+)-/.exec(fileName)?.[1]
  return !!v && compareVersions(v, current) <= 0
}

/** electron-updater / Squirrel 的错误 → 给用户看的一句话 */
export function friendlyUpdateError(message: string): string {
  const m = message || ''
  if (/\b(401|403)\b/.test(m)) return '发布地址拒绝访问（发布仓库需设为公开）'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|timeout|socket hang up/i.test(m)) {
    return '连不上发布地址，请检查网络后重试'
  }
  if (/\b404\b|Cannot find channel/i.test(m)) return '发布地址上还没有版本信息'
  if (/sha512 checksum mismatch|checksum/i.test(m)) return '下载的安装包校验不一致，请重试'
  if (/code signature|did not pass validation|not signed|designated requirement/i.test(m)) {
    return '新版本的签名与当前应用不一致，无法自动安装，请下载安装包手动安装'
  }
  if (/read-only|translocat|Volumes\//i.test(m)) return '应用不在「应用程序」文件夹里，无法自动安装：请把 MyTypeless 拖到「应用程序」后重新打开'
  if (/cancel/i.test(m)) return '已取消'
  return '更新失败：' + m.split('\n')[0].slice(0, 160)
}

/** 自动安装失败、需要改为手动下载安装包的错误 */
export function needsManualInstall(message: string): boolean {
  return /code signature|did not pass validation|not signed|designated requirement/i.test(message || '')
}
