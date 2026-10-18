// mt-focus —— MyTypeless 焦点应用助手
// 用法: mt-focus                       → 输出 {"bundleId":"...","name":"...","pid":123} 或 {}
//       mt-focus --activate <pid>      → 把该进程的应用切回前台（AI 回答浮卡“插入到光标”前归还焦点）
//       mt-focus --selected-text       → 焦点输入框中选中文字的 base64（辅助功能 API，不碰剪贴板）；
//                                         没有选中 / 应用不支持时退出码 5，无辅助功能权限退出码 3
//       mt-focus --caret-context <前> <后> → 光标前后各若干字符的文字（追踪修改 D-012、风格学习 D-041、润色上下文 D-040）：
//                                         {"text":"…","caret":<光标在 text 中的位置>,"pid":<前台应用 pid>}；
//                                         只输出这一段，输入框其余内容不离开本助手；密码框、不支持时退出码 5
// 权限: 前两个用法无需辅助功能；后两个需要。参数先校验（错误退出码 2，与 Windows 版一致），再检查权限（3）。

import AppKit
import ApplicationServices
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
var caretSpan: (before: Int, after: Int)? = nil
switch args.first {
case nil, "--activate", "--selected-text": break
case "--caret-context":
    guard args.count == 3, let b = Int(args[1]), let a = Int(args[2]), b >= 0, a >= 0, b + a > 0 else { exit(2) }
    caretSpan = (b, a)
default:
    FileHandle.standardError.write("usage: mt-focus [--activate <pid> | --selected-text | --caret-context <before> <after>]\n".data(using: .utf8)!)
    exit(2)
}
if args.first == "--activate" {
    guard args.count == 2 else { exit(2) }
    guard let pid = pid_t(args[1]), let app = NSRunningApplication(processIdentifier: pid) else { exit(2) }
    exit(app.activate(options: []) ? 0 : 4)
}

/// 焦点输入框（统一的超时与类型检查）。先问系统焦点；Electron / Chromium 应用（Claude、VS Code、Slack…）默认不公开辅助功能树，
/// 系统焦点问不到（-25204）：打开该应用的 AXManualAccessibility（Electron 提供的开关）后改问应用自己的焦点元素（D-012）
func focusedElement() -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    var focused: CFTypeRef?
    if AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) != .success {
        focused = nil
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, 0.3)
            if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) != .success {
                focused = nil
                if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
                    usleep(150_000) // 应用建立辅助功能树需要一点时间
                    if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) != .success { focused = nil }
                }
            }
        }
    }
    guard let element = focused, CFGetTypeID(element) == AXUIElementGetTypeID() else { return nil }
    let field = element as! AXUIElement
    AXUIElementSetMessagingTimeout(field, 0.3)
    return field
}

if args.first == "--selected-text" {
    guard args.count == 1 else { exit(2) }
    guard AXIsProcessTrusted() else { exit(3) }
    guard let field = focusedElement() else { exit(5) }
    var selected: CFTypeRef?
    guard AXUIElementCopyAttributeValue(field, kAXSelectedTextAttribute as CFString, &selected) == .success,
          let text = selected as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { exit(5) }
    print(Data(text.utf8).base64EncodedString())
    exit(0)
}

/// 密码框（AXSecureTextField）一律不读（D-040）
func isSecureField(_ field: AXUIElement) -> Bool {
    var subrole: CFTypeRef?
    if AXUIElementCopyAttributeValue(field, kAXSubroleAttribute as CFString, &subrole) == .success,
       let s = subrole as? String, s == (kAXSecureTextFieldSubrole as String) { return true }
    return false
}

if let (before, after) = caretSpan {
    guard AXIsProcessTrusted() else { exit(3) }
    guard let field = focusedElement(), !isSecureField(field) else { exit(5) }
    var rangeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
          let rv = rangeRef, CFGetTypeID(rv) == AXValueGetTypeID() else { exit(5) }
    var caretRange = CFRange(location: 0, length: 0)
    guard AXValueGetValue(rv as! AXValue, .cfRange, &caretRange) else { exit(5) }
    let caret = caretRange.location
    var countRef: CFTypeRef?
    var total = Int.max
    if AXUIElementCopyAttributeValue(field, kAXNumberOfCharactersAttribute as CFString, &countRef) == .success, let n = countRef as? Int { total = n }
    let start = max(0, caret - before)
    let end = min(total, caret + after)
    guard end > start else { exit(5) }
    var text: String? = nil
    // 优先按范围读取（不读整个输入框）
    var req = CFRange(location: start, length: end - start)
    if let reqValue = AXValueCreate(.cfRange, &req) {
        var out: CFTypeRef?
        if AXUIElementCopyParameterizedAttributeValue(field, kAXStringForRangeParameterizedAttribute as CFString, reqValue, &out) == .success {
            text = out as? String
        }
    }
    // 不支持按范围读取：读出后只截取这一段（其余内容不输出）
    if text == nil {
        var valueRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(field, kAXValueAttribute as CFString, &valueRef) == .success, let full = valueRef as? String {
            let utf16 = Array(full.utf16)
            let s = min(start, utf16.count), e = min(end, utf16.count)
            if e > s { text = String(utf16CodeUnits: Array(utf16[s..<e]), count: e - s) }
        }
    }
    guard let snippet = text, !snippet.isEmpty else { exit(5) }
    let pid = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } ?? 0
    let obj: [String: Any] = ["text": snippet, "caret": caret - start, "pid": pid]
    if let d = try? JSONSerialization.data(withJSONObject: obj), let out = String(data: d, encoding: .utf8) { print(out) }
    exit(0)
}

if let app = NSWorkspace.shared.frontmostApplication {
    var obj: [String: Any] = ["pid": Int(app.processIdentifier)]
    if let b = app.bundleIdentifier { obj["bundleId"] = b }
    if let n = app.localizedName { obj["name"] = n }
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) {
        print(s)
        exit(0)
    }
}
print("{}")
exit(0)
