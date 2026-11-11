#!/bin/bash
# 编译 MyTypeless 原生助手（原创 Swift CLI）
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/native/bin"
mkdir -p "$OUT"
# 部署目标必须显式指定：不写时 swiftc 按编译机的系统版本（SDK）出 minos，
# 在新系统上编译会依赖 macOS 26+ 才有的 Swift 运行时库（libswift_DarwinFoundation*），老系统 dyld 加载即崩（issue #59）。
# 13.0 与 mt-whisper / mt-diarize 一致；mt-audiotap 用 14.2（其 API 只在 14.2+ 可用，调用方 appAudioSupported() 有版本门槛）。
swiftc -swift-version 5 -target "arm64-apple-macos13.0" -O -o "$OUT/mt-hotkey" "$DIR/native/hotkey-helper.swift"
swiftc -swift-version 5 -target "arm64-apple-macos13.0" -O -o "$OUT/mt-inject" "$DIR/native/inject-helper.swift"
swiftc -swift-version 5 -target "arm64-apple-macos13.0" -O -o "$OUT/mt-focus" "$DIR/native/focus-helper.swift"
swiftc -swift-version 5 -target "arm64-apple-macos13.0" -O -o "$OUT/mt-text" "$DIR/native/text-helper.swift"
swiftc -swift-version 5 -target "arm64-apple-macos14.2" -O -o "$OUT/mt-audiotap" "$DIR/native/audiotap-helper.swift"
echo "native helpers → $OUT"
