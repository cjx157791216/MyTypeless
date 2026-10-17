import { app } from 'electron'
import { join } from 'path'
import type { Settings } from '../../shared/types'
import { LocalWhisperAsr, type AsrProvider } from '../providers/asr'
import { convertChineseScript } from '../native'
import { SherpaHelper } from '../sherpa-helper'
import { findModel, hasHan, recommendedModelId, resolveLanguage, resolveScript } from './catalog'
import { fixAsrCase, normalizeChinesePunctuation, stripAsrTokens } from '../text'
import { WhisperEngine } from './engine'
import { ModelManager } from './models'

/**
 * 内置本地识别（D-009）：随包的引擎 + 用户下载的模型。
 * - whisper 模型：mt-whisper（whisper.cpp，GPU）
 * - FireRedASR2（中文默认，D-027）：mt-diarize（sherpa-onnx，CPU 4 线程），带标点模型；常驻 10 分钟以保持低延迟
 */

export const whisperEngine = new WhisperEngine()
export const modelManager = new ModelManager()

let fireredDir: string | null = null // 当前要加载的 FireRedASR2 模型目录（启动进程时读取）
export const fireredEngine = new SherpaHelper({
  args: () => (fireredDir ? ['--firered', fireredDir, '--punct', join(fireredDir, 'punct.int8.onnx'), '--threads', '4'] : null),
  idleMs: 10 * 60_000,
  nice: 0
})

/** 识别语言（设置为“跟随系统”时按系统首选语言） */
export function asrLanguage(settings: Settings): string {
  return resolveLanguage(settings.asr.language, app.getPreferredSystemLanguages())
}

export function selectedModelId(settings: Settings): string {
  const id = settings.asr.builtinModel
  return id && findModel(id) ? id : recommendedModelId(asrLanguage(settings))
}

/** 所选模型由哪个引擎运行 */
export function selectedEngine(settings: Settings): 'whisper' | 'firered' {
  return findModel(selectedModelId(settings))?.engine ?? 'whisper'
}

/** 选中的模型是否已下载 */
export function builtinReady(settings: Settings): boolean {
  return modelManager.isInstalled(selectedModelId(settings))
}

/** 开口时预热引擎（模型未下载时不做任何事） */
export function prewarmBuiltin(settings: Settings): void {
  const path = modelManager.installedPath(selectedModelId(settings))
  if (!path) return
  if (selectedEngine(settings) === 'firered') useFireRed(path).warm()
  else void whisperEngine.ensureRunning(path).catch(() => undefined)
}

/** 切换到这个 FireRedASR2 目录（换了模型目录时重启进程） */
function useFireRed(dir: string): SherpaHelper {
  if (fireredDir !== dir) {
    fireredEngine.stop()
    fireredDir = dir
  }
  return fireredEngine
}

/** WAV（pcm16ToWav 生成的标准 44 字节头）→ PCM */
function wavToPcm(wav: Buffer): Int16Array {
  const i = wav.indexOf('data')
  const start = i >= 0 ? i + 8 : 44
  const body = wav.subarray(start, start + ((wav.length - start) & ~1))
  return new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length))
}

export function createBuiltinAsr(settings: Settings): AsrProvider {
  const path = modelManager.installedPath(selectedModelId(settings))
  if (!path) throw new Error('LOCAL_MODEL_MISSING')
  const systemLanguages = app.getPreferredSystemLanguages()
  const script = resolveScript(settings.asr.chineseScript, systemLanguages)
  if (selectedEngine(settings) === 'firered') {
    const engine = useFireRed(path)
    return {
      async transcribe(wav, opts) {
        const raw = await engine.transcribe(wavToPcm(wav))
        if (raw === null) throw new Error('LOCAL_ASR_FAILED')
        // FireRedASR2 的英文全大写、不支持热词：按词典与常见缩写恢复大小写（D-027）
        let text = fixAsrCase(stripAsrTokens(raw), opts?.vocabulary ?? [])
        if (hasHan(text)) {
          if (script !== 'off') text = await convertChineseScript(text, script)
          text = normalizeChinesePunctuation(text)
        }
        return { text }
      }
    }
  }
  const language = resolveLanguage(settings.asr.language, systemLanguages)
  const inner = new LocalWhisperAsr(async () => {
    const base = await whisperEngine.ensureRunning(path)
    whisperEngine.touch()
    return base
  }, language)
  return {
    async transcribe(wav, opts) {
      const res = await inner.transcribe(wav, opts)
      whisperEngine.touch()
      if (hasHan(res.text)) {
        if (script !== 'off') res.text = await convertChineseScript(res.text, script)
        res.text = normalizeChinesePunctuation(res.text)
      }
      return res
    }
  }
}
