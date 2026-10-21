#!/usr/bin/env bash
# Build Overmind.app (macOS) from this crate: release binary + Info.plist + icon,
# ad-hoc signed. No Tauri CLI needed.
#
#   crates/overmind-desktop/bundle.sh            # → target/release/bundle/Overmind.app (+ Overmind.zip)
#   crates/overmind-desktop/bundle.sh --install  # ...and copy it to ~/Applications
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
install=0
for a in "$@"; do
  case "$a" in
    --install) install=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo "Overmind.app is macOS-only" >&2; exit 1; }

version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/Cargo.toml" | head -1)"
target_dir="${CARGO_TARGET_DIR:-$root/target}"
out="$target_dir/release/bundle"
app="$out/Overmind.app"

(cd "$root" && cargo build --release -p overmind-desktop)

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$target_dir/release/overmind-desktop" "$app/Contents/MacOS/overmind-desktop"

iconset="$(mktemp -d)/icon.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$here/icons/icon.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$here/icons/icon.png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/icon.icns"
rm -rf "$(dirname "$iconset")"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Overmind</string>
  <key>CFBundleExecutable</key><string>overmind-desktop</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>dev.overmind.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Overmind</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <!-- Attach opens an iTerm tab through AppleScript. -->
  <key>NSAppleEventsUsageDescription</key><string>Overmind opens iTerm tabs attached to your tmux sessions.</string>
  <!-- Voice input in the composer (the page must be HTTPS or localhost — see docs/desktop.md). -->
  <key>NSMicrophoneUsageDescription</key><string>Overmind records voice messages that are transcribed into your prompts.</string>
  <!-- The Overmind server is plain http on the tailnet (100.x.y.z), which ATS would block. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$app" 2>/dev/null
(cd "$out" && rm -f Overmind.zip && ditto -c -k --keepParent Overmind.app Overmind.zip)
echo "built $app"
echo "      $out/Overmind.zip"

if (( install )); then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Overmind.app"
  ditto "$app" "$HOME/Applications/Overmind.app"
  echo "installed ~/Applications/Overmind.app"
fi
