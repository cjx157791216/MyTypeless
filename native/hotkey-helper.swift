// mt-hotkey —— MyTypeless 全局快捷键助手（CGEventTap）
// 用法: mt-hotkey '<config-json>'
// config: {"matches":[{"name":"dictation","key":"space","require":["opt"]}]}
// 行为: 命中匹配的按下/抬起事件以行分隔 JSON 写 stdout:
//   {"name":"dictation","phase":"down"} / {"name":"dictation","phase":"up"}
//   单修饰键触发（如 key=ropt / fn）按住期间按了其他键 → {"phase":"abort"}（视为组合键误触）；
//   若该键与按住的 fn 组成了另一条注册的组合（如 fn+space、fn+shift），先 abort 再发那条组合的 down
// 设计: 只匹配已注册快捷键，不做按键记录；命中的触发键被吞掉（避免 Option+Space 落入不换行空格），
//       单修饰键触发不吞（避免修饰键状态卡死）。父进程退出即退出。
// 权限: 需要“辅助功能”。无权限时 exit(3)。

import ApplicationServices
import CoreGraphics
import Foundation

struct Match: Codable {
    let name: String
    let key: String
    var require: [String]?
}

struct Config: Codable {
    let matches: [Match]
}

let configJSON = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard !configJSON.isEmpty,
      let data = configJSON.data(using: .utf8),
      let cfg = try? JSONDecoder().decode(Config.self, from: data),
      !cfg.matches.isEmpty else {
    FileHandle.standardError.write("invalid config\n".data(using: .utf8)!)
    exit(2)
}

// 虚拟键码（HIToolbox kVK_*，ANSI 布局）
let keyTable: [String: UInt64] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
    "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
    "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    // 单修饰键触发
    "rcmd": 54, "rightcmd": 54, "lcmd": 55, "leftcmd": 55,
    "lshift": 56, "leftshift": 56, "rshift": 60, "rightshift": 60,
    "lopt": 58, "leftoption": 58, "ropt": 61, "rightoption": 61,
    "lctrl": 59, "leftcontrol": 59, "rctrl": 62, "rightcontrol": 62,
    "fn": 63,
    "shift": 56 // 仅用于组合（如 fn+shift），左右 Shift 都算
]

// 单修饰键：keycode → 设备相关标志位（IOLLEvent.h NX_DEVICE*KEYMASK；fn 用 SecondaryFn）
let modifierDeviceMask: [UInt64: UInt64] = [
    59: 0x0000_0001, // L ctrl
    56: 0x0000_0002, // L shift
    60: 0x0000_0004, // R shift
    55: 0x0000_0008, // L cmd
    54: 0x0000_0010, // R cmd
    58: 0x0000_0020, // L opt
    61: 0x0000_0040, // R opt
    62: 0x0000_2000, // R ctrl
    63: CGEventFlags.maskSecondaryFn.rawValue
]

let flagTable: [String: CGEventFlags] = [
    "opt": .maskAlternate, "option": .maskAlternate, "alt": .maskAlternate,
    "cmd": .maskCommand, "command": .maskCommand,
    "ctrl": .maskControl, "control": .maskControl,
    "shift": .maskShift,
    "fn": .maskSecondaryFn
]
// 精确匹配只比较这四个修饰键（方向键/F 键会自带 Fn/NumPad 标志，不参与比较）
let comparedFlags: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]

struct Rule {
    let name: String
    let trigger: UInt64
    let triggers: Set<UInt64> // 修饰键触发时可匹配的键码（"shift" 含左右）
    let reqFlags: CGEventFlags
    let needFn: Bool
    let modifierOnly: Bool
}

var rules: [Rule] = []
ruleLoop: for m in cfg.matches {
    guard let trigger = keyTable[m.key.lowercased()] else {
        FileHandle.standardError.write("unknown key: \(m.key)\n".data(using: .utf8)!)
        continue
    }
    var req: CGEventFlags = []
    var needFn = false
    for r in (m.require ?? []) {
        // 不认识的修饰键：整条规则不要（只跳过修饰键会把 rctrl+space 变成单按空格，抢走全系统的空格）
        guard let f = flagTable[r.lowercased()] else {
            FileHandle.standardError.write("unknown modifier: \(r) in \(m.name)\n".data(using: .utf8)!)
            continue ruleLoop
        }
        if f == .maskSecondaryFn { needFn = true } else { req.insert(f) }
    }
    rules.append(Rule(name: m.name, trigger: trigger,
                      triggers: m.key.lowercased() == "shift" ? [56, 60] : [trigger],
                      reqFlags: req, needFn: needFn,
                      modifierOnly: modifierDeviceMask[trigger] != nil))
}
guard !rules.isEmpty else {
    FileHandle.standardError.write("no valid matches\n".data(using: .utf8)!)
    exit(2)
}

func emit(_ name: String, _ phase: String) {
    let line = "{\"name\":\"\(name)\",\"phase\":\"\(phase)\"}\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func modifiersMatch(_ flags: CGEventFlags, _ rule: Rule) -> Bool {
    if flags.intersection(comparedFlags) != rule.reqFlags { return false }
    if rule.needFn && !flags.contains(.maskSecondaryFn) { return false }
    return true
}

// 父进程死亡检测：getppid 变化（被 launchd 收养）即退出
setvbuf(stdout, nil, _IONBF, 0)
let originalPpid = getppid()
DispatchQueue.global().async {
    while true {
        usleep(400_000)
        if getppid() != originalPpid { exit(0) }
    }
}

if !AXIsProcessTrusted() {
    FileHandle.standardError.write("accessibility not granted\n".data(using: .utf8)!)
    exit(3)
}

var active: Rule? = nil
var gTap: CFMachPort? = nil

let eventMask = (1 << CGEventType.keyDown.rawValue)
    | (1 << CGEventType.keyUp.rawValue)
    | (1 << CGEventType.flagsChanged.rawValue)

let callback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        // 系统在回调超时/安全输入时会禁用 tap；必须重新启用，否则快捷键会“失灵”
        if let t = gTap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)

    case .keyDown, .keyUp:
        let kc = UInt64(event.getIntegerValueField(.keyboardEventKeycode))
        let isDown = type == .keyDown
        if let a = active {
            if a.modifierOnly {
                guard isDown else { return Unmanaged.passUnretained(event) }
                // 按住 fn 时按下的键若组成另一条注册组合（如 fn+space）：撤销当前触发，改发那条组合
                if event.getIntegerValueField(.keyboardEventAutorepeat) == 0,
                   let combo = rules.first(where: { !$0.modifierOnly && $0.trigger == kc && modifiersMatch(event.flags, $0) }) {
                    emit(a.name, "abort")
                    emit(combo.name, "down")
                    active = combo
                    return nil
                }
                // 否则视为普通组合键使用（如 fn+方向键），放弃本次触发
                emit(a.name, "abort")
                active = nil
                return Unmanaged.passUnretained(event)
            }
            if kc == a.trigger {
                if !isDown {
                    emit(a.name, "up")
                    active = nil
                }
                return nil // 吞掉 trigger 键（含按住时的重复 keydown）
            }
        } else if isDown && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            for r in rules where !r.modifierOnly && kc == r.trigger && modifiersMatch(event.flags, r) {
                emit(r.name, "down")
                active = r
                return nil
            }
        }

    case .flagsChanged:
        let kc = UInt64(event.getIntegerValueField(.keyboardEventKeycode))
        let raw = event.flags.rawValue
        if let a = active {
            if a.modifierOnly {
                if a.triggers.contains(kc), let mask = modifierDeviceMask[kc], raw & mask == 0 {
                    emit(a.name, "up")
                    active = nil
                } else if !a.triggers.contains(kc), let mask = modifierDeviceMask[kc], raw & mask != 0 {
                    // 按住单修饰键时又按下另一个修饰键：组成注册组合（如 fn+shift）则切换过去，否则放弃
                    if let combo = rules.first(where: { $0.modifierOnly && $0.name != a.name && $0.triggers.contains(kc) && $0.needFn && event.flags.contains(.maskSecondaryFn) }) {
                        emit(a.name, "abort")
                        emit(combo.name, "down")
                        active = combo
                    } else {
                        emit(a.name, "abort")
                        active = nil
                    }
                }
            } else if !a.reqFlags.isEmpty && !event.flags.contains(a.reqFlags) {
                // 组合键：先松开修饰键也算结束
                emit(a.name, "up")
                active = nil
            }
        } else if let mask = modifierDeviceMask[kc], raw & mask != 0 {
            for r in rules where r.modifierOnly && r.triggers.contains(kc) {
                // 修饰键组合（fn+shift）只在 fn 按下时成立；单修饰键触发要求没有其他修饰键同时按下
                if r.needFn != event.flags.contains(.maskSecondaryFn) && kc != 63 { continue }
                let others = event.flags.intersection(comparedFlags).subtracting(CGEventFlags(rawValue: flagFor(kc)))
                if others.isEmpty {
                    emit(r.name, "down")
                    active = r
                    break
                }
            }
        }

    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

/// 修饰键 keycode → 其通用（不分左右）标志位
func flagFor(_ kc: UInt64) -> UInt64 {
    switch kc {
    case 54, 55: return CGEventFlags.maskCommand.rawValue
    case 56, 60: return CGEventFlags.maskShift.rawValue
    case 58, 61: return CGEventFlags.maskAlternate.rawValue
    case 59, 62: return CGEventFlags.maskControl.rawValue
    default: return 0
    }
}

guard let tap = CGEvent.tapCreate(tap: .cghidEventTap,
                                  place: .headInsertEventTap,
                                  options: .defaultTap,
                                  eventsOfInterest: CGEventMask(eventMask),
                                  callback: callback,
                                  userInfo: nil) else {
    FileHandle.standardError.write("tap create failed (permission?)\n".data(using: .utf8)!)
    exit(3)
}
gTap = tap

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("system", "ready")
CFRunLoopRun()
