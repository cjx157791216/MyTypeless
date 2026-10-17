// Windows 原生助手共用：进程的 exe 路径 / 文件名 / 文件描述，父进程退出时自行退出（原创）
#pragma once
#include "common.h"
#include <tlhelp32.h>
#include <wctype.h>

#pragma comment(lib, "version.lib")

inline std::wstring ExePath(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return {};
  wchar_t buf[MAX_PATH * 2];
  DWORD len = (DWORD)(sizeof buf / sizeof buf[0]);
  std::wstring path;
  if (QueryFullProcessImageNameW(h, 0, buf, &len)) path.assign(buf, len);
  CloseHandle(h);
  return path;
}

inline std::wstring FileName(const std::wstring &path) {
  size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? path : path.substr(slash + 1);
}

inline std::wstring Lower(std::wstring s) {
  for (auto &c : s) c = (wchar_t)towlower(c);
  return s;
}

/** 程序的文件描述（版本信息里的 FileDescription）；没有时为空 */
inline std::wstring FileDescription(const std::wstring &path) {
  DWORD size = GetFileVersionInfoSizeW(path.c_str(), nullptr);
  if (!size) return {};
  std::string data(size, '\0');
  if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return {};
  struct Lang { WORD lang, codepage; } *langs = nullptr;
  UINT bytes = 0;
  if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", (void **)&langs, &bytes) || bytes < sizeof(Lang)) return {};
  wchar_t key[64];
  swprintf(key, 64, L"\\StringFileInfo\\%04x%04x\\FileDescription", langs[0].lang, langs[0].codepage);
  wchar_t *desc = nullptr;
  UINT chars = 0;
  if (!VerQueryValueW(data.data(), key, (void **)&desc, &chars) || !desc || !chars) return {};
  std::wstring s(desc);
  while (!s.empty() && iswspace(s.back())) s.pop_back();
  return s;
}

/** 给用户看的应用名：文件描述，没有时用去掉 .exe 的文件名 */
inline std::wstring DisplayName(const std::wstring &path) {
  std::wstring name = FileDescription(path);
  if (!name.empty()) return name;
  std::wstring exe = FileName(path);
  return exe.size() > 4 && Lower(exe.substr(exe.size() - 4)) == L".exe" ? exe.substr(0, exe.size() - 4) : exe;
}

/** 本进程的父进程号（取不到为 0） */
inline DWORD ParentPid() {
  DWORD self = GetCurrentProcessId(), parent = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W pe{sizeof pe};
  if (snap != INVALID_HANDLE_VALUE) {
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe))
      if (pe.th32ProcessID == self) parent = pe.th32ParentProcessID;
    CloseHandle(snap);
  }
  return parent;
}

/** 父进程退出后自行退出（主进程崩溃时不留下常驻助手） */
inline void ExitWhenParentExits() {
  CreateThread(
      nullptr, 0,
      [](LPVOID) -> DWORD {
        DWORD parent = ParentPid();
        HANDLE h = parent ? OpenProcess(SYNCHRONIZE, FALSE, parent) : nullptr;
        if (!h) return 0; // 拿不到父进程句柄：不监视
        WaitForSingleObject(h, INFINITE);
        ExitProcess(0);
      },
      nullptr, 0, nullptr);
}
