// mt-audiotap —— MyTypeless 应用声音截取助手（线上会议：截取会议软件播放出来的对方声音，D-033）
// 用法: mt-audiotap --list                     → 有音频连接的进程：[{"pid":1,"bundleId":"...","name":"...","output":true}]
//                                                （output 表示此刻正在发声）
//       mt-audiotap --apps                     → 正在运行的普通应用：[{"bundleId":"...","name":"...","audio":bool,"output":bool}]
//       mt-audiotap [--bundle <前缀>]... [--pid <pid>]... [--exclude-bundle <前缀>]... [--exclude-pid <pid>]... [--mute] [--verbose]
//         → stdout 连续输出 16kHz 单声道 s16le（不发声时输出静音，时间线连续）；
//           stderr 每行一条 JSON：{"ready":true,"rate":48000,"channels":2} / {"processes":[pid,...]} / {"rate":n} /
//           {"device":"名称"}（换了输出设备）/ {"peak":n}（--verbose，每 2 秒）/ {"error":"..."}
//           不给 --bundle / --pid：截取全部系统声音（排除 --exclude-* 与自身）；
//           给 --bundle / --pid：只截取 bundleId 以该前缀开头的进程（Chrome 网页的声音来自 com.google.Chrome.helper）或该进程，每 2 秒重新匹配
//           --mute：被截取的声音不再从扬声器播放（测试用）
//       mt-audiotap --probe                    → 建立截取后立即退出：输出 {"ready":true} 即已能截取（首次使用时先弹授权框，
//                                                回应前不输出；允许后系统会退出并重新打开启动它的 app），开会前用它先完成授权
// 权限: 「系统音频录制」，归属启动它的 app；首次使用时系统弹授权框，回应前停在启动阶段（不输出 ready）；未授权时只给静音、不报错
// 系统: macOS 14.2+（Core Audio process tap）；更低版本退出码 4。父进程退出后自行退出。
// 隐私: 只把声音送给父进程，不写文件、不联网（D-002）

import AppKit
import CoreAudio
import os
import Foundation

func fail(_ message: String, _ code: Int32 = 4) -> Never {
    FileHandle.standardError.write(Data("{\"error\":\"\(message)\"}\n".utf8))
    exit(code)
}

func emit(_ object: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardError.write(data + Data("\n".utf8))
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readArray<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ type: T.Type) -> [T] {
    var addr = address(selector)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<T>.stride
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<T>.alignment)
    defer { buffer.deallocate() }
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, buffer) == noErr else { return [] }
    let typed = buffer.bindMemory(to: T.self, capacity: count)
    return Array(UnsafeBufferPointer(start: typed, count: count))
}

func readValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var addr = address(selector)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0) }
    return status == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr, let str = value else { return nil }
    return str.takeRetainedValue() as String
}
struct AudioProcess {
    let object: AudioObjectID
    let pid: pid_t
    let bundleId: String
    let output: Bool
}

func audioProcesses() -> [AudioProcess] {
    readArray(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList, AudioObjectID.self).compactMap { object in
        guard let pid = readValue(object, kAudioProcessPropertyPID, pid_t(-1)), pid > 0 else { return nil }
        let running = readValue(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0
        return AudioProcess(object: object, pid: pid, bundleId: readString(object, kAudioProcessPropertyBundleID) ?? "", output: running != 0)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard #available(macOS 14.2, *) else { fail("requires macOS 14.2") }

func printJSON(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    print(String(data: data, encoding: .utf8)!)
}

if args == ["--list"] {
    printJSON(audioProcesses().map { p -> [String: Any] in
        let name = NSRunningApplication(processIdentifier: p.pid)?.localizedName ?? ""
        return ["pid": Int(p.pid), "bundleId": p.bundleId, "name": name, "output": p.output]
    })
    exit(0)
}

// 正在运行的普通应用（有 Dock 图标的）：给用户选“截取哪个应用的声音”。
// 应用的声音常由它的辅助进程发出（Chrome 网页 → com.google.Chrome.helper），按 bundleId 前缀归到应用上
if args == ["--apps"] {
    let procs = audioProcesses()
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }
    printJSON(apps.map { app -> [String: Any] in
        let id = app.bundleIdentifier!
        let mine = procs.filter { $0.bundleId.hasPrefix(id) }
        return ["bundleId": id, "name": app.localizedName ?? id, "audio": !mine.isEmpty, "output": mine.contains { $0.output }]
    })
    exit(0)
}

var bundles: [String] = []
var pids: Set<pid_t> = []
var excludeBundles: [String] = []
var mute = false
var probe = false
var excludePids: Set<pid_t> = [getpid()]
var verbose = false
var i = 0
while i < args.count {
    switch args[i] {
    case "--bundle" where i + 1 < args.count: bundles.append(args[i + 1]); i += 2
    case "--exclude-bundle" where i + 1 < args.count: excludeBundles.append(args[i + 1]); i += 2
    case "--exclude-pid" where i + 1 < args.count:
        guard let pid = pid_t(args[i + 1]) else { fail("bad pid", 2) }
        excludePids.insert(pid); i += 2
    case "--pid" where i + 1 < args.count:
        guard let pid = pid_t(args[i + 1]) else { fail("bad pid", 2) }
        pids.insert(pid); i += 2
    case "--mute": mute = true; i += 1
    case "--probe": probe = true; i += 1
    case "--verbose": verbose = true; i += 1
    default: fail("bad arguments", 2)
    }
}

let global = bundles.isEmpty && pids.isEmpty

func excluded(_ p: AudioProcess) -> Bool {
    excludePids.contains(p.pid) || excludeBundles.contains { !p.bundleId.isEmpty && p.bundleId.hasPrefix($0) }
}

/// 当前要截取（按 bundle / pid）或排除（全部系统声音）的进程对象
func matchedObjects() -> [AudioObjectID] {
    let all = audioProcesses()
    if global { return all.filter(excluded).map(\.object) }
    return all.filter { p in
        !excluded(p) && (pids.contains(p.pid) || bundles.contains { !p.bundleId.isEmpty && p.bundleId.hasPrefix($0) })
    }.map(\.object)
}

func tapDescription(_ objects: [AudioObjectID], uuid: UUID) -> CATapDescription {
    let desc = global
        ? CATapDescription(stereoGlobalTapButExcludeProcesses: objects)
        : CATapDescription(stereoMixdownOfProcesses: objects)
    desc.uuid = uuid
    desc.isPrivate = true
    desc.muteBehavior = mute ? .muted : .unmuted
    return desc
}

signal(SIGPIPE, SIG_IGN)
let tapUUID = UUID()
var current = matchedObjects()
var tapID = AudioObjectID(kAudioObjectUnknown)
guard AudioHardwareCreateProcessTap(tapDescription(current, uuid: tapUUID), &tapID) == noErr else { fail("create tap failed") }

// tap 报的格式是 48kHz，但数据按聚集设备（跟随输出设备）的实际采样率到来：MacBook 扬声器是 44.1kHz，
// 按 tap 格式解读会让声音变短、音调变高。按设备实际采样率重采样，采样率变了（换耳机）就重建
guard let tapFormat = readValue(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()),
      tapFormat.mFormatID == kAudioFormatLinearPCM, tapFormat.mFormatFlags & kAudioFormatFlagIsFloat != 0,
      tapFormat.mBitsPerChannel == 32 else { fail("bad tap format") }

/// 单声道 float → 16kHz s16le：加窗 sinc 低通（7.6kHz）+ 256 相位插值表，分数位置跨 IO 周期保留，
/// 输出严格 16000 样本/秒（与麦克风录音放在同一时间线上，长会议也不错位）
final class Resampler {
    static let half = 16, phases = 256
    let step: Double  // 每个输出样本前进的输入样本数
    let table: [Float]  // [相位][抽头]，相位把 0..1 的分数位置分成 256 份
    var history: [Float]
    var pos: Double

    init(rate: Double) {
        let half = Resampler.half, phases = Resampler.phases
        step = rate / 16000
        let cutoff = 2 * 7600 / rate
        var table = [Float](repeating: 0, count: (phases + 1) * 2 * half)
        for ph in 0...phases {
            let frac = Double(ph) / Double(phases)
            for k in (1 - half)...half {
                let x = Double(k) - frac, w = 0.5 + 0.5 * cos(Double.pi * x / Double(half))  // Hann 窗
                let t = Double.pi * cutoff * x
                table[ph * 2 * half + k + half - 1] = Float(abs(x) < 1e-9 ? cutoff : cutoff * sin(t) / t * w)
            }
        }
        self.table = table
        history = [Float](repeating: 0, count: half)
        pos = Double(half)
    }

    func process(_ mono: [Float]) -> [Int16] {
        let half = Resampler.half
        history += mono
        var out: [Int16] = []
        out.reserveCapacity(Int(Double(mono.count) / step) + 2)
        while Int(pos) + half < history.count {
            let i0 = Int(pos), ph = Int(((pos - Double(i0)) * Double(Resampler.phases)).rounded())
            var sum: Float = 0
            let base = ph * 2 * half
            for k in 0..<(2 * half) { sum += history[i0 - half + 1 + k] * table[base + k] }
            out.append(Int16(max(-32768, min(32767, (sum * 32767).rounded()))))
            pos += step
        }
        let drop = Int(pos) - half
        if drop > 0 { history.removeFirst(drop); pos -= Double(drop) }
        return out
    }
}

/// 音频线程 → 处理队列的单声道样本缓冲（预分配，音频线程里不分配内存、不写 stdout）
final class Ring {
    let capacity = 1 << 20  // 约 20 秒
    let data: UnsafeMutablePointer<Float>
    var head = 0, count = 0, dropped = 0
    let lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)

    init() {
        data = .allocate(capacity: capacity)
        lock.initialize(to: os_unfair_lock())
    }

    /// 音频线程调用：写入一段（samples 为 nil 时写静音，用于补齐跳过的 IO 周期）
    func push(_ samples: UnsafePointer<Float>?, _ n: Int) {
        os_unfair_lock_lock(lock)
        for k in 0..<n {
            if count == capacity { head = (head + 1) % capacity; count -= 1; dropped += 1 }
            data[(head + count) % capacity] = samples?[k] ?? 0
            count += 1
        }
        os_unfair_lock_unlock(lock)
    }

    func drain() -> [Float] {
        os_unfair_lock_lock(lock)
        var out = [Float](repeating: 0, count: count)
        for k in 0..<count { out[k] = data[(head + k) % capacity] }
        head = (head + count) % capacity
        count = 0
        os_unfair_lock_unlock(lock)
        return out
    }
}

let ring = Ring()
let mixBuffer = UnsafeMutablePointer<Float>.allocate(capacity: 16384)
var lastSampleTime = -1.0, lastFrames = 0

func defaultOutput() -> AudioObjectID? {
    readValue(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0))
}

/// 私有聚集设备（以输出设备为时钟、挂上 tap 作为输入）+ IOProc。换输出设备（插拔耳机、连蓝牙）时整个重建
final class Capture {
    let output: AudioObjectID
    var device = AudioObjectID(kAudioObjectUnknown)
    var proc: AudioDeviceIOProcID?

    init?(output: AudioObjectID) {
        self.output = output
        guard let uid = readString(output, kAudioDevicePropertyDeviceUID) else { return nil }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "MyTypeless Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: uid,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: uid]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapUUID.uuidString]],
        ]
        guard AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device) == noErr else { return nil }
        lastSampleTime = -1
        // IOProc 直接在音频线程调用（不给 dispatch queue）：给 queue 时实测每几秒跳过一个 512 帧的 IO 周期，
        // 设备时间戳不连续，截到的声音比实际短约 0.3%。首次使用时这里会等用户回应系统的授权对话框
        let status = AudioDeviceCreateIOProcIDWithBlock(&proc, device, nil) { _, inputData, inputTime, _, _ in
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
            guard let first = buffers.first, first.mNumberChannels > 0 else { return }
            let frames = min(16384, Int(first.mDataByteSize) / (4 * Int(first.mNumberChannels)))
            guard frames > 0 else { return }
            let st = inputTime.pointee.mSampleTime
            if lastSampleTime >= 0 {
                let gap = Int(st - lastSampleTime) - lastFrames
                if gap > 0 && gap < 48000 { ring.push(nil, gap) }  // 跳过的周期补静音，时间线与麦克风保持一致
            }
            lastSampleTime = st
            lastFrames = frames
            // 交错（1 个缓冲 n 声道）或非交错（n 个缓冲各 1 声道）都下混成单声道
            var channels = 0
            for k in 0..<frames { mixBuffer[k] = 0 }
            for buf in buffers {
                guard let raw = buf.mData else { continue }
                let p = raw.assumingMemoryBound(to: Float.self), n = Int(buf.mNumberChannels)
                for c in 0..<n { for k in 0..<frames { mixBuffer[k] += p[k * n + c] } }
                channels += n
            }
            if channels > 1 { let g = 1 / Float(channels); for k in 0..<frames { mixBuffer[k] *= g } }
            ring.push(mixBuffer, frames)
        }
        guard status == noErr, let p = proc, AudioDeviceStart(device, p) == noErr else { stop(); return nil }
    }

    var nominalRate: Float64 { readValue(device, kAudioDevicePropertyNominalSampleRate, Float64(0)) ?? 0 }

    func stop() {
        if let p = proc {
            AudioDeviceStop(device, p)
            AudioDeviceDestroyIOProcID(device, p)
            proc = nil
        }
        if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device) }
        device = AudioObjectID(kAudioObjectUnknown)
    }
}

guard let firstOutput = defaultOutput(), var capture = Capture(output: firstOutput) else {
    AudioHardwareDestroyProcessTap(tapID)
    fail("start device failed")
}

func deviceRate() -> Float64 {
    let r = capture.nominalRate
    return r > 0 ? r : tapFormat.mSampleRate
}

func cleanup() {
    capture.stop()
    AudioHardwareDestroyProcessTap(tapID)
}

var rate = deviceRate()
var resampler = Resampler(rate: rate)
emit(["ready": true, "rate": rate, "channels": Int(tapFormat.mChannelsPerFrame)])
if probe {
    cleanup()
    exit(0)
}
if !global { emit(["processes": current.compactMap { readValue($0, kAudioProcessPropertyPID, pid_t(-1)).map(Int.init) }]) }

var peak: Int16 = 0
let stdout = FileHandle.standardOutput
let queue = DispatchQueue(label: "mt-audiotap.work", qos: .userInitiated)
let pump = DispatchSource.makeTimerSource(queue: queue)
pump.schedule(deadline: .now() + 0.02, repeating: 0.02)
pump.setEventHandler {
    let mono = ring.drain()
    guard !mono.isEmpty else { return }
    let samples = resampler.process(mono)
    guard !samples.isEmpty else { return }
    for v in samples { let m = v == Int16.min ? Int16.max : abs(v); if m > peak { peak = m } }
    do { try stdout.write(contentsOf: samples.withUnsafeBufferPointer { Data(buffer: $0) }) } catch { cleanup(); exit(0) }
}
pump.resume()

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { cleanup(); exit(0) }
    source.resume()
    signalSources.append(source)
}

/// 重新匹配要截取的进程：会议软件新开 / 关掉发声进程时更新 tap
func rematch() {
    let matched = matchedObjects()
    guard Set(matched) != Set(current) else { return }
    current = matched
    var desc = tapDescription(matched, uuid: tapUUID)
    var addr = address(kAudioTapPropertyDescription)
    let status = withUnsafeMutablePointer(to: &desc) {
        AudioObjectSetPropertyData(tapID, &addr, 0, nil, UInt32(MemoryLayout<CATapDescription>.size), $0)
    }
    if status != noErr { emit(["error": "update tap failed \(status)"]) }
    if !global { emit(["processes": matched.compactMap { readValue($0, kAudioProcessPropertyPID, pid_t(-1)).map(Int.init) }]) }
}

// 系统的音频进程列表一变（如浏览器开始播放、会议软件接通）立即重新匹配，不等 2 秒的定时检查（否则丢掉开头一两秒）
var processListAddr = address(kAudioHardwarePropertyProcessObjectList)
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &processListAddr, queue) { _, _ in rematch() }

// 每 2 秒：父进程退出即退出；换了输出设备就重建（重建期间按真实时间补静音）；
// 采样率变了重建重采样；再检查一次要截取的进程（进程列表变化的通知之外的兜底）
let originalPpid = getppid()
let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now() + 2, repeating: 2)
timer.setEventHandler {
    if getppid() != originalPpid { cleanup(); exit(0) }
    if verbose { emit(["peak": Int(peak)]); peak = 0 }
    if let out = defaultOutput(), out != capture.output {
        let began = Date()
        capture.stop()
        guard let next = Capture(output: out) else { AudioHardwareDestroyProcessTap(tapID); fail("restart device failed") }
        capture = next
        let gap = Int(Date().timeIntervalSince(began) * rate)
        if gap > 0 { ring.push(nil, gap) }
        emit(["device": readString(out, kAudioObjectPropertyName) ?? ""])
    }
    let next = deviceRate()
    if next != rate {
        rate = next
        resampler = Resampler(rate: rate)
        emit(["rate": rate])
    }
    rematch()
}
timer.resume()
dispatchMain()
