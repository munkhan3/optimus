#!/bin/bash
# Assembles Optimus.app. The bundle is a window, not a copy of the product: it
# records the repo path and loads the UI from the API's own static mount, so
# rebuilding this is only necessary when the *window* changes.
set -euo pipefail

cd "$(dirname "$0")"
REPO="$(cd .. && pwd -P)"
OUT="${1:-$REPO/desktop/Optimus.app}"

echo "repo:   $REPO"
echo "output: $OUT"

rm -rf "$OUT" build
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources" build

echo "› icon"
swift MakeIcon.swift build/Optimus.iconset >/dev/null
iconutil -c icns build/Optimus.iconset -o "$OUT/Contents/Resources/Optimus.icns"

echo "› compile"
swiftc -O Optimus.swift -o "$OUT/Contents/MacOS/Optimus" \
  -framework Cocoa -framework WebKit

echo "› bundle"
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Optimus</string>
  <key>CFBundleDisplayName</key><string>Optimus</string>
  <key>CFBundleIdentifier</key><string>com.munkhan.optimus</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Optimus</string>
  <key>CFBundleIconFile</key><string>Optimus</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Where the app finds the product. Baked at build time; rerun build.sh if
       the checkout ever moves. -->
  <key>OptimusRepoRoot</key><string>$REPO</string>
  <!-- Talks to localhost over plain HTTP, which ATS blocks by default. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# Ad-hoc signature: enough for macOS to run a locally built app, and it keeps
# the bundle stable across launches so window position is remembered.
codesign --force --deep --sign - "$OUT" 2>/dev/null || echo "  (unsigned)"

rm -rf build
echo
echo "Built $OUT"
echo "Open it, or: cp -r '$OUT' /Applications/"
