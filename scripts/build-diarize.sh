#!/bin/bash
# 编译会议模式的声纹提取助手 mt-diarize（native/diarize-helper.c，原创），
# 静态链接 sherpa-onnx（Apache-2.0）与 onnxruntime（MIT）的官方预编译静态库，产物只依赖系统库。
# 预编译包下载到 .vendor/sherpa-onnx/（GitHub Releases；网络慢时可手动下载后解压到该目录）。
set -euo pipefail
SHERPA_VERSION="v1.13.8"
# 预编译包的 SHA256（GitHub Release 资源的官方摘要；换版本时一起更新）
SHERPA_SHA256="1038a379fff5365b684e05cbbb9ab3577c1a2f6b1736a4d53a6746860d7eddd4"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$DIR/.vendor/sherpa-onnx"
OUT="$DIR/native/bin"
STAMP="$OUT/.mt-diarize-version"
SRC="$DIR/native/diarize-helper.c"
STAMP_VALUE="$SHERPA_VERSION $(shasum -a 256 "$SRC" | cut -c1-16)"

if [ -x "$OUT/mt-diarize" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$STAMP_VALUE" ] && [ "${1:-}" != "--force" ]; then
  echo "mt-diarize $SHERPA_VERSION 已存在（--force 重新编译）"
  exit 0
fi

if [ "$(cat "$VENDOR/VERSION" 2>/dev/null)" != "$SHERPA_VERSION" ]; then
  NAME="sherpa-onnx-$SHERPA_VERSION-osx-arm64-static-no-tts"
  TMP="$(mktemp -d)"
  echo "下载 $NAME（约 230MB）…"
  curl -fL --retry 5 -C - -o "$TMP/pkg.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/$SHERPA_VERSION/$NAME.tar.bz2"
  ACTUAL="$(shasum -a 256 "$TMP/pkg.tar.bz2" | cut -d' ' -f1)"
  if [ "$ACTUAL" != "$SHERPA_SHA256" ]; then
    rm -rf "$TMP"
    echo "$NAME.tar.bz2 的 SHA256 不符：期望 $SHERPA_SHA256，实际 $ACTUAL" >&2
    exit 1
  fi
  tar xjf "$TMP/pkg.tar.bz2" -C "$TMP"
  rm -rf "$VENDOR"
  mkdir -p "$VENDOR"
  cp -R "$TMP/$NAME/include" "$TMP/$NAME/lib" "$VENDOR/"
  echo "$SHERPA_VERSION" > "$VENDOR/VERSION"
  rm -rf "$TMP"
fi

mkdir -p "$OUT"
LIB="$VENDOR/lib"
clang++ -O2 -arch arm64 -mmacosx-version-min=13.0 -x c "$SRC" -x none \
  -I "$VENDOR/include" \
  "$LIB/libsherpa-onnx-c-api.a" "$LIB/libsherpa-onnx-core.a" \
  "$LIB/libsherpa-onnx-fstfar.a" "$LIB/libsherpa-onnx-fst.a" "$LIB/libsherpa-onnx-kaldifst-core.a" \
  "$LIB/libkaldi-decoder-core.a" "$LIB/libkaldi-native-fbank-core.a" "$LIB/libkissfft-float.a" \
  "$LIB/libssentencepiece_core.a" "$LIB/libonnxruntime.a" \
  -framework Foundation -framework CoreFoundation \
  -o "$OUT/mt-diarize"
strip -x "$OUT/mt-diarize"
codesign --force --sign - "$OUT/mt-diarize" >/dev/null
echo "$STAMP_VALUE" > "$STAMP"
echo "mt-diarize $SHERPA_VERSION → $OUT/mt-diarize"
