#!/bin/bash
# 编译 MyTypeless 原生助手（原创 Swift CLI）
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/native/bin"
mkdir -p "$OUT"
swiftc -swift-version 5 -O -o "$OUT/mt-hotkey" "$DIR/native/hotkey-helper.swift"
swiftc -swift-version 5 -O -o "$OUT/mt-inject" "$DIR/native/inject-helper.swift"
swiftc -swift-version 5 -O -o "$OUT/mt-focus" "$DIR/native/focus-helper.swift"
swiftc -swift-version 5 -O -o "$OUT/mt-text" "$DIR/native/text-helper.swift"
swiftc -swift-version 5 -O -o "$OUT/mt-audiotap" "$DIR/native/audiotap-helper.swift"
echo "native helpers → $OUT"
