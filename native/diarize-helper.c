// mt-diarize：会议模式的声纹提取助手（D-015），基于 sherpa-onnx（Apache-2.0）的 C API。
// 常驻进程：启动时加载声纹模型，之后逐行读取命令，从会议临时录音（16kHz 单声道 s16le）
// 中取一段音频，输出该段的声音特征向量。不做聚类（由主进程完成），不读写其他文件。
//
// 用法：mt-diarize [--model <声纹模型.onnx>] [--segmentation <分段模型.onnx>] [--denoiser <gtcrn.onnx>]
//                   [--firered <FireRedASR2 模型目录>] [--punct <标点模型.onnx>] [--threads N]
//       （至少给一个模型；会议用两个进程：声纹一个，边录边降噪一个，互不排队；内置中文识别另起一个进程，D-027）
// 启动成功输出：{"ready":true,"dim":<维度，无声纹模型为 0>,"turns":<bool>,"denoise":<bool>}
// 命令（每行一条；文件路径放最后、取到行尾——真实路径里有空格，如 Application Support）：
//   embed <起始样本> <样本数> <pcm文件>   → {"ok":true,"v":[...]}
//   turns <起始样本> <样本数> <pcm文件>   → {"ok":true,"turns":[[起,止,说话人],...]}（相对该段的样本下标，
//                                          说话人只在这一段内有意义；用于找出一句话里换人的位置）
//   dnfeed <起始样本> <样本数> <pcm文件>  → {"ok":true,"at":<首个输出样本的位置>,"pcm":"<base64 s16le>"}
//                                          边录边降噪（GTCRN 流式）：把这段接着送入，返回已能输出的降噪音频，
//                                          输出与输入按样本对齐（GTCRN 流式输出无额外延迟，实测）；起始样本与上次结尾不连续时先重置
//   dnflush                               → 同上：输出剩余部分并重置（暂停、结束会议时）
//   denoise <起始样本> <样本数> <pcm文件> → {"ok":true,"pcm":"<base64 s16le>"}（整段降噪：补识别时用）
//   asr <base64 16kHz s16le>             → {"ok":true,"text":"..."}（语音识别；音频随命令传入，不经过文件——听写录音不落盘；
//                                          有 --punct 时加标点：FireRedASR2 只输出不带标点的文字）
// 失败：{"ok":false,"error":"..."}；输出与命令一一对应
// stdin 关闭即退出。退出码：0 正常；2 参数错误；4 模型加载失败。

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "sherpa-onnx/c-api/c-api.h"

#ifdef _WIN32
// Windows 版（GAP-008）：MSVC 没有 getline；long 只有 32 位；fopen / argv 按系统代码页解析路径——一律改用 UTF-8
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <shellapi.h>
#pragma comment(lib, "shell32.lib")
typedef intptr_t ssize_t;

static ssize_t getline(char **line, size_t *cap, FILE *f) {
  size_t len = 0;
  int c;
  while ((c = fgetc(f)) != EOF) {
    if (len + 2 > *cap) {
      size_t next = *cap ? *cap * 2 : 4096;
      char *p = realloc(*line, next);
      if (!p) return -1;
      *line = p;
      *cap = next;
    }
    (*line)[len++] = (char)c;
    if (c == '\n') break;
  }
  if (!len) return -1;
  (*line)[len] = '\0';
  return (ssize_t)len;
}

static FILE *open_utf8(const char *path) {
  int n = MultiByteToWideChar(CP_UTF8, 0, path, -1, NULL, 0);
  if (n <= 0) return NULL;
  wchar_t *w = malloc(sizeof(wchar_t) * n);
  if (!w) return NULL;
  MultiByteToWideChar(CP_UTF8, 0, path, -1, w, n);
  FILE *f = _wfopen(w, L"rb");
  free(w);
  return f;
}
#define fopen(path, mode) open_utf8(path)
#define fseek(f, offset, origin) _fseeki64(f, (__int64)(offset), origin)

/** 按 UTF-16 命令行重新取参数并转成 UTF-8（main 的 argv 是系统代码页，含中文的路径会丢字） */
/** 失败（取不到命令行、内存不足）返回 NULL，调用方按参数错误退出 */
static char **utf8_argv(int *argc) {
  wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), argc);
  if (!wargv) return NULL;
  char **argv = calloc((size_t)*argc + 1, sizeof(char *));
  for (int i = 0; argv && i < *argc; i++) {
    int n = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
    argv[i] = n > 0 ? malloc((size_t)n) : NULL;
    if (!argv[i]) {
      argv = NULL; // 已分配的部分随进程退出释放
      break;
    }
    WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, argv[i], n, NULL, NULL);
  }
  LocalFree(wargv);
  return argv;
}
#endif

#define SAMPLE_RATE 16000
#define MAX_SAMPLES (SAMPLE_RATE * 60) // 单段最长 60 秒

static void reply_error(const char *msg) {
  printf("{\"ok\":false,\"error\":\"%s\"}\n", msg);
  fflush(stdout);
}

/** 从 pcm 文件读一段，转成 [-1,1] 浮点；失败时已回复错误并返回 NULL */
static float *read_samples(const char *path, long start, long count, size_t *got_out) {
  if (start < 0 || count <= 0 || count > MAX_SAMPLES) {
    reply_error("bad range");
    return NULL;
  }
  FILE *f = fopen(path, "rb");
  if (!f) {
    reply_error("open failed");
    return NULL;
  }
  int16_t *pcm = malloc(sizeof(int16_t) * count);
  float *samples = malloc(sizeof(float) * count);
  if (!pcm || !samples) {
    fclose(f);
    free(pcm);
    free(samples);
    reply_error("out of memory");
    return NULL;
  }
  size_t got = 0;
  if (fseek(f, (int64_t)start * (int64_t)sizeof(int16_t), SEEK_SET) == 0) got = fread(pcm, sizeof(int16_t), count, f);
  fclose(f);
  if (got == 0) {
    free(pcm);
    free(samples);
    reply_error("no audio");
    return NULL;
  }
  for (size_t i = 0; i < got; i++) samples[i] = pcm[i] / 32768.0f;
  free(pcm);
  *got_out = got;
  return samples;
}

static void turns(const SherpaOnnxOfflineSpeakerDiarization *sd, const char *path, long start, long count) {
  size_t got = 0;
  float *samples = read_samples(path, start, count, &got);
  if (!samples) return;
  const SherpaOnnxOfflineSpeakerDiarizationResult *r = SherpaOnnxOfflineSpeakerDiarizationProcess(sd, samples, (int32_t)got);
  free(samples);
  if (!r) {
    reply_error("diarization failed");
    return;
  }
  int32_t n = SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(r);
  const SherpaOnnxOfflineSpeakerDiarizationSegment *segs = n > 0 ? SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(r) : NULL;
  printf("{\"ok\":true,\"turns\":[");
  for (int32_t i = 0; i < n; i++) {
    long a = (long)(segs[i].start * SAMPLE_RATE + 0.5f);
    long b = (long)(segs[i].end * SAMPLE_RATE + 0.5f);
    printf(i ? ",[%ld,%ld,%d]" : "[%ld,%ld,%d]", a, b, segs[i].speaker);
  }
  printf("]}\n");
  fflush(stdout);
  if (segs) SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segs);
  SherpaOnnxOfflineSpeakerDiarizationDestroyResult(r);
}

// —— 语音降噪（GTCRN，D-024）——
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void put_base64_pcm(const float *x, int32_t n) {
  char quad[4];
  unsigned char t[3];
  int k = 0;
  for (int32_t i = 0; i < n; i++) {
    float f = x[i] * 32768.0f;
    int16_t v = (int16_t)(f > 32767.0f ? 32767 : f < -32768.0f ? -32768 : lrintf(f));
    unsigned char bytes[2] = {(unsigned char)(v & 0xff), (unsigned char)((v >> 8) & 0xff)};
    for (int j = 0; j < 2; j++) {
      t[k++] = bytes[j];
      if (k == 3) {
        quad[0] = B64[t[0] >> 2];
        quad[1] = B64[((t[0] & 3) << 4) | (t[1] >> 4)];
        quad[2] = B64[((t[1] & 15) << 2) | (t[2] >> 6)];
        quad[3] = B64[t[2] & 63];
        fwrite(quad, 1, 4, stdout);
        k = 0;
      }
    }
  }
  if (k) {
    if (k == 1) t[1] = 0;
    quad[0] = B64[t[0] >> 2];
    quad[1] = B64[((t[0] & 3) << 4) | (t[1] >> 4)];
    quad[2] = k == 2 ? B64[((t[1] & 15) << 2)] : '=';
    quad[3] = '=';
    fwrite(quad, 1, 4, stdout);
  }
}

// 流式降噪状态
static const SherpaOnnxOnlineSpeechDenoiser *odn = NULL;
static long dn_next = -1; // 下一次应送入的输入位置
static long dn_out = 0; // 下一个输出样本对应的输入位置

static void dn_reply(const SherpaOnnxDenoisedAudio **chunks, int nchunks, long at) {
  printf("{\"ok\":true,\"at\":%ld,\"pcm\":\"", at);
  // 多段拼接后统一编码（base64 需要连续字节）
  int32_t total = 0;
  for (int i = 0; i < nchunks; i++) total += chunks[i]->n;
  float *all = malloc(sizeof(float) * (total ? total : 1));
  int32_t o = 0;
  for (int i = 0; i < nchunks; i++) {
    memcpy(all + o, chunks[i]->samples, sizeof(float) * chunks[i]->n);
    o += chunks[i]->n;
    SherpaOnnxDestroyDenoisedAudio(chunks[i]);
  }
  put_base64_pcm(all, total);
  free(all);
  fputs("\"}\n", stdout);
  fflush(stdout);
}

/** 收集一段输出；返回其样本数 */
static int32_t dn_take(const SherpaOnnxDenoisedAudio *r, const SherpaOnnxDenoisedAudio **keep, int *nkeep) {
  if (!r || r->n <= 0) {
    if (r) SherpaOnnxDestroyDenoisedAudio(r);
    return 0;
  }
  keep[(*nkeep)++] = r;
  return r->n;
}

static void dn_feed(const char *path, long start, long count) {
  size_t got = 0;
  float *samples = read_samples(path, start, count, &got);
  if (!samples) return;
  if (start != dn_next) {
    SherpaOnnxOnlineSpeechDenoiserReset(odn);
    dn_out = start;
  }
  int32_t shift = SherpaOnnxOnlineSpeechDenoiserGetFrameShiftInSamples(odn);
  if (shift <= 0) shift = 256;
  int cap = (int)(got / shift) + 2;
  const SherpaOnnxDenoisedAudio **keep = malloc(sizeof(*keep) * cap);
  int nkeep = 0;
  long at = dn_out;
  for (size_t off = 0; off < got; off += shift) {
    int32_t n = (int32_t)((got - off) < (size_t)shift ? (got - off) : (size_t)shift);
    if (nkeep >= cap) break;
    dn_out += dn_take(SherpaOnnxOnlineSpeechDenoiserRun(odn, samples + off, n, SAMPLE_RATE), keep, &nkeep);
  }
  free(samples);
  dn_next = start + (long)got;
  dn_reply(keep, nkeep, at);
  free(keep);
}

static void dn_flush(void) {
  const SherpaOnnxDenoisedAudio *keep[1];
  int nkeep = 0;
  long at = dn_out;
  dn_out += dn_take(SherpaOnnxOnlineSpeechDenoiserFlush(odn), keep, &nkeep);
  dn_reply(keep, nkeep, at);
  SherpaOnnxOnlineSpeechDenoiserReset(odn);
  dn_next = -1;
}

static void denoise(const SherpaOnnxOfflineSpeechDenoiser *dn, const char *path, long start, long count) {
  size_t got = 0;
  float *samples = read_samples(path, start, count, &got);
  if (!samples) return;
  const SherpaOnnxDenoisedAudio *out = SherpaOnnxOfflineSpeechDenoiserRun(dn, samples, (int32_t)got, SAMPLE_RATE);
  free(samples);
  if (!out || out->sample_rate != SAMPLE_RATE) {
    if (out) SherpaOnnxDestroyDenoisedAudio(out);
    reply_error("denoise failed");
    return;
  }
  fputs("{\"ok\":true,\"pcm\":\"", stdout);
  put_base64_pcm(out->samples, out->n);
  fputs("\"}\n", stdout);
  fflush(stdout);
  SherpaOnnxDestroyDenoisedAudio(out);
}

// —— 语音识别（FireRedASR2，D-027）——
static int b64val(int c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

/** base64 → s16le → [-1,1] 浮点；返回样本数（失败 0），*out 需 free */
static size_t decode_pcm(const char *b64, float **out) {
  size_t len = strlen(b64);
  unsigned char *bytes = malloc(len / 4 * 3 + 3);
  size_t n = 0;
  int acc = 0, bits = 0;
  for (size_t i = 0; i < len; i++) {
    int v = b64val((unsigned char)b64[i]);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[n++] = (unsigned char)((acc >> bits) & 0xff);
    }
  }
  size_t samples = n / 2;
  float *x = samples ? malloc(sizeof(float) * samples) : NULL;
  for (size_t i = 0; i < samples; i++) x[i] = (int16_t)(bytes[2 * i] | (bytes[2 * i + 1] << 8)) / 32768.0f;
  free(bytes);
  *out = x;
  return samples;
}

static void put_json_text(const char *s) {
  putchar('"');
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') printf("\\%c", c);
    else if (c == '\n') fputs("\\n", stdout);
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static const SherpaOnnxOfflinePunctuation *punct = NULL;

static void asr(const SherpaOnnxOfflineRecognizer *rec, const char *b64) {
  float *x = NULL;
  size_t n = decode_pcm(b64, &x);
  if (!n) {
    free(x);
    reply_error("no audio");
    return;
  }
  const SherpaOnnxOfflineStream *st = SherpaOnnxCreateOfflineStream(rec);
  SherpaOnnxAcceptWaveformOffline(st, SAMPLE_RATE, x, (int32_t)n);
  free(x);
  SherpaOnnxDecodeOfflineStream(rec, st);
  const SherpaOnnxOfflineRecognizerResult *r = SherpaOnnxGetOfflineStreamResult(st);
  const char *text = r && r->text ? r->text : "";
  const char *punctuated = punct && *text ? SherpaOfflinePunctuationAddPunct(punct, text) : NULL;
  fputs("{\"ok\":true,\"text\":", stdout);
  put_json_text(punctuated ? punctuated : text);
  fputs("}\n", stdout);
  if (punctuated) SherpaOfflinePunctuationFreeText(punctuated);
  fflush(stdout);
  if (r) SherpaOnnxDestroyOfflineRecognizerResult(r);
  SherpaOnnxDestroyOfflineStream(st);
}

static char *join_path(const char *dir, const char *name) {
  char *p = malloc(strlen(dir) + strlen(name) + 2);
  sprintf(p, "%s/%s", dir, name);
  return p;
}

static int embed(const SherpaOnnxSpeakerEmbeddingExtractor *ex, int32_t dim, const char *path, long start, long count) {
  size_t got = 0;
  float *samples = read_samples(path, start, count, &got);
  if (!samples) return 0;
  const SherpaOnnxOnlineStream *stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(ex);
  SherpaOnnxOnlineStreamAcceptWaveform(stream, SAMPLE_RATE, samples, (int32_t)got);
  SherpaOnnxOnlineStreamInputFinished(stream);
  free(samples);
  if (!SherpaOnnxSpeakerEmbeddingExtractorIsReady(ex, stream)) {
    SherpaOnnxDestroyOnlineStream(stream);
    reply_error("too short");
    return 0;
  }
  const float *v = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(ex, stream);
  printf("{\"ok\":true,\"v\":[");
  for (int32_t i = 0; i < dim; i++) printf(i ? ",%.6g" : "%.6g", v[i]);
  printf("]}\n");
  fflush(stdout);
  SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(v);
  SherpaOnnxDestroyOnlineStream(stream);
  return 1;
}

int main(int argc, char **argv) {
#ifdef _WIN32
  argv = utf8_argv(&argc);
  if (!argv) {
    fprintf(stderr, "cannot read command line\n");
    return 2;
  }
  _setmode(_fileno(stdout), _O_BINARY); // 换行原样输出，不变成 CRLF
#endif
  const char *model = NULL;
  const char *segmentation = NULL;
  const char *denoiser_model = NULL;
  const char *firered_dir = NULL;
  const char *punct_model = NULL;
  float turn_threshold = 0.7f; // 句内聚类的距离阈值（越大越不容易拆成多人）
  int threads = 1;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--model") && i + 1 < argc) model = argv[++i];
    else if (!strcmp(argv[i], "--segmentation") && i + 1 < argc) segmentation = argv[++i];
    else if (!strcmp(argv[i], "--turn-threshold") && i + 1 < argc) turn_threshold = (float)atof(argv[++i]);
    else if (!strcmp(argv[i], "--denoiser") && i + 1 < argc) denoiser_model = argv[++i];
    else if (!strcmp(argv[i], "--firered") && i + 1 < argc) firered_dir = argv[++i];
    else if (!strcmp(argv[i], "--punct") && i + 1 < argc) punct_model = argv[++i];
    else if (!strcmp(argv[i], "--threads") && i + 1 < argc) threads = atoi(argv[++i]);
  }
  if (!model && !denoiser_model && !firered_dir) {
    fprintf(stderr, "usage: mt-diarize [--model <model.onnx>] [--segmentation <model.onnx>] [--denoiser <gtcrn.onnx>] [--firered <dir>] [--threads N]\n");
    return 2;
  }
  if (threads < 1) threads = 1;

  const SherpaOnnxSpeakerEmbeddingExtractor *ex = NULL;
  int32_t dim = 0;
  if (model) {
    SherpaOnnxSpeakerEmbeddingExtractorConfig config;
    memset(&config, 0, sizeof(config));
    config.model = model;
    config.num_threads = threads;
    config.provider = "cpu";
    ex = SherpaOnnxCreateSpeakerEmbeddingExtractor(&config);
    if (!ex) {
      fprintf(stderr, "failed to load model: %s\n", model);
      return 4;
    }
    dim = SherpaOnnxSpeakerEmbeddingExtractorDim(ex);
  }

  const SherpaOnnxOfflineSpeakerDiarization *sd = NULL;
  if (segmentation && model) {
    SherpaOnnxOfflineSpeakerDiarizationConfig dc;
    memset(&dc, 0, sizeof(dc));
    dc.segmentation.pyannote.model = segmentation;
    dc.segmentation.num_threads = threads;
    dc.segmentation.provider = "cpu";
    dc.embedding.model = model;
    dc.embedding.num_threads = threads;
    dc.embedding.provider = "cpu";
    dc.clustering.num_clusters = -1;
    dc.clustering.threshold = turn_threshold;
    dc.min_duration_on = 0.3f;
    dc.min_duration_off = 0.5f;
    sd = SherpaOnnxCreateOfflineSpeakerDiarization(&dc);
    if (!sd) {
      fprintf(stderr, "failed to load segmentation model: %s\n", segmentation);
      return 4;
    }
  }
  const SherpaOnnxOfflineSpeechDenoiser *dn = NULL;
  if (denoiser_model) {
    SherpaOnnxOfflineSpeechDenoiserConfig nc;
    memset(&nc, 0, sizeof(nc));
    nc.model.gtcrn.model = denoiser_model;
    nc.model.num_threads = threads;
    nc.model.provider = "cpu";
    dn = SherpaOnnxCreateOfflineSpeechDenoiser(&nc);
    SherpaOnnxOnlineSpeechDenoiserConfig oc;
    memset(&oc, 0, sizeof(oc));
    oc.model = nc.model;
    odn = SherpaOnnxCreateOnlineSpeechDenoiser(&oc);
    if (!dn || !odn) {
      fprintf(stderr, "failed to load denoiser model: %s\n", denoiser_model);
      return 4;
    }
  }
  const SherpaOnnxOfflineRecognizer *rec = NULL;
  if (firered_dir) {
    SherpaOnnxOfflineRecognizerConfig rc;
    memset(&rc, 0, sizeof(rc));
    rc.feat_config.sample_rate = SAMPLE_RATE;
    rc.feat_config.feature_dim = 80;
    rc.model_config.fire_red_asr.encoder = join_path(firered_dir, "encoder.int8.onnx");
    rc.model_config.fire_red_asr.decoder = join_path(firered_dir, "decoder.int8.onnx");
    rc.model_config.tokens = join_path(firered_dir, "tokens.txt");
    rc.model_config.num_threads = threads;
    rc.model_config.provider = "cpu";
    rc.decoding_method = "greedy_search";
    rec = SherpaOnnxCreateOfflineRecognizer(&rc);
    if (!rec) {
      fprintf(stderr, "failed to load asr model: %s\n", firered_dir);
      return 4;
    }
  }
  if (punct_model) {
    SherpaOnnxOfflinePunctuationConfig pc;
    memset(&pc, 0, sizeof(pc));
    pc.model.ct_transformer = punct_model;
    pc.model.num_threads = 1;
    pc.model.provider = "cpu";
    punct = SherpaOnnxCreateOfflinePunctuation(&pc);
    if (!punct) {
      fprintf(stderr, "failed to load punctuation model: %s\n", punct_model);
      return 4;
    }
  }
  printf("{\"ready\":true,\"dim\":%d,\"turns\":%s,\"denoise\":%s,\"asr\":%s}\n", dim, sd ? "true" : "false", dn ? "true" : "false",
         rec ? "true" : "false");
  fflush(stdout);

  char *line = NULL; // 识别命令带整段音频（base64），行可能很长
  size_t cap = 0;
  while (getline(&line, &cap, stdin) > 0) {
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = '\0';
    if (!strncmp(line, "asr ", 4)) {
      if (rec) asr(rec, line + 4);
      else reply_error("no asr model");
      continue;
    }
    if (!strcmp(line, "dnflush")) {
      if (odn) dn_flush();
      else reply_error("no denoiser model");
      continue;
    }
    char cmd[10] = {0};
    long start = 0, count = 0;
    int consumed = 0;
    if (sscanf(line, "%9s %ld %ld %n", cmd, &start, &count, &consumed) != 3 || consumed <= 0 || !line[consumed]) {
      reply_error("bad command");
      continue;
    }
    const char *path = line + consumed; // 路径取到行尾（可含空格）
    if (!strcmp(cmd, "embed")) {
      if (ex) embed(ex, dim, path, start, count);
      else reply_error("no embedding model");
    }
    else if (!strcmp(cmd, "turns")) {
      if (sd) turns(sd, path, start, count);
      else reply_error("no segmentation model");
    } else if (!strcmp(cmd, "dnfeed")) {
      if (odn) dn_feed(path, start, count);
      else reply_error("no denoiser model");
    } else if (!strcmp(cmd, "denoise")) {
      if (dn) denoise(dn, path, start, count);
      else reply_error("no denoiser model");
    } else reply_error("bad command");
  }
  free(line);
  if (rec) SherpaOnnxDestroyOfflineRecognizer(rec);
  if (punct) SherpaOnnxDestroyOfflinePunctuation(punct);
  if (odn) SherpaOnnxDestroyOnlineSpeechDenoiser(odn);
  if (dn) SherpaOnnxDestroyOfflineSpeechDenoiser(dn);
  if (sd) SherpaOnnxDestroyOfflineSpeakerDiarization(sd);
  if (ex) SherpaOnnxDestroySpeakerEmbeddingExtractor(ex);
  return 0;
}
