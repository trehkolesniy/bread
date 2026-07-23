#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${BREAD_VERSION:-2.0.0}"
ARCH="arm64"
NODE_BIN="${BREAD_NODE:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
RELEASE_NAME="bread-${VERSION}-macos-${ARCH}"
RELEASE_ROOT="$PROJECT_DIR/.build/public-release/$RELEASE_NAME"
PACKAGE_DIR="$RELEASE_ROOT/$RELEASE_NAME"
APP_DIR="$PACKAGE_DIR/bread.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
READER_DIR="$RESOURCES_DIR/reader"
ICON_BUILD_DIR="$RELEASE_ROOT/AppIcon.iconset"
ZIP_PATH="$PROJECT_DIR/.build/public-release/$RELEASE_NAME.zip"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node.js was not found at $NODE_BIN"
  exit 1
fi

if [[ -e "$RELEASE_ROOT" || -e "$ZIP_PATH" ]]; then
  echo "Release output already exists: $RELEASE_NAME"
  echo "Set BREAD_VERSION to a new version before rebuilding."
  exit 1
fi

mkdir -p "$MACOS_DIR" "$READER_DIR/data" "$ICON_BUILD_DIR"

xcrun swiftc \
  -parse-as-library \
  -D PUBLIC_RELEASE \
  -file-prefix-map "$PROJECT_DIR=." \
  -O \
  -framework AppKit \
  -framework SwiftUI \
  -framework WebKit \
  "$PROJECT_DIR/macos/BreadApp.swift" \
  -o "$MACOS_DIR/bread"

cp "$PROJECT_DIR/macos/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$NODE_BIN" "$RESOURCES_DIR/node"
cp "$PROJECT_DIR/server.js" "$READER_DIR/server.js"
ditto "$PROJECT_DIR/public" "$READER_DIR/public"
printf '{\n  "sources": []\n}\n' > "$READER_DIR/data/sources.json"
printf 'window.READ_LIKE_2000_SOURCES = [];\n' > "$READER_DIR/public/sources.js"
sed -i '' 's/const LEGACY_STORAGE_KEY = "read-like-2000-state";/const LEGACY_STORAGE_KEY = STORAGE_KEY;/' "$READER_DIR/public/app.js"

sips -z 16 16 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$PROJECT_DIR/public/bread-icon.png" --out "$ICON_BUILD_DIR/icon_512x512.png" >/dev/null
cp "$PROJECT_DIR/public/bread-icon.png" "$ICON_BUILD_DIR/icon_512x512@2x.png"
iconutil -c icns "$ICON_BUILD_DIR" -o "$RESOURCES_DIR/AppIcon.icns"

cp "$PROJECT_DIR/docs/PUBLIC-README.md" "$PACKAGE_DIR/README.md"
cp "$PROJECT_DIR/.env.example" "$PACKAGE_DIR/env.example"
cp "$PROJECT_DIR/scripts/configure-gemini.command" "$PACKAGE_DIR/Configure Gemini.command"
chmod +x "$PACKAGE_DIR/Configure Gemini.command"

xattr -cr "$PACKAGE_DIR"
codesign --force --deep --sign - "$APP_DIR"
ditto -c -k --norsrc --keepParent "$PACKAGE_DIR" "$ZIP_PATH"

echo "$ZIP_PATH"
