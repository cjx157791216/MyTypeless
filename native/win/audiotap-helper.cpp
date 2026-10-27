// mt-audiotap（Windows 版，原创）：线上会议截取会议软件播放的声音（D-033）。协议同 macOS 版（docs/contracts/native-helpers.md）：
//   mt-audiotap --list    → stdout：有音频会话的进程 [{"pid","bundleId","name","output","input"}]（output：此刻正在发声；input：此刻正在用麦克风）
//   mt-audiotap --apps    → stdout：正在运行的应用 [{"bundleId","name","audio","output"}]，按 exe 合并（bundleId = 小写 exe 文件名）
//   mt-audiotap --probe   → 试建一次截取：stderr {"ready":true,...} 后退出 0；不支持（低于 Windows 10 build 20348）退出码 4
//   mt-audiotap [--bundle <exe>]... [--pid <pid>]... [--exclude-bundle <exe>]... [--exclude-pid <pid>]... [--mute] [--verbose]
//       stdout 连续输出 16kHz 单声道 s16le，严格 16000 样本/秒（没人发声时补静音，与麦克风录音同一时间线）
// 实现：WASAPI 进程回环录音（AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK）。给了 --bundle / --pid：对每个匹配进程树的根各截一路
//   （PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE，Chrome 等的声音来自子进程，一起截到），混成一路；
//   都不给：截取全部系统声音、排除 MyTypeless 自己的进程树（EXCLUDE_TARGET_PROCESS_TREE）。每 2 秒重新匹配进程。
//   Windows 截取应用声音不需要授权；--mute 不支持（忽略）。只把声音写到 stdout，不写文件、不联网。
// stderr 每行一条 JSON：{"ready":true,"rate":16000,"channels":1}、{"processes":[pid,...]}、{"error":"..."}、--verbose 时每 2 秒 {"peak":n}、
//   {"input":bool}（所截取的进程树是否在用麦克风：就绪后报一次，之后变化时报，D-045）
// 退出码：2 参数错误；4 不支持 / 建立截取失败；stdout 关闭或父进程退出时退出（0）
#include "process-info.h"
#include <ole2.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <dwmapi.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <algorithm>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "dwmapi.lib")

using Microsoft::WRL::ComPtr;

static const int RATE = 16000;
static const size_t MAX_BACKLOG = RATE / 2; // 每路最多积压 0.5 秒，超出丢最旧的（防漂移累积延迟）

static void ErrorLine(const std::string &msg) {
  std::string line = "{\"error\":" + JsonString(msg) + "}\n";
  fwrite(line.data(), 1, line.size(), stderr);
  fflush(stderr);
}

// ---------- 进程回环录音的一路 ----------

class ActivateHandler : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                                            Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;
  ~ActivateHandler() { CloseHandle(done); }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT activated = E_FAIL;
    ComPtr<IUnknown> unk;
    result = op->GetActivateResult(&activated, &unk);
    if (SUCCEEDED(result)) result = activated;
    if (SUCCEEDED(result)) result = unk.As(&client);
    SetEvent(done);
    return S_OK;
  }
};

struct Tap {
  DWORD pid = 0;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  HANDLE event = nullptr;
  bool downsample = false; // 系统不肯直接给 16k 单声道时：拿 48k 双声道，自己下混、3:1 降采样
  std::thread thread;
  std::atomic<bool> stop{false};
  std::atomic<bool> dead{false};
  std::mutex lock;
  std::vector<int16_t> buffer;

  ~Tap() {
    stop = true;
    if (thread.joinable()) thread.join();
    if (client) client->Stop();
    if (event) CloseHandle(event);
  }

  void Append(const int16_t *pcm, size_t frames, bool silent) {
    std::lock_guard<std::mutex> g(lock);
    if (!downsample) {
      if (silent) buffer.insert(buffer.end(), frames, 0);
      else buffer.insert(buffer.end(), pcm, pcm + frames);
    } else {
      // 48k 双声道 → 16k 单声道：每 3 帧取均值（相当于简单低通，语音足够）
      for (size_t i = 0; i + 2 < frames; i += 3) {
        int sum = 0;
        if (!silent)
          for (size_t k = 0; k < 3; k++) sum += pcm[(i + k) * 2] + pcm[(i + k) * 2 + 1];
        buffer.push_back((int16_t)(sum / 6));
      }
    }
    if (buffer.size() > MAX_BACKLOG) buffer.erase(buffer.begin(), buffer.begin() + (buffer.size() - MAX_BACKLOG));
  }

  void Run() {
    while (!stop) {
      WaitForSingleObject(event, 100);
      UINT32 packet = 0;
      while (!stop) {
        HRESULT hr = capture->GetNextPacketSize(&packet);
        if (FAILED(hr)) {
          dead = true; // 设备失效（换了输出设备等）：由匹配循环重建
          return;
        }
        if (!packet) break;
        BYTE *data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) {
          dead = true;
          return;
        }
        Append((const int16_t *)data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
        capture->ReleaseBuffer(frames);
      }
    }
  }
};

static WAVEFORMATEX PcmFormat(int rate, int channels) {
  WAVEFORMATEX f{};
  f.wFormatTag = WAVE_FORMAT_PCM;
  f.nChannels = (WORD)channels;
  f.nSamplesPerSec = rate;
  f.wBitsPerSample = 16;
  f.nBlockAlign = (WORD)(channels * 2);
  f.nAvgBytesPerSec = rate * f.nBlockAlign;
  return f;
}

/** 建立一路进程回环录音；失败返回 nullptr 并写 err。convert：请系统直接转成 16k 单声道（不行再用 48k 双声道自己转） */
static std::unique_ptr<Tap> OpenTap(DWORD pid, bool include, std::string &err, bool convert = true) {
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv{};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof params;
  pv.blob.pBlobData = (BYTE *)&params;

  auto handler = Microsoft::WRL::Make<ActivateHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
  if (FAILED(hr) || WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0 || FAILED(handler->result)) {
    char buf[96];
    snprintf(buf, sizeof buf, "process loopback unavailable (0x%08lx)", (unsigned long)(FAILED(hr) ? hr : handler->result));
    err = buf;
    return nullptr;
  }
  auto tap = std::make_unique<Tap>();
  tap->pid = pid;
  tap->client = handler->client;
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  if (convert) {
    WAVEFORMATEX want = PcmFormat(RATE, 1);
    hr = tap->client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                 2000000, 0, &want, nullptr);
    // 系统不肯转换：重新激活（Initialize 失败后不能再用这个客户端），拿 48k 双声道自己转
    if (FAILED(hr)) return OpenTap(pid, include, err, false);
  } else {
    WAVEFORMATEX f48 = PcmFormat(48000, 2);
    hr = tap->client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2000000, 0, &f48, nullptr);
    if (FAILED(hr)) {
      char buf[64];
      snprintf(buf, sizeof buf, "initialize failed (0x%08lx)", (unsigned long)hr);
      err = buf;
      return nullptr;
    }
    tap->downsample = true;
  }
  tap->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (FAILED(tap->client->SetEventHandle(tap->event)) || FAILED(tap->client->GetService(IID_PPV_ARGS(&tap->capture))) ||
      FAILED(tap->client->Start())) {
    err = "start failed";
    return nullptr;
  }
  Tap *raw = tap.get();
  tap->thread = std::thread([raw] {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    raw->Run();
    CoUninitialize();
  });
  return tap;
}

// ---------- 进程与音频会话 ----------

struct Proc {
  DWORD pid, parent;
  std::wstring exe; // 小写文件名
};

static std::vector<Proc> Processes() {
  std::vector<Proc> list;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return list;
  PROCESSENTRY32W pe{sizeof pe};
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe))
    list.push_back({pe.th32ProcessID, pe.th32ParentProcessID, Lower(pe.szExeFile)});
  CloseHandle(snap);
  return list;
}

/** 所有输出设备（eRender）/ 输入设备（eCapture）上的音频会话：pid → 此刻是否在发声 / 在录音 */
static std::map<DWORD, bool> AudioSessions(EDataFlow flow = eRender) {
  std::map<DWORD, bool> sessions;
  ComPtr<IMMDeviceEnumerator> devices;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)))) return sessions;
  ComPtr<IMMDeviceCollection> all;
  UINT count = 0;
  if (FAILED(devices->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &all)) || FAILED(all->GetCount(&count))) return sessions;
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> dev;
    ComPtr<IAudioSessionManager2> mgr;
    ComPtr<IAudioSessionEnumerator> it;
    int n = 0;
    if (FAILED(all->Item(i, &dev)) || FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void **)&mgr)) ||
        FAILED(mgr->GetSessionEnumerator(&it)) || FAILED(it->GetCount(&n)))
      continue;
    for (int k = 0; k < n; k++) {
      ComPtr<IAudioSessionControl> ctl;
      ComPtr<IAudioSessionControl2> ctl2;
      DWORD pid = 0;
      AudioSessionState state = AudioSessionStateInactive;
      if (FAILED(it->GetSession(k, &ctl)) || FAILED(ctl.As(&ctl2)) || FAILED(ctl2->GetProcessId(&pid)) || !pid) continue;
      ctl->GetState(&state);
      sessions[pid] = sessions[pid] || state == AudioSessionStateActive;
    }
  }
  return sessions;
}

/** 有可见主窗口的进程（“正在运行的应用”） */
static std::set<DWORD> WindowedPids() {
  std::set<DWORD> pids;
  EnumWindows(
      [](HWND h, LPARAM lp) -> BOOL {
        if (!IsWindowVisible(h) || GetWindow(h, GW_OWNER) || (GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW)) return TRUE;
        if (!GetWindowTextLengthW(h)) return TRUE;
        BOOL cloaked = FALSE;
        if (SUCCEEDED(DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof cloaked)) && cloaked) return TRUE;
        DWORD pid = 0;
        GetWindowThreadProcessId(h, &pid);
        ((std::set<DWORD> *)lp)->insert(pid);
        return TRUE;
      },
      (LPARAM)&pids);
  return pids;
}

static int PrintList() {
  auto sessions = AudioSessions();
  auto inputs = AudioSessions(eCapture);
  for (auto &kv : inputs) sessions.emplace(kv.first, false); // 只在录音的进程也列出
  std::string out = "[";
  for (auto &[pid, output] : sessions) {
    std::wstring path = ExePath(pid);
    if (path.empty()) continue;
    auto in = inputs.find(pid);
    bool input = in != inputs.end() && in->second;
    if (out.size() > 1) out += ",";
    out += "{\"pid\":" + std::to_string(pid) + ",\"bundleId\":" + JsonString(WideToUtf8(Lower(FileName(path)))) +
           ",\"name\":" + JsonString(WideToUtf8(DisplayName(path))) + ",\"output\":" + (output ? "true" : "false") +
           ",\"input\":" + (input ? "true" : "false") + "}";
  }
  WriteStdout(out + "]\n");
  return 0;
}

static int PrintApps() {
  auto sessions = AudioSessions();
  auto windowed = WindowedPids();
  struct App { std::wstring path; bool audio = false, output = false, windowed = false; };
  std::map<std::wstring, App> apps; // exe → 合并后的应用
  for (auto &p : Processes()) {
    auto s = sessions.find(p.pid);
    bool hasWindow = windowed.count(p.pid) > 0;
    if (s == sessions.end() && !hasWindow) continue;
    App &a = apps[p.exe];
    if (a.path.empty()) a.path = ExePath(p.pid);
    a.windowed = a.windowed || hasWindow;
    if (s != sessions.end()) {
      a.audio = true;
      a.output = a.output || s->second;
    }
  }
  std::string out = "[";
  for (auto &[exe, a] : apps) {
    if (a.path.empty() || exe == L"explorer.exe") continue;
    if (out.size() > 1) out += ",";
    out += "{\"bundleId\":" + JsonString(WideToUtf8(exe)) + ",\"name\":" + JsonString(WideToUtf8(DisplayName(a.path))) +
           ",\"audio\":" + (a.audio ? "true" : "false") + ",\"output\":" + (a.output ? "true" : "false") + "}";
  }
  WriteStdout(out + "]\n");
  return 0;
}

// ---------- 截取 ----------

struct Options {
  std::set<std::wstring> bundles, excludeBundles;
  std::set<DWORD> pids, excludePids;
  bool verbose = false;
};

/** 要截取的进程树的根：匹配的进程中父进程不在匹配集合里的 */
static std::set<DWORD> MatchRoots(const Options &o) {
  auto procs = Processes();
  std::set<DWORD> matched;
  for (auto &p : procs) {
    if (o.excludePids.count(p.pid) || o.excludeBundles.count(p.exe)) continue;
    if (o.pids.count(p.pid) || o.bundles.count(p.exe)) matched.insert(p.pid);
  }
  std::set<DWORD> roots;
  for (auto &p : procs)
    if (matched.count(p.pid) && !matched.count(p.parent)) roots.insert(p.pid);
  return roots;
}

/**
 * 所截取的进程树此刻是否在用麦克风（D-045）：会议软件在用麦克风 = 用户在通话中。给了 --bundle / --pid 时看匹配进程及其子进程；
 * 截取全部系统声音时看 MyTypeless 自己进程树之外、有可见窗口的应用（及其子进程）
 */
static bool MicInUse(const Options &o, bool all, DWORD self) {
  auto inputs = AudioSessions(eCapture);
  bool any = false;
  for (auto &kv : inputs) any = any || kv.second;
  if (!any) return false;
  std::map<DWORD, const Proc *> byPid;
  auto procs = Processes();
  for (auto &p : procs) byPid[p.pid] = &p;
  auto windowed = all ? WindowedPids() : std::set<DWORD>();
  for (auto &[pid, active] : inputs) {
    if (!active) continue;
    bool excluded = false, matched = false, hasWindow = false;
    DWORD cur = pid;
    for (int depth = 0; depth < 32 && cur; depth++) { // 沿父进程向上（父进程已退出时链条中断）
      auto it = byPid.find(cur);
      if (it == byPid.end()) break;
      const Proc &p = *it->second;
      if (cur == self || o.excludePids.count(cur) || o.excludeBundles.count(p.exe)) excluded = true;
      if (o.pids.count(cur) || o.bundles.count(p.exe)) matched = true;
      if (windowed.count(cur)) hasWindow = true;
      if (p.parent == cur) break;
      cur = p.parent;
    }
    if (excluded) continue;
    if (all ? hasWindow : matched) return true;
  }
  return false;
}

static void WriteReady() {
  const char *line = "{\"ready\":true,\"rate\":16000,\"channels\":1}\n";
  fwrite(line, 1, strlen(line), stderr);
  fflush(stderr);
}

static int Capture(const Options &o) {
  const bool all = o.bundles.empty() && o.pids.empty();
  std::map<DWORD, std::unique_ptr<Tap>> taps;
  std::string err;
  // 截取全部：排除 MyTypeless 自己的进程树（父进程即主进程；渲染进程等都在这棵树里）
  DWORD self = ParentPid();
  if (!self && !o.excludePids.empty()) self = *o.excludePids.begin();
  auto rematch = [&]() {
    if (all) {
      for (auto it = taps.begin(); it != taps.end();) it = it->second->dead ? taps.erase(it) : std::next(it);
      if (taps.empty()) {
        auto tap = OpenTap(self, false, err);
        if (tap) taps[0] = std::move(tap);
      }
      return;
    }
    auto roots = MatchRoots(o);
    bool changed = false;
    for (auto it = taps.begin(); it != taps.end();) {
      if (!roots.count(it->first) || it->second->dead) {
        it = taps.erase(it);
        changed = true;
      } else ++it;
    }
    for (DWORD pid : roots) {
      if (taps.count(pid)) continue;
      auto tap = OpenTap(pid, true, err);
      if (tap) {
        taps[pid] = std::move(tap);
        changed = true;
      }
    }
    if (changed) {
      std::string line = "{\"processes\":[";
      bool first = true;
      for (auto &kv : taps) {
        line += (first ? "" : ",") + std::to_string(kv.first);
        first = false;
      }
      line += "]}\n";
      fwrite(line.data(), 1, line.size(), stderr);
      fflush(stderr);
    }
  };

  rematch();
  if (all && taps.empty()) {
    ErrorLine(err);
    return 4;
  }
  // 指定应用时先确认这台机器支持进程回环录音（对自己建一路试试），否则直接报不支持
  if (!all && taps.empty()) {
    auto probe = OpenTap(GetCurrentProcessId(), true, err);
    if (!probe) {
      ErrorLine(err);
      return 4;
    }
  }
  WriteReady();
  int lastInput = -1;
  auto reportInput = [&]() {
    int inUse = MicInUse(o, all, self) ? 1 : 0;
    if (inUse == lastInput) return;
    lastInput = inUse;
    std::string line = std::string("{\"input\":") + (inUse ? "true" : "false") + "}\n";
    fwrite(line.data(), 1, line.size(), stderr);
    fflush(stderr);
  };
  reportInput();

  _setmode(_fileno(stdout), _O_BINARY);
  LARGE_INTEGER freq, start, now;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&start);
  long long written = 0;
  ULONGLONG lastMatch = GetTickCount64(), lastPeak = lastMatch;
  int peak = 0;
  std::vector<int32_t> mix;
  std::vector<int16_t> out;
  for (;;) {
    Sleep(20);
    QueryPerformanceCounter(&now);
    long long target = (now.QuadPart - start.QuadPart) * RATE / freq.QuadPart;
    long long n = target - written;
    if (n <= 0) continue;
    mix.assign((size_t)n, 0);
    for (auto &kv : taps) {
      Tap &t = *kv.second;
      std::lock_guard<std::mutex> g(t.lock);
      size_t k = std::min((size_t)n, t.buffer.size());
      for (size_t i = 0; i < k; i++) mix[i] += t.buffer[i];
      t.buffer.erase(t.buffer.begin(), t.buffer.begin() + k);
    }
    out.resize((size_t)n);
    for (size_t i = 0; i < (size_t)n; i++) {
      int v = std::clamp(mix[i], -32768, 32767);
      out[i] = (int16_t)v;
      peak = std::max(peak, std::abs(v));
    }
    if (fwrite(out.data(), 2, out.size(), stdout) != out.size() || fflush(stdout) != 0) return 0; // stdout 关闭：退出
    written = target;
    ULONGLONG tick = GetTickCount64();
    if (tick - lastMatch >= 2000) {
      lastMatch = tick;
      rematch();
      reportInput();
    }
    if (o.verbose && tick - lastPeak >= 2000) {
      lastPeak = tick;
      std::string line = "{\"peak\":" + std::to_string(std::min(peak, 32767)) + "}\n";
      fwrite(line.data(), 1, line.size(), stderr);
      fflush(stderr);
      peak = 0;
    }
  }
}

int wmain(int argc, wchar_t **argv) {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;
  if (argc == 2 && wcscmp(argv[1], L"--list") == 0) return PrintList();
  if (argc == 2 && wcscmp(argv[1], L"--apps") == 0) return PrintApps();
  if (argc == 2 && wcscmp(argv[1], L"--probe") == 0) {
    std::string err;
    auto tap = OpenTap(GetCurrentProcessId(), false, err);
    if (!tap) {
      ErrorLine(err);
      return 4;
    }
    WriteReady();
    return 0;
  }
  Options o;
  for (int i = 1; i < argc; i++) {
    std::wstring a = argv[i];
    bool hasValue = i + 1 < argc;
    if (a == L"--bundle" && hasValue) o.bundles.insert(Lower(argv[++i]));
    else if (a == L"--exclude-bundle" && hasValue) o.excludeBundles.insert(Lower(argv[++i]));
    else if (a == L"--pid" && hasValue) o.pids.insert(wcstoul(argv[++i], nullptr, 10));
    else if (a == L"--exclude-pid" && hasValue) o.excludePids.insert(wcstoul(argv[++i], nullptr, 10));
    else if (a == L"--verbose") o.verbose = true;
    else if (a == L"--mute") continue; // Windows 进程回环录音不能静音原声
    else {
      fputs("usage: mt-audiotap --list | --apps | --probe | [--bundle <exe>]... [--pid <pid>]... [--exclude-bundle <exe>]... [--exclude-pid <pid>]... [--verbose]\n", stderr);
      return 2;
    }
  }
  ExitWhenParentExits();
  return Capture(o);
}
