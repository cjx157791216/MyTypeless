// mt-inject（Windows 版，原创）。协议同 macOS 版（docs/contracts/native-helpers.md）：
//   mt-inject <base64>             以 Unicode 键盘事件键入文本（16 字符一块；换行发回车键）
//   mt-inject --paste <base64>     备份剪贴板全部格式 → 写入文本 → Ctrl+V → 约 0.45 秒后恢复（期间被他人改过则不恢复）
//   mt-inject --combo ctrl+c       发送组合键（cmd 按 Ctrl 处理；字母、return、space）
//   mt-inject --copy-selection     Ctrl+C 后等剪贴板变化（≤600ms），stdout 输出选中文本的 base64，并恢复剪贴板；没有选中退出码 5
// 退出码：0 成功 / 2 参数错误 / 4 注入失败 / 5 没有选中文本。Windows 没有辅助功能授权，不返回 3。
// 隐私（D-002）：写进剪贴板的临时内容带“不进剪贴板历史、不上传云剪贴板”的标记。
#include "common.h"
#include <vector>

static void Sleep_(DWORD ms) { Sleep(ms); }

// ---------- 键盘事件 ----------

static INPUT KeyInput(WORD vk, bool down, WORD scan = 0, DWORD flags = 0) {
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk;
  in.ki.wScan = scan;
  in.ki.dwFlags = flags | (down ? 0 : KEYEVENTF_KEYUP);
  return in;
}

static bool Send(std::vector<INPUT> &inputs) {
  if (inputs.empty()) return true;
  UINT sent = SendInput((UINT)inputs.size(), inputs.data(), sizeof(INPUT));
  return sent == inputs.size();
}

/**
 * 用户可能还按着修饰键（快捷键刚松开、免手持时按着 Shift…）：键入的字符会变成快捷键。
 * 先把仍按下的修饰键松开；单独松开 Alt / Win 会激活菜单栏 / 开始菜单，先插一个未分配的键挡住。
 */
static void ReleaseHeldModifiers() {
  static const WORD mods[] = {VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN};
  std::vector<INPUT> ups;
  bool altOrWin = false;
  for (WORD vk : mods) {
    if (!(GetAsyncKeyState(vk) & 0x8000)) continue;
    if (vk == VK_LMENU || vk == VK_RMENU || vk == VK_LWIN || vk == VK_RWIN) altOrWin = true;
    ups.push_back(KeyInput(vk, false));
  }
  if (ups.empty()) return;
  std::vector<INPUT> all;
  if (altOrWin) {
    all.push_back(KeyInput(0xE8, true)); // 0xE8：未分配的虚拟键
    all.push_back(KeyInput(0xE8, false));
  }
  all.insert(all.end(), ups.begin(), ups.end());
  Send(all);
  Sleep_(10);
}

static bool TypeUnicode(const std::wstring &text) {
  ReleaseHeldModifiers();
  std::vector<INPUT> batch;
  size_t units = 0;
  auto flush = [&]() {
    bool ok = Send(batch);
    batch.clear();
    units = 0;
    Sleep_(3);
    return ok;
  };
  for (size_t i = 0; i < text.size(); i++) {
    wchar_t c = text[i];
    if (c == L'\r') continue;
    if (c == L'\n') {
      batch.push_back(KeyInput(VK_RETURN, true));
      batch.push_back(KeyInput(VK_RETURN, false));
    } else {
      batch.push_back(KeyInput(0, true, c, KEYEVENTF_UNICODE));
      batch.push_back(KeyInput(0, false, c, KEYEVENTF_UNICODE));
    }
    // 16 个字符一块；不把一对代理项（emoji 等）拆到两块里
    if (++units >= 16 && !IS_HIGH_SURROGATE(c) && !flush()) return false;
  }
  return flush();
}

static WORD KeyForName(const std::string &name) {
  if (name.size() == 1 && isalpha((unsigned char)name[0])) return (WORD)toupper((unsigned char)name[0]);
  if (name == "return" || name == "enter") return VK_RETURN;
  if (name == "space") return VK_SPACE;
  return 0;
}

static WORD ModifierForName(const std::string &name) {
  if (name == "cmd" || name == "command" || name == "ctrl" || name == "control") return VK_CONTROL;
  if (name == "opt" || name == "option" || name == "alt") return VK_MENU;
  if (name == "shift") return VK_SHIFT;
  return 0;
}

/** "ctrl+c" → 依次按下修饰键、按键，再反序松开；无法识别时返回 false */
static bool PostCombo(std::string combo) {
  for (auto &c : combo) c = (char)tolower((unsigned char)c);
  std::vector<std::string> parts;
  size_t start = 0;
  while (start <= combo.size()) {
    size_t plus = combo.find('+', start);
    if (plus == std::string::npos) plus = combo.size();
    std::string p = combo.substr(start, plus - start);
    while (!p.empty() && p.front() == ' ') p.erase(p.begin());
    while (!p.empty() && p.back() == ' ') p.pop_back();
    if (!p.empty()) parts.push_back(p);
    start = plus + 1;
  }
  if (parts.empty()) return false;
  WORD key = KeyForName(parts.back());
  if (!key) return false;
  std::vector<WORD> mods;
  for (size_t i = 0; i + 1 < parts.size(); i++) {
    WORD m = ModifierForName(parts[i]);
    if (!m) return false;
    mods.push_back(m);
  }
  ReleaseHeldModifiers();
  std::vector<INPUT> seq;
  for (WORD m : mods) seq.push_back(KeyInput(m, true));
  seq.push_back(KeyInput(key, true));
  seq.push_back(KeyInput(key, false));
  for (auto it = mods.rbegin(); it != mods.rend(); ++it) seq.push_back(KeyInput(*it, false));
  return Send(seq);
}

// ---------- 剪贴板 ----------

/** 剪贴板可能正被目标应用占用：重试一会儿 */
static bool OpenClipboardRetry() {
  for (int i = 0; i < 40; i++) {
    if (OpenClipboard(nullptr)) return true;
    Sleep_(10);
  }
  return false;
}

struct ClipItem {
  UINT format;
  std::string data;    // HGLOBAL 格式的内容
  HENHMETAFILE emf{};  // CF_ENHMETAFILE
};

/**
 * 备份剪贴板的全部格式（文字、富文本、图片、文件列表…），不只是纯文本。
 * 剪贴板一直被别的程序占着、打不开时返回 false——与“原本就是空的”（true + 空列表）区分开：
 * 没备份成功就不能动剪贴板，否则事后“恢复”等于清空，用户原来的内容就丢了。
 */
static bool SnapshotClipboard(std::vector<ClipItem> &items) {
  items.clear();
  if (!OpenClipboardRetry()) return false;
  for (UINT f = EnumClipboardFormats(0); f; f = EnumClipboardFormats(f)) {
    // 由系统从其他格式合成、或不是内存块的格式：跳过（恢复 CF_DIB / CF_UNICODETEXT 后系统会再合成）
    if (f == CF_BITMAP || f == CF_PALETTE || f == CF_METAFILEPICT || f == CF_OWNERDISPLAY || f == CF_DSPBITMAP ||
        f == CF_DSPMETAFILEPICT || f == CF_DSPENHMETAFILE || f == CF_TEXT || f == CF_OEMTEXT ||
        (f >= CF_GDIOBJFIRST && f <= CF_GDIOBJLAST))
      continue;
    HANDLE h = GetClipboardData(f);
    if (!h) continue;
    if (f == CF_ENHMETAFILE) {
      if (HENHMETAFILE copy = CopyEnhMetaFileW((HENHMETAFILE)h, nullptr)) items.push_back({f, {}, copy});
      continue;
    }
    SIZE_T size = GlobalSize(h);
    void *p = size ? GlobalLock(h) : nullptr;
    if (!p) continue;
    items.push_back({f, std::string((const char *)p, size)});
    GlobalUnlock(h);
  }
  CloseClipboard();
  return true;
}

static HGLOBAL GlobalFrom(const void *data, size_t size) {
  HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, size ? size : 1);
  if (!g) return nullptr;
  void *p = GlobalLock(g);
  if (size) memcpy(p, data, size);
  GlobalUnlock(g);
  return g;
}

/** 让 Windows 剪贴板历史（Win+V）与云剪贴板忽略本次写入（打开剪贴板后、SetClipboardData 期间调用） */
static void MarkPrivate() {
  static const UINT exclude = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
  static const UINT history = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
  static const UINT cloud = RegisterClipboardFormatW(L"CanUploadToCloudClipboard");
  DWORD zero = 0;
  SetClipboardData(exclude, GlobalFrom(&zero, sizeof zero));
  SetClipboardData(history, GlobalFrom(&zero, sizeof zero));
  SetClipboardData(cloud, GlobalFrom(&zero, sizeof zero));
}

static bool WriteClipboardText(const std::wstring &text) {
  if (!OpenClipboardRetry()) return false;
  EmptyClipboard();
  bool ok = SetClipboardData(CF_UNICODETEXT, GlobalFrom(text.c_str(), (text.size() + 1) * sizeof(wchar_t))) != nullptr;
  MarkPrivate();
  CloseClipboard();
  return ok;
}

/** 恢复备份（原内容已在剪贴板历史里，恢复的这一份不再记一次） */
static void RestoreClipboard(std::vector<ClipItem> &items) {
  if (!OpenClipboardRetry()) return;
  EmptyClipboard();
  for (auto &it : items) {
    if (it.format == CF_ENHMETAFILE) {
      SetClipboardData(CF_ENHMETAFILE, it.emf);
      it.emf = nullptr; // 所有权交给剪贴板
    } else {
      SetClipboardData(it.format, GlobalFrom(it.data.data(), it.data.size()));
    }
  }
  if (!items.empty()) MarkPrivate();
  CloseClipboard();
}

static std::wstring ReadClipboardText() {
  std::wstring text;
  if (!OpenClipboardRetry()) return text;
  if (HANDLE h = GetClipboardData(CF_UNICODETEXT)) {
    if (auto *p = (const wchar_t *)GlobalLock(h)) {
      text = p;
      GlobalUnlock(h);
    }
  }
  CloseClipboard();
  return text;
}

static bool PasteViaClipboard(const std::wstring &text) {
  std::vector<ClipItem> backup;
  // 备份不了就不粘贴：退出码 4，由主进程按写入失败处理（结果放进剪贴板并告诉用户，D-008），不悄悄覆盖用户的剪贴板
  if (!SnapshotClipboard(backup)) return false;
  if (!WriteClipboardText(text)) return false;
  DWORD ours = GetClipboardSequenceNumber();
  Sleep_(50);
  if (!PostCombo("ctrl+v")) return false;
  // 目标应用读取剪贴板可能是异步的（Electron / 网页类应用较慢），留足时间再恢复
  Sleep_(450);
  if (GetClipboardSequenceNumber() == ours) RestoreClipboard(backup); // 期间用户复制了别的就不覆盖
  return true;
}

/** Ctrl+C 抓取选中文本：等剪贴板序列号变化（最多约 600ms），读出后把剪贴板完整恢复 */
static bool CopySelectedText(std::wstring &out) {
  std::vector<ClipItem> backup;
  if (!SnapshotClipboard(backup)) return false; // 备份不了就不复制：按“没有读到选区”处理
  DWORD before = GetClipboardSequenceNumber();
  if (!PostCombo("ctrl+c")) return false;
  bool changed = false;
  for (int i = 0; i < 30; i++) {
    Sleep_(20);
    if (GetClipboardSequenceNumber() != before) {
      changed = true;
      Sleep_(30);
      out = ReadClipboardText();
      break;
    }
  }
  if (changed) RestoreClipboard(backup);
  return changed;
}

int wmain(int argc, wchar_t **argv) {
  bool paste = false, copySelection = false;
  std::string combo, b64;
  for (int i = 1; i < argc; i++) {
    std::wstring a = argv[i];
    if (a == L"--paste") paste = true;
    else if (a == L"--copy-selection") copySelection = true;
    else if (a == L"--combo" && i + 1 < argc) combo = WideToUtf8(argv[++i]);
    else b64 = WideToUtf8(a);
  }

  if (!combo.empty()) return PostCombo(combo) ? 0 : 2;

  if (copySelection) {
    std::wstring text;
    bool any = false;
    if (CopySelectedText(text))
      for (wchar_t c : text) any = any || !iswspace(c);
    if (!any) return 5;
    WriteStdout(Base64Encode(WideToUtf8(text)) + "\n");
    return 0;
  }

  std::string utf8;
  if (b64.empty() || !Base64Decode(b64, utf8) || utf8.empty()) {
    fputs("usage: mt-inject [--paste] <base64> | --combo ctrl+c | --copy-selection\n", stderr);
    return 2;
  }
  std::wstring text = Utf8ToWide(utf8);
  return (paste ? PasteViaClipboard(text) : TypeUnicode(text)) ? 0 : 4;
}
