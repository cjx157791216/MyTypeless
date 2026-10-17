import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { ModelInfo, ModelProgress } from '../../shared/types'
import { MODELS, fileUrls, findModel, modelUrls, recommendedModelId, type ModelSpec } from './catalog'
import { DownloadError, downloadFile } from './download'

/**
 * 内置引擎的模型管理：模型存放在 userData/models/（不随安装包分发，D-009）。
 * 单文件模型（whisper）直接放在该目录；多文件模型（firered，D-027）放在 models/<id>/，所有文件齐全才算已安装。
 */

export class ModelManager {
  private active = new Map<string, AbortController>()
  private listeners = new Set<(p: ModelProgress) => void>()

  dir(): string {
    return join(app.getPath('userData'), 'models')
  }

  pathOf(spec: ModelSpec): string {
    return join(this.dir(), spec.file)
  }

  /** 已安装且大小正确（下载完成才会改名为正式文件，校验在下载时完成） */
  isInstalled(id: string): boolean {
    const spec = findModel(id)
    if (!spec) return false
    const p = this.pathOf(spec)
    if (spec.files) return spec.files.every((f) => this.fileOk(join(p, f.name), f.sizeBytes))
    return this.fileOk(p, spec.sizeBytes)
  }

  private fileOk(p: string, size: number): boolean {
    return existsSync(p) && statSync(p).size === size
  }

  /** 已安装模型的路径；未安装返回 null */
  installedPath(id: string): string | null {
    const spec = findModel(id)
    return spec && this.isInstalled(id) ? this.pathOf(spec) : null
  }

  isDownloading(id: string): boolean {
    return this.active.has(id)
  }

  /** @param language 识别语言（resolveLanguage 的结果），决定推荐哪个模型 */
  list(language: string): ModelInfo[] {
    const recommended = recommendedModelId(language)
    return MODELS.map((m) => ({
      id: m.id,
      label: m.id === recommended ? `${m.label}（推荐）` : m.label,
      description: m.description,
      sizeBytes: m.sizeBytes,
      recommended: m.id === recommended,
      installed: this.isInstalled(m.id)
    }))
  }

  onProgress(listener: (p: ModelProgress) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 开始下载（已在下载或已安装时直接返回）；进度与结果通过 onProgress 推送 */
  download(id: string): void {
    const spec = findModel(id)
    if (!spec || this.active.has(id) || this.isInstalled(id)) return
    const ctrl = new AbortController()
    this.active.set(id, ctrl)
    const emit = (p: Omit<ModelProgress, 'id'>) => this.listeners.forEach((l) => l({ id, ...p }))
    emit({ state: 'downloading', receivedBytes: 0, totalBytes: spec.sizeBytes })

    // 多文件模型逐个下载（各自断点续传与校验），进度按合计字节
    const parts = spec.files
      ? spec.files.map((f) => ({ urls: fileUrls(f), dest: join(this.pathOf(spec), f.name), sizeBytes: f.sizeBytes, sha256: f.sha256 }))
      : [{ urls: modelUrls(spec), dest: this.pathOf(spec), sizeBytes: spec.sizeBytes, sha256: spec.sha256 }]
    if (spec.files) mkdirSync(this.pathOf(spec), { recursive: true })
    const run = async () => {
      let done = 0
      for (const part of parts) {
        if (this.fileOk(part.dest, part.sizeBytes)) {
          done += part.sizeBytes
          continue
        }
        await downloadFile({
          ...part,
          signal: ctrl.signal,
          onProgress: (p) =>
            emit({
              state: p.phase === 'verifying' ? 'verifying' : 'downloading',
              receivedBytes: done + p.receivedBytes,
              totalBytes: spec.sizeBytes,
              bytesPerSec: p.bytesPerSec
            })
        })
        done += part.sizeBytes
      }
    }
    run()
      .then(() => emit({ state: 'done', receivedBytes: spec.sizeBytes, totalBytes: spec.sizeBytes }))
      .catch((err) => {
        const cancelled = err instanceof DownloadError && err.code === 'ABORTED'
        emit({
          state: cancelled ? 'cancelled' : 'error',
          receivedBytes: 0,
          totalBytes: spec.sizeBytes,
          error: cancelled ? undefined : err instanceof Error ? err.message : String(err)
        })
      })
      .finally(() => this.active.delete(id))
  }

  cancel(id: string): void {
    this.active.get(id)?.abort()
  }

  /** 删除模型（含未完成的 .part）；调用方负责先停掉正在使用它的引擎 */
  remove(id: string): void {
    const spec = findModel(id)
    if (!spec) return
    this.cancel(id)
    if (spec.files) {
      rmSync(this.pathOf(spec), { recursive: true, force: true })
      return
    }
    for (const p of [this.pathOf(spec), `${this.pathOf(spec)}.part`]) {
      if (existsSync(p)) unlinkSync(p)
    }
  }
}
