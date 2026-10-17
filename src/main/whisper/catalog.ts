/**
 * 内置本地识别可下载的模型目录（纯数据与纯函数，不依赖 electron，便于测试）。
 * 模型不随安装包分发，首次使用时下载到 userData/models/（D-009）。
 * - whisper：whisper.cpp 单文件模型，由 mt-whisper 运行；大小与 SHA256 取自 huggingface.co/ggerganov/whisper.cpp 的 LFS 元数据
 * - firered：FireRedASR2 AED（中英文）+ CT-Transformer 标点，由 mt-diarize（sherpa-onnx）运行，多个文件放在 models/<id>/（D-027）
 */

export interface ModelFile {
  name: string // 本地文件名
  repo: string // Hugging Face 仓库
  remote: string // 仓库里的文件名
  sizeBytes: number
  sha256: string
}

export interface ModelSpec {
  id: string
  engine: 'whisper' | 'firered'
  file: string // whisper：模型文件名；firered：目录名
  files?: ModelFile[] // firered：目录里的各个文件
  label: string
  description: string
  sizeBytes: number // 合计
  sha256: string // whisper 单文件的校验值（多文件模型见 files）
  languages?: string[] // 只支持这些识别语言（不填 = 多语种）
}

const FIRERED_REPO = 'csukuangfj2/sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26'
// 标点模型：sherpa-onnx 官方发布包 punctuation-models/…-int8.tar.bz2 中的 model.int8.onnx（Hugging Face 上的副本与之逐字节相同，按官方 SHA256 校验）
const PUNCT_REPO = 'lorneluo/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8'
const FIRERED_FILES: ModelFile[] = [
  { name: 'encoder.int8.onnx', repo: FIRERED_REPO, remote: 'encoder.int8.onnx', sizeBytes: 817_286_833, sha256: '54048d66b6e8f3c80ea7ce95efe794587b0fd81d7271651d0decd3803852ae82' },
  { name: 'decoder.int8.onnx', repo: FIRERED_REPO, remote: 'decoder.int8.onnx', sizeBytes: 417_291_928, sha256: 'b840ce7196ae4a14d05ae84bbf56082b6b61ccec5610fda907dddbcea37354ff' },
  { name: 'tokens.txt', repo: FIRERED_REPO, remote: 'tokens.txt', sizeBytes: 79_172, sha256: '1bc613de2112d257e61a349c3e72d1b1a9cf19c33d3ca954197ad2171e5ea07b' },
  { name: 'punct.int8.onnx', repo: PUNCT_REPO, remote: 'model.int8.onnx', sizeBytes: 75_519_198, sha256: '65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1' }
]

export const MODELS: ModelSpec[] = [
  {
    id: 'firered2-aed-int8',
    engine: 'firered',
    file: 'firered2-aed-int8',
    files: FIRERED_FILES,
    label: '中文高精度',
    description:
      'FireRedASR2：中文与中英混说最准（真实会议录音错字约为 Whisper 的 1/3），自动加标点；只支持中文和英文；M2 Pro 上约 1～2 秒识别一句话',
    sizeBytes: FIRERED_FILES.reduce((n, f) => n + f.sizeBytes, 0),
    sha256: '',
    languages: ['zh', 'en']
  },
  {
    id: 'large-v3-turbo-q5_0',
    engine: 'whisper',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    label: '多语种',
    description: 'Whisper large-v3-turbo 量化版：支持日语、韩语等多种语言；中文错字较多（真实会议录音约 18%）；M2 Pro 上约 1 秒识别一句话',
    sizeBytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  },
  {
    id: 'small-q5_1',
    engine: 'whisper',
    file: 'ggml-small-q5_1.bin',
    label: '轻量',
    description: 'small 量化版：体积小、速度快，但中文错字较多且常输出繁体（会自动转换）',
    sizeBytes: 190_085_487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
  }
]

/** 按识别语言推荐模型：中文、英文（及自动）用 FireRedASR2，其他语言用 Whisper（D-027） */
export function recommendedModelId(language: string): string {
  return language === 'zh' || language === 'en' || language === 'auto' ? 'firered2-aed-int8' : 'large-v3-turbo-q5_0'
}

/** 下载源：官方优先，访问不了时自动换国内镜像 */
export const MODEL_SOURCES = ['https://huggingface.co', 'https://hf-mirror.com']

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id)
}

export function modelUrls(spec: ModelSpec): string[] {
  return MODEL_SOURCES.map((base) => `${base}/ggerganov/whisper.cpp/resolve/main/${spec.file}`)
}

export function fileUrls(f: ModelFile): string[] {
  return MODEL_SOURCES.map((base) => `${base}/${f.repo}/resolve/main/${f.remote}`)
}

/**
 * 识别语言：显式语言让 whisper 跳过一次单独的语言检测（编码器少跑一遍，耗时约减半），
 * 中文模式下英文语音与中英混说仍能正确识别。
 * 'system' → 系统首选语言是中文则 'zh'，否则 'auto'。
 */
export function resolveLanguage(setting: string | undefined, systemLanguages: string[]): string {
  if (setting && setting !== 'system') return setting
  const first = (systemLanguages[0] ?? '').toLowerCase()
  if (first.startsWith('zh')) return 'zh'
  if (first.startsWith('ja')) return 'ja'
  if (first.startsWith('ko')) return 'ko'
  return 'auto'
}

/** 中文输出字形：'system' → 系统首选繁体（zh-Hant / zh-TW / zh-HK / zh-MO）时 'hant'，否则 'hans' */
export function resolveScript(setting: string | undefined, systemLanguages: string[]): 'hans' | 'hant' | 'off' {
  if (setting === 'hans' || setting === 'hant' || setting === 'off') return setting
  const first = (systemLanguages[0] ?? '').toLowerCase()
  return /^zh-(hant|tw|hk|mo)/.test(first) ? 'hant' : 'hans'
}

export function hasHan(text: string): boolean {
  return /\p{Script=Han}/u.test(text)
}
