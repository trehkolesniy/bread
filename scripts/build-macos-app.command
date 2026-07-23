#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="bread"
APP_DIR="$HOME/Applications/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
SUPPORT_DIR="$HOME/Library/Application Support/$APP_NAME/reader"
NODE_BIN="${BREAD_NODE:-${READLIKE2000_NODE:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}}"
BUILD_DIR="$PROJECT_DIR/.build/macos"

if [[ ! -x "$NODE_BIN" ]]; then
  osascript -e 'display alert "bread" message "Не найден локальный Node.js для сборки приложения."'
  exit 1
fi

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/reader/data" "$SUPPORT_DIR/data" "$BUILD_DIR"

xcrun swiftc \
  -parse-as-library \
  -D PUBLIC_RELEASE \
  -O \
  -framework AppKit \
  -framework SwiftUI \
  -framework WebKit \
  "$PROJECT_DIR/macos/BreadApp.swift" \
  -o "$MACOS_DIR/bread"

cp "$PROJECT_DIR/macos/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$NODE_BIN" "$RESOURCES_DIR/node"
cp "$PROJECT_DIR/server.js" "$RESOURCES_DIR/reader/server.js"
ditto "$PROJECT_DIR/public" "$RESOURCES_DIR/reader/public"
cp "$PROJECT_DIR/data/sources.json" "$RESOURCES_DIR/reader/data/sources.json"

cp "$PROJECT_DIR/server.js" "$SUPPORT_DIR/server.js"
ditto "$PROJECT_DIR/public" "$SUPPORT_DIR/public"

if [[ ! -f "$SUPPORT_DIR/data/sources.json" ]]; then
  cp "$PROJECT_DIR/data/sources.json" "$SUPPORT_DIR/data/sources.json"
fi

if [[ -f "$PROJECT_DIR/.env" && ! -f "$SUPPORT_DIR/.env" ]]; then
  cp "$PROJECT_DIR/.env" "$SUPPORT_DIR/.env"
  chmod 600 "$SUPPORT_DIR/.env"
fi

if [[ -f "$PROJECT_DIR/data/translations.json" && ! -f "$SUPPORT_DIR/data/translations.json" ]]; then
  cp "$PROJECT_DIR/data/translations.json" "$SUPPORT_DIR/data/translations.json"
fi

if [[ -f "$PROJECT_DIR/data/article-translations.json" && ! -f "$SUPPORT_DIR/data/article-translations.json" ]]; then
  cp "$PROJECT_DIR/data/article-translations.json" "$SUPPORT_DIR/data/article-translations.json"
fi

if [[ -f "$PROJECT_DIR/data/reader-state.json" && ! -f "$SUPPORT_DIR/data/reader-state.json" ]]; then
  cp "$PROJECT_DIR/data/reader-state.json" "$SUPPORT_DIR/data/reader-state.json"
fi

ICON_SOURCE="$BUILD_DIR/AppIcon-1024.png"
cp "$PROJECT_DIR/public/bread-icon.png" "$ICON_SOURCE"
mkdir -p "$BUILD_DIR/AppIcon.iconset"
sips -z 16 16 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_16x16.png" >/dev/null
sips -z 32 32 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_32x32.png" >/dev/null
sips -z 64 64 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_128x128.png" >/dev/null
sips -z 256 256 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_256x256.png" >/dev/null
sips -z 512 512 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ICON_SOURCE" --out "$BUILD_DIR/AppIcon.iconset/icon_512x512.png" >/dev/null
cp "$ICON_SOURCE" "$BUILD_DIR/AppIcon.iconset/icon_512x512@2x.png"
iconutil -c icns "$BUILD_DIR/AppIcon.iconset" -o "$RESOURCES_DIR/AppIcon.icns"

codesign --force --deep --sign - "$APP_DIR"

echo "$APP_DIR"
