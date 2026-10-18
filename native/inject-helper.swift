// mt-inject —— MyTypeless 文本注入助手
// 用法: mt-inject [--paste] <base64-utf8-text>
//       mt-inject --combo cmd+c
//       mt-inject --copy-selection     → stdout 输出选中文本的 base64（剪贴板原样恢复）
// 默认: CGEvent 合成键盘事件键入 Unicode（不经过/不污染剪贴板）
//   --paste: 写剪贴板 + Cmd+V 粘贴，随后恢复剪贴板
// 退出码: 0 成功 / 2 参数错误 / 3 无辅助功能权限 / 4 注入失败 / 5 没有选中文本
// 权限: 需要“辅助功能”。

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ANSI 虚拟键码
func keycodeForLetter(_ s: String) -> CGKeyCode? {
    switch s.lowercased() {
    case "a": return 0
    case "s": return 1
    case "d": return 2
    case "f": return 3
    case "h": return 4
    case "g": return 5
    case "z": return 6
    case "x": return 7
    case "c": return 8
    case "v": return 9
    case "b": return 11
    case "q": return 12
    case "w": return 13
    case "e": return 14
    case "r": return 15
    case "y": return 16
    case "t": return 17
    case "u": return 32
    case "i": return 34
    case "o": return 31
    case "p": return 35
    case "l": return 37
    case "j": return 38
    case "k": return 40
    case "n": return 45
    case "m": return 46
    case "return", "enter": return 36
    case "space": return 49
    default: return nil
    }
}

func modifierKeycodeAndFlag(_ s: String) -> (CGKeyCode, CGEventFlags)? {
    switch s.lowercased() {
    case "cmd", "command": return (55, .maskCommand)
    case "opt", "option", "alt": return (58, .maskAlternate)
    case "ctrl", "control": return (59, .maskControl)
    case "shift": return (56, .maskShift)
    default: return nil
    }
}

/// "cmd+shift+v" → 键码与修饰键；有不认识的部分时返回 nil（不发送任何按键，退出码 2）
func parseCombo(_ combo: String) -> (key: CGKeyCode, mods: [(CGKeyCode, CGEventFlags)])? {
    let parts = combo.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
    guard let last = parts.last, let keyCode = keycodeForLetter(last) else { return nil }
    var mods: [(CGKeyCode, CGEventFlags)] = []
    for m in parts.dropLast() {
        guard let pair = modifierKeycodeAndFlag(m) else { return nil }
        mods.append(pair)
    }
    return (keyCode, mods)
}

func postCombo(_ keyCode: CGKeyCode, _ mods: [(CGKeyCode, CGEventFlags)]) {
    var flags: CGEventFlags = []
    for (_, f) in mods { flags.insert(f) }
    for (kc, _) in mods {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: kc, keyDown: true)
        e?.post(tap: .cghidEventTap)
    }
    usleep(30_000)
    let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    usleep(20_000)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
    usleep(30_000)
    for (kc, _) in mods.reversed() {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: kc, keyDown: false)
        e?.post(tap: .cghidEventTap)
    }
}

var combo: String? = nil
var usePaste = false
var copySelection = false
var b64 = ""
let args = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < args.count {
    let a = args[i]
    if a == "--paste" { usePaste = true }
    else if a == "--copy-selection" { copySelection = true }
    else if a == "--combo", i + 1 < args.count { combo = args[i + 1]; i += 1 }
    else { b64 = a }
    i += 1
}

// 参数先校验（错误退出码 2，与 Windows 版一致），再检查权限
var parsedCombo: (key: CGKeyCode, mods: [(CGKeyCode, CGEventFlags)])? = nil
var text = ""
if let combo = combo {
    guard let c = parseCombo(combo) else { exit(2) }
    parsedCombo = c
} else if !copySelection {
    guard let rawData = Data(base64Encoded: b64), let t = String(data: rawData, encoding: .utf8), !t.isEmpty else {
        FileHandle.standardError.write("usage: mt-inject [--paste] <base64> | --combo cmd+c | --copy-selection\n".data(using: .utf8)!)
        exit(2)
    }
    text = t
}

if !AXIsProcessTrusted() {
    FileHandle.standardError.write("accessibility not granted\n".data(using: .utf8)!)
    exit(3)
}

func chunkCharacters(_ s: String, size: Int) -> [String] {
    var out: [String] = []
    var cur = ""
    var count = 0
    for ch in s {
        cur.append(ch)
        count += 1
        if count >= size {
            out.append(cur)
            cur = ""
            count = 0
        }
    }
    if !cur.isEmpty { out.append(cur) }
    return out
}

func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags = []) {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
}

func typeUnicode(_ s: String) {
    // CGEventKeyboardSetUnicodeString 对超长字符串不可靠，按 16 字符分块
    for chunk in chunkCharacters(s, size: 16) {
        let utf16 = Array(chunk.utf16)
        // 显式清空修饰键标志：用户可能还按着 Option/Cmd，否则字符会被当成快捷键
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.flags = []
        down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.flags = []
        up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        up?.post(tap: .cghidEventTap)
        usleep(3000)
    }
}

/// 完整备份剪贴板（所有 item 的所有类型：图片/富文本/文件等），而不只是纯文本
func snapshotPasteboard(_ pb: NSPasteboard) -> [NSPasteboardItem] {
    var out: [NSPasteboardItem] = []
    for item in pb.pasteboardItems ?? [] {
        let copy = NSPasteboardItem()
        for t in item.types {
            if let d = item.data(forType: t) { copy.setData(d, forType: t) }
        }
        out.append(copy)
    }
    return out
}

func pasteViaClipboard(_ s: String) {
    let pb = NSPasteboard.general
    let backup = snapshotPasteboard(pb)
    pb.clearContents()
    pb.setString(s, forType: .string)
    let ourChange = pb.changeCount
    usleep(50_000)
    postKey(55, down: true, flags: .maskCommand) // Left Command
    postKey(9, down: true, flags: .maskCommand)  // V
    usleep(20_000)
    postKey(9, down: false, flags: .maskCommand)
    postKey(55, down: false)
    // 目标 app 读取剪贴板可能是异步的（Electron/网页类 app 较慢），留足时间再恢复
    usleep(450_000)
    // 期间剪贴板被别人改过（用户复制了新内容）就不覆盖
    if pb.changeCount == ourChange {
        pb.clearContents()
        if !backup.isEmpty { pb.writeObjects(backup) }
    }
}

/// 模拟 Cmd+C 抓取选中文本：等剪贴板 changeCount 变化（最多 ~600ms），读出后把剪贴板完整恢复
func copySelectedText() -> String? {
    let pb = NSPasteboard.general
    let backup = snapshotPasteboard(pb)
    let before = pb.changeCount
    postCombo(8, [(55, .maskCommand)]) // ⌘C
    var text: String? = nil
    var changed = false
    for _ in 0..<30 {
        usleep(20_000)
        if pb.changeCount != before {
            changed = true
            usleep(30_000)
            text = pb.string(forType: .string)
            break
        }
    }
    if changed {
        pb.clearContents()
        if !backup.isEmpty { pb.writeObjects(backup) }
    }
    return text
}

if let c = parsedCombo {
    postCombo(c.key, c.mods)
    exit(0)
}

if copySelection {
    guard let t = copySelectedText(), !t.isEmpty else { exit(5) }
    print(Data(t.utf8).base64EncodedString())
    exit(0)
}

if usePaste {
    pasteViaClipboard(text)
} else {
    typeUnicode(text)
    // 键入后若当前 app 未收到（极少数安全输入框），由调用方决定回退
}
exit(0)
