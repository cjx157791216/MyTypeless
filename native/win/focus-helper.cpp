// mt-focus（Windows 版，原创）。协议同 macOS 版（docs/contracts/native-helpers.md）：
//   mt-focus                          → {"bundleId","name","pid"}：前台窗口所属程序；取不到时 {}
//                                       bundleId 用小写 exe 文件名（如 code.exe），name 用程序的文件描述（如 Visual Studio Code）
//   mt-focus --activate <pid>         → 把该进程的窗口切到前台；进程不存在退出码 2，切换失败 4
//   mt-focus --selected-text          → 焦点输入框中选中文字的 base64（UI Automation，不碰剪贴板）；没有选中 / 不支持 / 密码框退出码 5
//   mt-focus --caret-context <前> <后> → {"text","caret","pid"}：光标前后各若干字符（自动词典追踪修改用，D-012）；
//                                       只输出这一段；不支持 / 密码框退出码 5。两者在目标应用没响应时超时也按 5 处理
#include "process-info.h"
#include <wctype.h>
#include <ole2.h>  // common.h 定义了 WIN32_LEAN_AND_MEAN，UI Automation 需要的 OLE 定义要单独引入
#include <UIAutomation.h>
#include <wrl/client.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
using Microsoft::WRL::ComPtr;

/** UWP 应用的顶层窗口属于 ApplicationFrameHost.exe：找出里面真正的应用进程 */
static DWORD UwpChildPid(HWND frame, DWORD framePid) {
  struct Ctx { DWORD framePid, found; } ctx{framePid, 0};
  EnumChildWindows(
      frame,
      [](HWND child, LPARAM lp) -> BOOL {
        auto *c = (Ctx *)lp;
        DWORD pid = 0;
        GetWindowThreadProcessId(child, &pid);
        if (pid && pid != c->framePid) {
          c->found = pid;
          return FALSE;
        }
        return TRUE;
      },
      (LPARAM)&ctx);
  return ctx.found;
}

/** 前台窗口所属程序的 pid 与 exe 路径（UWP 应用取外壳里真正的应用） */
static DWORD FrontPid(std::wstring &path) {
  HWND hwnd = GetForegroundWindow();
  DWORD pid = 0;
  if (hwnd) GetWindowThreadProcessId(hwnd, &pid);
  path = pid ? ExePath(pid) : L"";
  if (!path.empty() && Lower(FileName(path)) == L"applicationframehost.exe") {
    if (DWORD child = UwpChildPid(hwnd, pid)) {
      pid = child;
      path = ExePath(pid);
    }
  }
  return pid;
}

static int PrintFrontApp() {
  std::wstring path;
  DWORD pid = FrontPid(path);
  if (!pid || path.empty()) {
    WriteStdout("{}\n");
    return 0;
  }
  std::wstring exe = FileName(path);
  std::wstring name = DisplayName(path);
  WriteStdout("{\"bundleId\":" + JsonString(WideToUtf8(Lower(exe))) + ",\"name\":" + JsonString(WideToUtf8(name)) +
              ",\"pid\":" + std::to_string(pid) + "}\n");
  return 0;
}

/** 该进程最上层的可见主窗口（没有所有者的顶层窗口，按 Z 序第一个） */
static HWND MainWindowOf(DWORD pid) {
  struct Ctx { DWORD pid; HWND found; } ctx{pid, nullptr};
  EnumWindows(
      [](HWND h, LPARAM lp) -> BOOL {
        auto *c = (Ctx *)lp;
        DWORD p = 0;
        GetWindowThreadProcessId(h, &p);
        if (p != c->pid || !IsWindowVisible(h) || GetWindow(h, GW_OWNER)) return TRUE;
        c->found = h;
        return FALSE;
      },
      (LPARAM)&ctx);
  return ctx.found;
}

static int Activate(DWORD pid) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return 2;
  CloseHandle(proc);
  HWND target = MainWindowOf(pid);
  if (!target) return 4;
  if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
  // 前台锁：只有当前前台线程才能随意切换前台窗口——临时把输入队列挂到前台线程上再切换
  HWND fg = GetForegroundWindow();
  DWORD fgThread = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
  DWORD self = GetCurrentThreadId();
  bool attached = fgThread && fgThread != self && AttachThreadInput(self, fgThread, TRUE);
  // 不要 SetFocus(target)：那会把焦点从窗口里的输入框移到窗口本身；SetForegroundWindow 会恢复原来的焦点控件
  SetForegroundWindow(target);
  BringWindowToTop(target);
  if (attached) AttachThreadInput(self, fgThread, FALSE);
  return GetForegroundWindow() == target ? 0 : 4;
}

// ---------- 选区与光标附近文字（UI Automation，D-012） ----------

struct UiaJob {
  bool caret = false;  // false：--selected-text；true：--caret-context
  int before = 0, after = 0;
  int code = 5;        // 默认“读不到”
  bool password = false; // UI Automation 认出焦点是密码框：什么都不读，后备读取也跳过
  std::string out;
};

static std::wstring RangeText(IUIAutomationTextRange *r) {
  BSTR b = nullptr;
  std::wstring s;
  if (SUCCEEDED(r->GetText(-1, &b)) && b) {
    s.assign(b, SysStringLen(b));
    SysFreeString(b);
  }
  return s;
}

/**
 * 焦点元素的文本模式。密码框一律不读。Chromium / Electron 应用要等有 UI Automation 客户端来问才建立辅助功能树，
 * 第一次拿不到时等一下再问一次（对应 macOS 版打开 AXManualAccessibility 后重试）。
 */
/**
 * Chromium / Electron 应用（VS Code、Slack、浏览器…）默认不开辅助功能，单靠 UI Automation 查询唤不醒：
 * 向页面窗口（旧版 Chrome_RenderWidgetHostHWND，新版为顶层 Chrome_WidgetWin_*）发一次 MSAA 客户区查询（WM_GETOBJECT / OBJID_CLIENT），
 * Chromium 据此开启辅助功能并建立辅助功能树（对应 macOS 版设置 AXManualAccessibility）。返回是否找到了这样的窗口。
 */
static bool WakeChromiumAccessibility() {
  HWND fg = GetForegroundWindow();
  if (!fg) return false;
  HWND found = nullptr;
  EnumChildWindows(
      fg,
      [](HWND h, LPARAM lp) -> BOOL {
        wchar_t cls[64] = {};
        GetClassNameW(h, cls, 64);
        if (wcscmp(cls, L"Chrome_RenderWidgetHostHWND") != 0) return TRUE;
        *(HWND *)lp = h;
        return FALSE;
      },
      (LPARAM)&found);
  if (!found) {
    // 新版 Chromium（Electron 33 起实测）去掉了页面子窗口，辅助功能由顶层窗口 Chrome_WidgetWin_* 直接提供
    wchar_t cls[64] = {};
    GetClassNameW(fg, cls, 64);
    if (wcsncmp(cls, L"Chrome_WidgetWin_", 17) != 0) return false;
    found = fg;
  }
  DWORD_PTR ignored = 0;
  SendMessageTimeoutW(found, WM_GETOBJECT, 0, (LPARAM)OBJID_CLIENT, SMTO_ABORTIFHUNG, 300, &ignored);
  return true;
}

static bool FocusedTextPattern(IUIAutomation *uia, ComPtr<IUIAutomationTextPattern> &tp, bool &password) {
  bool chromium = false;
  for (int attempt = 0; attempt < 4; attempt++) {
    if (attempt == 1) chromium = WakeChromiumAccessibility();
    if (attempt && !chromium) break;      // 不是 Chromium：没必要等
    if (attempt) Sleep(100 * attempt);    // 辅助功能树建好需要一点时间

    ComPtr<IUIAutomationElement> el;
    if (FAILED(uia->GetFocusedElement(&el)) || !el) continue;
    BOOL isPassword = FALSE;
    if (SUCCEEDED(el->get_CurrentIsPassword(&isPassword)) && isPassword) {
      password = true;
      return false;
    }
    if (SUCCEEDED(el->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&tp))) && tp) return true;
  }
  return false;
}

/** 第一个选区（没有选中时是光标处的空范围） */
static bool FirstSelection(IUIAutomationTextPattern *tp, ComPtr<IUIAutomationTextRange> &range) {
  ComPtr<IUIAutomationTextRangeArray> sel;
  int n = 0;
  if (FAILED(tp->GetSelection(&sel)) || !sel || FAILED(sel->get_Length(&n)) || n < 1) return false;
  return SUCCEEDED(sel->GetElement(0, &range)) && range;
}

/** 选区起点处的空范围 */
static bool CollapsedAtStart(IUIAutomationTextRange *range, ComPtr<IUIAutomationTextRange> &out) {
  if (FAILED(range->Clone(&out)) || !out) return false;
  return SUCCEEDED(out->MoveEndpointByRange(TextPatternRangeEndpoint_End, out.Get(), TextPatternRangeEndpoint_Start));
}

/** 输出：选中文字（base64）或光标前后的一段（JSON） */
static void Finish(UiaJob &job, const std::wstring &selected, const std::wstring &head, const std::wstring &tail) {
  if (!job.caret) {
    bool any = false;
    for (wchar_t c : selected) any = any || !iswspace(c);
    if (!any) return;
    job.out = Base64Encode(WideToUtf8(selected)) + "\n";
    job.code = 0;
    return;
  }
  if (head.empty() && tail.empty()) return;
  std::wstring path;
  DWORD pid = FrontPid(path);
  // caret 按 UTF-16 计数（= 光标前读到的文字长度），与 JS 字符串下标一致
  job.out = "{\"text\":" + JsonString(WideToUtf8(head + tail)) + ",\"caret\":" + std::to_string(head.size()) + ",\"pid\":" + std::to_string(pid) + "}\n";
  job.code = 0;
}

/**
 * 后备：不提供 UI Automation 文本模式的标准编辑框（类名含 Edit / RichEdit，如 WinForms 文本框）直接发窗口消息读取。
 * 密码框（ES_PASSWORD）不读；EM_GETSEL 的返回值只有 16 位，超过 65535 个字符的不读。
 */
static bool ReadEditControl(UiaJob &job) {
  GUITHREADINFO gui{sizeof gui};
  HWND fg = GetForegroundWindow();
  if (!fg || !GetGUIThreadInfo(GetWindowThreadProcessId(fg, nullptr), &gui) || !gui.hwndFocus) return false;
  HWND h = gui.hwndFocus;
  wchar_t cls[128] = {};
  GetClassNameW(h, cls, 128);
  std::wstring c = Lower(cls);
  if (c.find(L"edit") == std::wstring::npos) return false;
  if (GetWindowLongW(h, GWL_STYLE) & ES_PASSWORD) return true; // 是编辑框但不读：按“读不到”结束
  DWORD_PTR len = 0, sel = 0;
  if (!SendMessageTimeoutW(h, WM_GETTEXTLENGTH, 0, 0, SMTO_ABORTIFHUNG, 300, &len) || len > 65535) return true;
  if (!SendMessageTimeoutW(h, EM_GETSEL, 0, 0, SMTO_ABORTIFHUNG, 300, &sel)) return true;
  std::wstring text(len + 1, L'\0');
  DWORD_PTR got = 0;
  if (!SendMessageTimeoutW(h, WM_GETTEXT, len + 1, (LPARAM)text.data(), SMTO_ABORTIFHUNG, 300, &got)) return true;
  text.resize(got);
  size_t start = LOWORD(sel), end = HIWORD(sel);
  if (start > text.size() || end > text.size() || start > end) return true;
  size_t from = start > (size_t)job.before ? start - job.before : 0;
  size_t to = start + job.after < text.size() ? start + job.after : text.size();
  Finish(job, text.substr(start, end - start), text.substr(from, start - from), text.substr(start, to - start));
  return true;
}

static void ReadViaUia(UiaJob &job) {
  ComPtr<IUIAutomation> uia;
  if (FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia))) || !uia) return;
  ComPtr<IUIAutomationTextPattern> tp;
  ComPtr<IUIAutomationTextRange> range;
  if (!FocusedTextPattern(uia.Get(), tp, job.password) || !FirstSelection(tp.Get(), range)) return;

  if (!job.caret) return Finish(job, RangeText(range.Get()), L"", L"");

  // 光标（选区起点）前后各取若干字符：只读这一段，输入框其余内容不离开本助手
  ComPtr<IUIAutomationTextRange> head, tail;
  if (!CollapsedAtStart(range.Get(), head) || !CollapsedAtStart(range.Get(), tail)) return;
  int moved = 0;
  head->MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -job.before, &moved);
  tail->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, job.after, &moved);
  std::wstring after = RangeText(tail.Get());
  // 读到了文本末尾：Chromium 会在末尾多给几个空格（空输入框也有），去掉
  if (moved < job.after)
    while (!after.empty() && after.back() == L' ') after.pop_back();
  Finish(job, L"", RangeText(head.Get()), after);
}

static DWORD WINAPI UiaThread(LPVOID p) {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 0;
  auto &job = *(UiaJob *)p;
  ReadViaUia(job);
  // 有的编辑框（如 WinForms 文本框）经系统代理声称支持文本模式，读出来却是空的：再按标准编辑框直接读一次
  if (job.code != 0 && !job.password) ReadEditControl(job);
  CoUninitialize();
  return 0;
}

/** 在单独线程里做：目标应用没响应时 UI Automation 调用可能卡很久，超时就按“读不到”处理 */
static int RunUia(UiaJob &job, DWORD timeoutMs) {
  HANDLE t = CreateThread(nullptr, 0, UiaThread, &job, 0, nullptr);
  if (!t) return 5;
  if (WaitForSingleObject(t, timeoutMs) != WAIT_OBJECT_0) ExitProcess(5);
  CloseHandle(t);
  if (job.code == 0) WriteStdout(job.out);
  return job.code;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 1) return PrintFrontApp();
  if (argc == 3 && wcscmp(argv[1], L"--activate") == 0) {
    wchar_t *end = nullptr;
    unsigned long pid = wcstoul(argv[2], &end, 10);
    if (!pid || (end && *end)) return 2;
    return Activate((DWORD)pid);
  }
  if (argc == 2 && wcscmp(argv[1], L"--selected-text") == 0) {
    UiaJob job;
    return RunUia(job, 800); // 调用方超时 1 秒
  }
  if (argc == 4 && wcscmp(argv[1], L"--caret-context") == 0) {
    UiaJob job;
    job.caret = true;
    wchar_t *endBefore = nullptr, *endAfter = nullptr;
    long before = wcstol(argv[2], &endBefore, 10), after = wcstol(argv[3], &endAfter, 10);
    if (endBefore == argv[2] || *endBefore || endAfter == argv[3] || *endAfter) return 2; // 不是整数
    if (before < 0 || after < 0 || (long long)before + after <= 0) return 2;
    job.before = (int)before;
    job.after = (int)after;
    return RunUia(job, 1200); // 调用方超时 1.5 秒
  }
  fputs("usage: mt-focus [--activate <pid> | --selected-text | --caret-context <before> <after>]\n", stderr);
  return 2;
}
