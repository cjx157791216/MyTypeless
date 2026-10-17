// mt-hotkey（Windows 版，原创）：全局快捷键。协议同 macOS 版（docs/contracts/native-helpers.md）：
//   mt-hotkey '{"matches":[{"name":"dictation","key":"rctrl"},{"name":"ask","key":"space","require":["rctrl"]}]}'
//   stdout 每行一个事件：{"name":"system","phase":"ready"}、{"name":<绑定名>,"phase":"down"|"up"|"abort"}
// 设计（D-002）：低级键盘钩子只匹配已注册的快捷键，不记录、不输出其他按键；忽略程序模拟的按键（mt-inject）。
// - 普通键触发（如 rctrl+space）：吞掉触发键（含自动重复），松开触发键或先松开修饰键都算结束。
// - 单修饰键触发（如 rctrl）：不吞（避免修饰键状态卡死）；按住期间按了其他键 → abort 并放行该键；
//   若组成另一条注册组合（rctrl+space、rctrl+shift），先 abort 再发那条组合的 down。
// - 修饰键组合（ralt+shift）的第二个修饰键成对吞掉：Windows 默认 Ctrl+Shift / Alt+Shift 切换键盘布局 / 输入语言。
// - 单修饰键触发是 Alt / Win 时，按下后补发一个未分配的键（0xE8）：否则单独松开 Alt 会激活菜单栏、Win 会打开开始菜单。
// - AltGr 布局按右 Alt 时系统插入的假左 Ctrl 不计入修饰键状态。
// - require 除 opt/cmd/ctrl/shift 外，还可以是区分左右的 rctrl/lctrl/ropt/lopt/rshift/lshift/rcmd/lcmd
//   （该侧必须按着，同时算作对应的通用修饰键）。Windows 键盘读不到 fn：写 stderr 后跳过。
// 父进程退出后立即退出。退出码：2 配置错误（或没有有效绑定）、4 安装钩子失败。
#include "common.h"
#include <tlhelp32.h>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <ctype.h>
#include <stdlib.h>
#include <map>
#include <set>
#include <vector>

// ---------- 极简 JSON（只解析配置用到的对象 / 数组 / 字符串） ----------

struct Json {
  enum Type { Null, Str, Arr, Obj, Other } type = Null;
  std::string str;
  std::vector<Json> arr;
  std::map<std::string, Json> obj;
};

struct Parser {
  const char *p;
  void ws() { while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') p++; }
  bool parse(Json &out) {
    ws();
    if (*p == '"') {
      out.type = Json::Str;
      return str(out.str);
    }
    if (*p == '[') {
      out.type = Json::Arr;
      p++;
      ws();
      if (*p == ']') return p++, true;
      for (;;) {
        Json v;
        if (!parse(v)) return false;
        out.arr.push_back(std::move(v));
        ws();
        if (*p == ',') { p++; continue; }
        if (*p == ']') return p++, true;
        return false;
      }
    }
    if (*p == '{') {
      out.type = Json::Obj;
      p++;
      ws();
      if (*p == '}') return p++, true;
      for (;;) {
        ws();
        std::string k;
        if (*p != '"' || !str(k)) return false;
        ws();
        if (*p++ != ':') return false;
        Json v;
        if (!parse(v)) return false;
        out.obj[k] = std::move(v);
        ws();
        if (*p == ',') { p++; continue; }
        if (*p == '}') return p++, true;
        return false;
      }
    }
    // 数字 / true / false / null：配置里用不到，跳过
    out.type = Json::Other;
    const char *start = p;
    while (*p && !strchr(",]} \n\r\t", *p)) p++;
    return p > start;
  }
  bool str(std::string &s) {
    p++; // "
    while (*p && *p != '"') {
      if (*p == '\\') {
        p++;
        if (!*p) return false; // 结尾的 \：不能越过字符串结尾
        switch (*p) {
          case 'n': s += '\n'; break;
          case 't': s += '\t'; break;
          case 'r': s += '\r'; break;
          case 'u': {
            unsigned v = 0;
            for (int i = 1; i <= 4; i++) {
              if (!isxdigit((unsigned char)p[i])) return false; // 不足 4 位或不是十六进制（也挡住了字符串结尾）
              v = v * 16 + (unsigned)(isdigit((unsigned char)p[i]) ? p[i] - '0' : (tolower((unsigned char)p[i]) - 'a' + 10));
            }
            p += 4;
            if (v < 0x80) s += (char)v;  // 配置只有 ASCII 键名，其他 \u 原样丢弃
            break;
          }
          default: s += *p;
        }
        p++;
      } else {
        s += *p++;
      }
    }
    if (*p != '"') return false;
    p++;
    return true;
  }
};

// ---------- 键表 ----------

enum Flag : unsigned { CTRL = 1, ALT = 2, SHIFT = 4, WIN = 8 };

static const std::map<std::string, std::vector<WORD>> kModifierKeys = {
    {"rctrl", {VK_RCONTROL}}, {"rightcontrol", {VK_RCONTROL}}, {"lctrl", {VK_LCONTROL}}, {"leftcontrol", {VK_LCONTROL}},
    {"ropt", {VK_RMENU}},     {"rightoption", {VK_RMENU}},     {"lopt", {VK_LMENU}},     {"leftoption", {VK_LMENU}},
    {"ralt", {VK_RMENU}},     {"lalt", {VK_LMENU}},
    {"rshift", {VK_RSHIFT}},  {"rightshift", {VK_RSHIFT}},     {"lshift", {VK_LSHIFT}},  {"leftshift", {VK_LSHIFT}},
    {"rcmd", {VK_RWIN}},      {"rightcmd", {VK_RWIN}},         {"lcmd", {VK_LWIN}},      {"leftcmd", {VK_LWIN}},
    // 只用于组合（如 rshift+ctrl），左右都算
    {"shift", {VK_LSHIFT, VK_RSHIFT}}, {"ctrl", {VK_LCONTROL, VK_RCONTROL}}, {"control", {VK_LCONTROL, VK_RCONTROL}},
    {"alt", {VK_LMENU, VK_RMENU}},     {"opt", {VK_LMENU, VK_RMENU}},
};

static WORD NormalKey(const std::string &k) {
  if (k.size() == 1) {
    char c = k[0];
    if (isalpha((unsigned char)c)) return (WORD)toupper((unsigned char)c);
    if (isdigit((unsigned char)c)) return (WORD)c;
    switch (c) {
      case ';': return VK_OEM_1;     case '=': return VK_OEM_PLUS;  case ',': return VK_OEM_COMMA;
      case '-': return VK_OEM_MINUS; case '.': return VK_OEM_PERIOD; case '/': return VK_OEM_2;
      case '`': return VK_OEM_3;     case '[': return VK_OEM_4;     case '\\': return VK_OEM_5;
      case ']': return VK_OEM_6;     case '\'': return VK_OEM_7;
    }
    return 0;
  }
  static const std::map<std::string, int> named = {
      {"return", VK_RETURN}, {"enter", VK_RETURN}, {"tab", VK_TAB}, {"space", VK_SPACE},
      {"delete", VK_BACK}, {"backspace", VK_BACK}, {"escape", VK_ESCAPE}, {"esc", VK_ESCAPE},
      {"home", VK_HOME}, {"end", VK_END}, {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT}, {"forwarddelete", VK_DELETE},
      {"left", VK_LEFT}, {"right", VK_RIGHT}, {"up", VK_UP}, {"down", VK_DOWN}};
  auto it = named.find(k);
  if (it != named.end()) return (WORD)it->second;
  if (k[0] == 'f' && k.size() <= 3) {
    int n = atoi(k.c_str() + 1);
    if (n >= 1 && n <= 20) return (WORD)(VK_F1 + n - 1);
  }
  return 0;
}

static bool IsModifierVk(DWORD vk) {
  switch (vk) {
    case VK_LCONTROL: case VK_RCONTROL: case VK_LMENU: case VK_RMENU:
    case VK_LSHIFT: case VK_RSHIFT: case VK_LWIN: case VK_RWIN:
      return true;
  }
  return false;
}

static unsigned FlagOf(DWORD vk) {
  switch (vk) {
    case VK_LCONTROL: case VK_RCONTROL: return CTRL;
    case VK_LMENU: case VK_RMENU: return ALT;
    case VK_LSHIFT: case VK_RSHIFT: return SHIFT;
    case VK_LWIN: case VK_RWIN: return WIN;
  }
  return 0;
}

struct Rule {
  std::string name;
  WORD trigger = 0;
  std::set<DWORD> triggers;  // 单修饰键触发可匹配的键（"shift" 含左右）
  unsigned reqFlags = 0;     // 精确匹配的通用修饰键
  std::vector<DWORD> sides;  // 必须按着的某一侧修饰键（rctrl 等）
  bool modifierOnly = false;
};

static std::vector<Rule> g_rules;
static const Rule *g_active = nullptr;
static bool g_held[256];               // 物理按键状态（不含模拟按键）
static std::set<DWORD> g_swallowedMods; // 吞掉了按下的修饰键：抬起也要吞
static bool g_maskPending = false;      // 需要补发菜单屏蔽键（见 SendMenuMask）
static const Rule *g_pending = nullptr; // 单修饰键触发：已按下、尚未确认（见 OnPending）
static const UINT HOLD_MS = 150;
static UINT_PTR g_holdTimer = 0;
static bool g_replay = false;           // --replay：不用计时器，由 "tick" 行代替

static void StartHoldTimer() {
  if (!g_replay) g_holdTimer = SetTimer(nullptr, 0, HOLD_MS, nullptr);
}
static void StopHoldTimer() {
  if (g_holdTimer) KillTimer(nullptr, g_holdTimer);
  g_holdTimer = 0;
}
static DWORD g_mainThread = 0;
static const UINT WM_MT_MASK = WM_APP + 1;
static const WORD MENU_MASK_VK = 0xE8;  // 未分配的虚拟键

/** 在钩子返回之后（消息循环里）发送，保证排在触发键的按下之后 */
static void SendMenuMask() {
  INPUT in[2] = {};
  in[0].type = in[1].type = INPUT_KEYBOARD;
  in[0].ki.wVk = in[1].ki.wVk = MENU_MASK_VK;
  in[1].ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(2, in, sizeof(INPUT));
}

/**
 * 事件输出：钩子安装后交给写入线程（WriterLoop）。钩子回调里同步写管道的话，管道一堵（主进程忙）回调就阻塞，
 * 超过 LowLevelHooksTimeout 系统会静默卸掉钩子。安装钩子前（ready 之前）与 --replay 直接写。
 */
static std::mutex g_outLock;
static std::condition_variable g_outReady;
static std::deque<std::string> g_outQueue;
static bool g_outAsync = false;

static void WriteLine(const std::string &line) {
  // 写不进去 = 主进程已经不在（管道断开）：退出，不留下没人接收的全局钩子
  if (fwrite(line.data(), 1, line.size(), stdout) != line.size() || fflush(stdout) != 0) ExitProcess(0);
}

static DWORD WINAPI WriterLoop(LPVOID) {
  for (;;) {
    std::string line;
    {
      std::unique_lock<std::mutex> lk(g_outLock);
      g_outReady.wait(lk, [] { return !g_outQueue.empty(); });
      line = std::move(g_outQueue.front());
      g_outQueue.pop_front();
    }
    WriteLine(line);
  }
}

static void Emit(const std::string &name, const char *phase) {
  std::string line = "{\"name\":" + JsonString(name) + ",\"phase\":\"" + phase + "\"}\n";
  if (!g_outAsync) return WriteLine(line);
  {
    std::lock_guard<std::mutex> g(g_outLock);
    g_outQueue.push_back(std::move(line));
  }
  g_outReady.notify_one();
}

/** 本次事件生效后的物理按键状态 */
static bool Down(DWORD vk, DWORD curVk, bool curDown) { return vk == curVk ? curDown : g_held[vk & 0xff]; }

static unsigned HeldFlags(DWORD curVk, bool curDown) {
  unsigned f = 0;
  if (Down(VK_LCONTROL, curVk, curDown) || Down(VK_RCONTROL, curVk, curDown)) f |= CTRL;
  if (Down(VK_LMENU, curVk, curDown) || Down(VK_RMENU, curVk, curDown)) f |= ALT;
  if (Down(VK_LSHIFT, curVk, curDown) || Down(VK_RSHIFT, curVk, curDown)) f |= SHIFT;
  if (Down(VK_LWIN, curVk, curDown) || Down(VK_RWIN, curVk, curDown)) f |= WIN;
  return f;
}

static bool SidesHeld(const Rule &r, DWORD curVk, bool curDown) {
  for (DWORD s : r.sides)
    if (!Down(s, curVk, curDown)) return false;
  return true;
}

static bool ModifiersMatch(const Rule &r, DWORD curVk, bool curDown) {
  return HeldFlags(curVk, curDown) == r.reqFlags && SidesHeld(r, curVk, curDown);
}

/** 返回 true = 吞掉该事件 */
/**
 * 单修饰键触发挂起期间（按下不到 HOLD_MS）：
 * - 松开触发键 = 轻按：补发 down + up；
 * - 按下的键组成注册组合（rshift+space、rshift+ctrl）：直接发那条组合的 down，并吞掉该键；
 * - 按下其他键（如右 Shift+字母打大写）：悄悄放弃，什么都不发，按键照常传给系统。
 * 返回 1 = 吞掉、0 = 放行、-1 = 已放弃挂起，继续按空闲状态处理。
 */
static int OnPending(DWORD vk, bool isDown, bool repeat) {
  const Rule &p = *g_pending;
  if (p.triggers.count(vk)) {
    if (isDown) return 0; // 按住时的自动重复
    StopHoldTimer();
    g_pending = nullptr;
    Emit(p.name, "down");
    Emit(p.name, "up");
    return 0;
  }
  if (!isDown) return 0;
  if (repeat) return 0;
  StopHoldTimer();
  g_pending = nullptr;
  for (const Rule &r : g_rules) {
    bool combo = IsModifierVk(vk) ? r.modifierOnly && r.triggers.count(vk) && !r.sides.empty() && ModifiersMatch(r, vk, true)
                                  : !r.modifierOnly && r.trigger == vk && ModifiersMatch(r, vk, true);
    if (!combo) continue;
    Emit(r.name, "down");
    g_active = &r;
    if (IsModifierVk(vk)) g_swallowedMods.insert(vk);
    return 1;
  }
  return -1;
}

/** 挂起满 HOLD_MS 且期间没有别的键：确认按住 */
static void ConfirmPending() {
  StopHoldTimer();
  if (!g_pending) return;
  Emit(g_pending->name, "down");
  g_active = g_pending;
  g_pending = nullptr;
}

static bool OnKey(DWORD vk, bool isDown, bool repeat) {
  if (g_pending) {
    int r = OnPending(vk, isDown, repeat);
    if (r >= 0) return r == 1;
  }
  if (!IsModifierVk(vk)) {
    if (g_active) {
      const Rule &a = *g_active;
      if (a.modifierOnly) {
        if (!isDown) return false;
        // 按住单修饰键时按下的键组成另一条注册组合（如 rctrl+space）：撤销当前触发，改发那条组合
        if (!repeat)
          for (const Rule &r : g_rules)
            if (!r.modifierOnly && r.trigger == vk && ModifiersMatch(r, vk, true)) {
              Emit(a.name, "abort");
              Emit(r.name, "down");
              g_active = &r;
              return true;
            }
        // 否则视为普通组合键（如 rctrl+c），放弃本次触发，按键照常传给系统
        Emit(a.name, "abort");
        g_active = nullptr;
        return false;
      }
      if (vk == a.trigger) {
        if (!isDown) {
          Emit(a.name, "up");
          g_active = nullptr;
        }
        return true; // 吞掉触发键（含按住时的自动重复）
      }
      return false;
    }
    if (isDown && !repeat)
      for (const Rule &r : g_rules)
        if (!r.modifierOnly && r.trigger == vk && ModifiersMatch(r, vk, true)) {
          Emit(r.name, "down");
          g_active = &r;
          return true;
        }
    return false;
  }

  // 修饰键
  bool swallowed = g_swallowedMods.count(vk) > 0;
  if (!isDown && swallowed) g_swallowedMods.erase(vk);
  if (g_active) {
    const Rule &a = *g_active;
    if (a.modifierOnly) {
      if (a.triggers.count(vk)) {
        if (!isDown) {
          Emit(a.name, "up");
          g_active = nullptr;
        }
        return swallowed; // 按住时的自动重复照常传递（被吞的组合修饰键继续吞）
      }
      if (isDown && !repeat) {
        // 按住单修饰键时又按下另一个修饰键：组成注册组合（rctrl+shift）则切换过去，否则放弃
        for (const Rule &r : g_rules)
          if (r.modifierOnly && &r != g_active && r.triggers.count(vk) && !r.sides.empty() && ModifiersMatch(r, vk, true)) {
            Emit(a.name, "abort");
            Emit(r.name, "down");
            g_active = &r;
            g_swallowedMods.insert(vk);
            return true;
          }
        Emit(a.name, "abort");
        g_active = nullptr;
      }
      return swallowed;
    }
    // 普通键触发：先松开修饰键也算结束
    if (!isDown && ((HeldFlags(vk, false) & a.reqFlags) != a.reqFlags || !SidesHeld(a, vk, false))) {
      Emit(a.name, "up");
      g_active = nullptr;
    }
    return swallowed;
  }
  if (isDown && !repeat) {
    for (const Rule &r : g_rules) {
      if (!r.modifierOnly || !r.triggers.count(vk)) continue;
      // 单修饰键触发要求没有其他修饰键；修饰键组合（rctrl+shift）要求恰好是 require 里的修饰键
      unsigned others = HeldFlags(vk, true) & ~FlagOf(vk);
      if (others != (r.reqFlags & ~FlagOf(vk)) || !SidesHeld(r, vk, true)) continue;
      if (!r.sides.empty()) {
        Emit(r.name, "down");
        g_active = &r;
        g_swallowedMods.insert(vk);
        return true;
      }
      // 单修饰键触发先挂起，按住满 HOLD_MS 才确认（见 OnPending）：避免右 Shift+字母打大写时误开录音
      g_pending = &r;
      StartHoldTimer();
      // 单独按下再松开 Alt / Win 会激活菜单栏 / 开始菜单：钩子返回后补发一个未分配的键，让系统认为它被组合使用了
      if (FlagOf(vk) & (ALT | WIN)) g_maskPending = true;
      return false;
    }
  }
  return swallowed;
}

static HHOOK g_hook;

static LRESULT CALLBACK HookProc(int code, WPARAM wp, LPARAM lp) {
  if (code == HC_ACTION) {
    auto *k = (KBDLLHOOKSTRUCT *)lp;
    // 程序模拟的按键（mt-inject 键入、其他软件）不参与匹配，也不计入物理按键状态
    // AltGr 布局（德语、法语等）按右 Alt 时系统先插一个假的左 Ctrl（扫描码 0x21D）：不当成真的 Ctrl
    bool fakeCtrl = k->vkCode == VK_LCONTROL && (k->scanCode & 0x200);
    if (!(k->flags & LLKHF_INJECTED) && !fakeCtrl && k->vkCode < 256) {
      bool isDown = !(k->flags & LLKHF_UP);
      DWORD vk = k->vkCode;
      bool repeat = isDown && g_held[vk];
      bool swallow = OnKey(vk, isDown, repeat);
      g_held[vk] = isDown;
      if (g_maskPending) {
        g_maskPending = false;
        PostThreadMessageW(g_mainThread, WM_MT_MASK, 0, 0);
      }
      if (swallow) return 1;
    }
  }
  return CallNextHookEx(g_hook, code, wp, lp);
}

/**
 * 主进程（HotkeyWatcher）启动本助手时开着 stdin 管道：主进程退出（含崩溃）管道即关闭，读到结尾就退出。
 * 不依赖父进程号（快照里的父进程号可能已被复用、也可能拿不到句柄），是 WatchParent 之外的兜底。
 * 只在 stdin 是管道时生效（命令行直接运行时 stdin 是控制台 / NUL，不能据此退出）。
 */
static void ExitWhenStdinCloses() {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  if (!in || in == INVALID_HANDLE_VALUE || GetFileType(in) != FILE_TYPE_PIPE) return;
  CreateThread(
      nullptr, 0,
      [](LPVOID h) -> DWORD {
        char buf[256];
        DWORD got = 0;
        while (ReadFile((HANDLE)h, buf, sizeof buf, &got, nullptr) && got) {
          // 主进程不往 stdin 写东西；读到的内容丢弃
        }
        ExitProcess(0);
      },
      in, 0, nullptr);
}

/** 父进程退出后自行退出（主进程崩溃时不留下全局键盘钩子） */
static DWORD WINAPI WatchParent(LPVOID) {
  DWORD self = GetCurrentProcessId(), parent = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W pe{sizeof pe};
  if (snap != INVALID_HANDLE_VALUE) {
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe))
      if (pe.th32ProcessID == self) parent = pe.th32ParentProcessID;
    CloseHandle(snap);
  }
  HANDLE h = parent ? OpenProcess(SYNCHRONIZE, FALSE, parent) : nullptr;
  if (!h) return 0; // 拿不到父进程句柄：不监视
  WaitForSingleObject(h, INFINITE);
  ExitProcess(0);
}

/**
 * 测试用（mt-hotkey '<config>' --replay）：不安装钩子，从 stdin 逐行读 "<键名> down|up"（"tick" = 按住满 HOLD_MS），
 * 按与钩子相同的状态机处理；事件照常输出，被吞掉的按键另输出 {"swallowed":"<行>"}。
 */
static int Replay() {
  g_replay = true;
  std::string input = ReadAllStdin(), line;
  for (size_t i = 0; i <= input.size(); i++) {
    if (i < input.size() && input[i] != '\n') {
      if (input[i] != '\r') line += input[i];
      continue;
    }
    if (line == "tick") ConfirmPending(); // 相当于按住满 HOLD_MS
    size_t sp = line.find(' ');
    if (sp != std::string::npos) {
      std::string key = line.substr(0, sp), phase = line.substr(sp + 1);
      auto mod = kModifierKeys.find(key);
      DWORD vk = mod != kModifierKeys.end() ? mod->second[0] : NormalKey(key);
      if (vk) {
        bool isDown = phase == "down";
        bool repeat = isDown && g_held[vk];
        bool swallow = OnKey(vk, isDown, repeat);
        g_held[vk] = isDown;
        if (swallow) {
          std::string out = "{\"swallowed\":" + JsonString(line) + "}\n";
          fwrite(out.data(), 1, out.size(), stdout);
        }
        if (g_maskPending) {
          g_maskPending = false;
          std::string out = "{\"masked\":" + JsonString(line) + "}\n";
          fwrite(out.data(), 1, out.size(), stdout);
        }
      }
    }
    line.clear();
  }
  fflush(stdout);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  Json cfg;
  std::string text = argc > 1 ? WideToUtf8(argv[1]) : "";
  Parser parser{text.c_str()};
  if (text.empty() || !parser.parse(cfg) || cfg.type != Json::Obj || !cfg.obj.count("matches") || cfg.obj["matches"].type != Json::Arr) {
    fputs("invalid config\n", stderr);
    return 2;
  }
  static const std::map<std::string, unsigned> flagNames = {
      {"opt", ALT}, {"option", ALT}, {"alt", ALT}, {"cmd", WIN}, {"command", WIN},
      {"ctrl", CTRL}, {"control", CTRL}, {"shift", SHIFT}};
  for (Json &m : cfg.obj["matches"].arr) {
    if (m.type != Json::Obj || m.obj["name"].type != Json::Str || m.obj["key"].type != Json::Str) continue;
    Rule r;
    r.name = m.obj["name"].str;
    std::string key = m.obj["key"].str;
    for (auto &c : key) c = (char)tolower((unsigned char)c);
    auto mod = kModifierKeys.find(key);
    if (mod != kModifierKeys.end()) {
      r.modifierOnly = true;
      r.triggers.insert(mod->second.begin(), mod->second.end());
      r.trigger = mod->second[0];
      r.reqFlags |= FlagOf(r.trigger);
    } else if (!(r.trigger = NormalKey(key))) {
      fprintf(stderr, "unknown key: %s\n", key.c_str());
      continue;
    }
    bool ok = true;
    for (Json &q : m.obj["require"].arr) {
      std::string req = q.str;
      for (auto &c : req) c = (char)tolower((unsigned char)c);
      auto f = flagNames.find(req);
      auto side = kModifierKeys.find(req);
      if (f != flagNames.end()) {
        r.reqFlags |= f->second;
      } else if (side != kModifierKeys.end() && side->second.size() == 1) {
        r.sides.push_back(side->second[0]);
        r.reqFlags |= FlagOf(side->second[0]);
      } else {
        fprintf(stderr, "unknown modifier: %s\n", req.c_str()); // 如 fn：Windows 读不到
        ok = false;
      }
    }
    if (ok) g_rules.push_back(std::move(r));
  }
  if (g_rules.empty()) {
    fputs("no valid matches\n", stderr);
    return 2;
  }

  if (argc > 2 && wcscmp(argv[2], L"--replay") == 0) return Replay();

  // 已经按着的键（助手重启时）计入状态，避免把自动重复当成新按下
  for (int vk = 1; vk < 256; vk++) g_held[vk] = (GetAsyncKeyState(vk) & 0x8000) != 0;

  CreateThread(nullptr, 0, WatchParent, nullptr, 0, nullptr);
  ExitWhenStdinCloses();
  g_mainThread = GetCurrentThreadId();
  g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, HookProc, GetModuleHandleW(nullptr), 0);
  if (!g_hook) {
    fputs("hook install failed\n", stderr);
    return 4;
  }
  Emit("system", "ready");
  g_outAsync = true;
  CreateThread(nullptr, 0, WriterLoop, nullptr, 0, nullptr);
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    if (msg.message == WM_MT_MASK) {
      SendMenuMask();
      continue;
    }
    if (msg.message == WM_TIMER && msg.wParam == g_holdTimer) {
      ConfirmPending();
      continue;
    }
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  UnhookWindowsHookEx(g_hook);
  return 0;
}
