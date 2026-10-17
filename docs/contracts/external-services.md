# 外部服务契约（ASR / LLM）

所有外部服务由用户自行配置（BYOK，D-003），MyTypeless 不内置任何服务端。默认的内置本地识别（D-009）只在下载模型时联网。

## 模型下载（内置引擎）

- 目录与校验值：`src/main/whisper/catalog.ts` 的 `MODELS`（大小与 SHA256 取自 Hugging Face LFS 元数据）。
- FireRedASR2（D-027，多文件，放在 `models/firered2-aed-int8/`）：`<源>/csukuangfj2/sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26/resolve/main/{encoder.int8.onnx,decoder.int8.onnx,tokens.txt}`；标点模型 `<源>/lorneluo/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/resolve/main/model.int8.onnx` 保存为 `punct.int8.onnx`（与 sherpa-onnx 官方发布包 `punctuation-models/…-int8.tar.bz2` 中的文件逐字节相同，按官方 SHA256 校验）；源同下（官方优先、镜像兜底）。
- 地址：`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<文件>`，失败时换 `https://hf-mirror.com/...`（同路径）。
- 下载到 `userData/models/<文件>.part`，支持 `Range` 续传；完整后校验 SHA256 再改名为正式文件；校验失败删除重下。

## 声纹模型下载（会议模式，D-015）

- 3D-Speaker ERes2NetV2 中文声纹模型（Apache-2.0，sherpa-onnx 导出，D-026）：`<源>/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx`，源同上（官方优先、镜像兜底）；71,441,526 字节，SHA256 `bf1a75b9…58ee2239`（全文见 `src/main/meeting/diarizer.ts`）。新模型就绪后删除旧的 CAM++ 文件。
- 降噪模型 GTCRN（MIT，sherpa-onnx 导出，D-024）：`https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx`（不在 Hugging Face，只有这一个源），535,638 字节；与声纹模型一起下载，但不是必需文件（缺少时会议照常，分句用原始录音）。
- 分段模型 pyannote segmentation 3.0 量化版（MIT，sherpa-onnx 导出）：`<源>/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.int8.onnx`，1,540,506 字节，保存为 `pyannote-segmentation-3.0.int8.onnx`；与声纹模型一起下载（两者都就绪才算就绪）。
- 可在设置 → 声纹 中提前下载、取消（保留断点）、删除；未下载时首次开始会议自动下载到 `userData/models/`；下载完成前会议照常转写，之后补做说话人区分。

## 在线更新（D-028）

- 发布地址（D-032）：代码仓库 `cjx157791216/MyTypeless` 最新正式 Release 的下载目录 `https://github.com/cjx157791216/MyTypeless/releases/latest/download`（0.2.1 读取旧发布仓库 `cjx157791216/mytypeless-releases` 的同名地址，那里只同步版本说明，安装包地址指向代码仓库）（GitHub 302 跳转到 `releases/download/v<版本>/` 再到下载服务器；`src/main/update-info.ts`；环境变量 `MT_UPDATE_URL` 只用于本机测试）。
- 应用只发 GET、不带凭据、不带用户数据：`<地址>/latest-mac.yml`（electron-updater generic 格式：`version`、`files[{url,sha512,size}]`、`path`、`sha512`、`releaseDate`、`releaseNotes`，另加 `build`、`dmgUrl`），确认后下载其中 zip 的绝对地址 `https://github.com/<仓库>/releases/download/v<版本>/MyTypeless-<版本>-<构建号>-arm64.zip` 并校验 sha512。
- 发布（只在发布者本机，GitHub REST API，`Authorization: Bearer $GH_TOKEN`）：`GET /repos/<仓库>/releases` 删掉同版本旧草稿 → `POST /repos/<仓库>/releases`（`tag_name: v<版本>`，代码仓库另带 `target_commitish: <构建提交>`，`draft: true`）→ 向 `upload_url` `POST ?name=<文件>` 上传 zip、DMG、`latest-mac.yml` → `PATCH`（`draft: false`、`make_latest: true`）→ 匿名读回版本说明确认。仓库至少要有一个提交（建仓库时勾选添加 README），否则无法建标签。
- 日志：`~/Library/Logs/MyTypeless/update.log`（只有版本号、地址和错误）。

## ASR

| 提供方 | 设置值 `asr.provider` | 请求 |
| --- | --- | --- |
| OpenAI 兼容 | `openai` | `POST <baseUrl>/audio/transcriptions`，multipart：`file`（WAV 16kHz 单声道）、`model`、可选 `prompt`；Header `Authorization: Bearer <key>`；读取 `text` |
| 内置本地引擎 | `builtin` | Whisper 模型：同下一行协议，地址由应用内部管理（见 [原生助手契约](native-helpers.md) 的 mt-whisper）；FireRedASR2：本机进程 mt-diarize 的 `asr` 命令（不联网，D-027）；`language` 取设置（默认跟随系统），中文结果按设置转简体或繁体 |
| 自建 whisper.cpp 服务 | `local-whisper` | `POST <baseUrl>/inference`，multipart：`file`、`response_format=json`、`language=auto`、可选 `prompt`；健康检查 `GET <baseUrl>/health` |

- `prompt` 由个人词典拼接（最近添加的优先，最长约 400 字符），用于提升专有名词识别。
- 整段识别时音频超过 5 分钟按最安静处切成若干段（每段 WAV 约 9.6MB 以内，满足云端 25MB 上传限制）：云端各段并行，内置引擎逐段串行，结果按顺序拼接（D-014）。
- 超时 45 秒（每段）。错误码形如 `ASR_HTTP_<status>` / `LOCAL_ASR_HTTP_<status>`。

## LLM

- `POST <baseUrl>/chat/completions`（OpenAI 兼容），`model` 取自设置，`messages = [system, user]`，默认 `temperature` 0.2（语音提问 0.5）。
- 返回 400 且错误信息提到 `temperature` 时，去掉该参数重试一次（兼容不支持 temperature 的推理模型）。
- 超时随文本长度增加：25 秒 + 每字 30 毫秒，上限 180 秒（`llmTimeoutMs`，D-014）；读取 `choices[0].message.content`，经 `cleanLlmOutput` 去掉引号、代码围栏和回显的标签。
- 错误码：`LLM_API_KEY_MISSING`、`LLM_HTTP_<status>`、`LLM_EMPTY_RESPONSE`。
- 听写、翻译时 user 内容用 `<transcript>…</transcript>` 包裹；改写时为「原文 + 口述指令」两段。
- 会议纪要（D-015）：user 内容为 `<transcript>` 包裹的转写稿（每行 `[时间] 发言人：内容`，同一人连续发言合并），只含转写文字与说话人名字（D-016）；超过约 12,000 字时先分段整理提要再汇总；`temperature` 0.3，超时 180 秒；纪要头部（主题、时间、时长、参会人）在本地生成，模型只写正文五节（议题与讨论要点、决议、待办事项、未决问题、各人发言摘要）。提示词见 `src/main/meeting/minutes.ts`（原创，D-001）。
