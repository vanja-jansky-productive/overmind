#!/usr/bin/env bash
# Build Overmind.app (macOS) from this crate: release binary + Info.plist + icon,
# ad-hoc signed. No Tauri CLI needed. --profile bundles the same binary as another
# app (see docs/desktop.md → "Other apps").
#
#   crates/overmind-desktop/bundle.sh            # → target/release/bundle/Overmind.app (+ Overmind.zip)
#   crates/overmind-desktop/bundle.sh --install  # ...and copy it to ~/Applications
#   crates/overmind-desktop/bundle.sh --profile fin --url https://host:4443 [--install]
#                                             # → Fin.app (URL also from $FIN_DESKTOP_URL)
#     [--frame-origin https://host:7443]      # an origin the page may frame (Overmind's embed view; repeatable)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
install=0
profile=overmind
url=""
frame_origins=()
while (($#)); do
  case "$1" in
    --install) install=1 ;;
    --profile) profile="${2:?--profile needs a name}"; shift ;;
    --url) url="${2:?--url needs a URL}"; shift ;;
    --frame-origin) frame_origins+=("${2:?--frame-origin needs a URL}"); shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$(uname -s)" == Darwin ]] || { echo "the desktop app is macOS-only" >&2; exit 1; }

# A profile: the bundle's name, identifier, icon and Info.plist extras. Overmind.app has
# no profile.json; any other app gets one in Resources, which the binary reads at launch.
case "$profile" in
  overmind)
    name=Overmind
    identifier=dev.overmind.desktop
    icon="$here/icons/icon.png"
    category=public.app-category.developer-tools
    extra_plist='  <!-- Attach opens an iTerm tab through AppleScript. -->
  <key>NSAppleEventsUsageDescription</key><string>Overmind opens iTerm tabs attached to your tmux sessions.</string>
  <!-- Voice input in the composer (the page must be HTTPS or localhost — see docs/desktop.md). -->
  <key>NSMicrophoneUsageDescription</key><string>Overmind records voice messages that are transcribed into your prompts.</string>'
    url_env=""
    title_bar=native
    ;;
  fin)
    name=Fin
    identifier=dev.overmind.desktop.fin
    icon="$here/icons/fin.png"
    category=public.app-category.finance
    extra_plist='  <!-- Voice input in the framed Overmind assistant panel. -->
  <key>NSMicrophoneUsageDescription</key><string>Fin records voice messages for the assistant panel.</string>'
    url_env=FIN_DESKTOP_URL
    title_bar=overlay
    url="${url:-${FIN_DESKTOP_URL:-}}"
    [[ -n "$url" ]] || { echo "--profile fin needs --url <https://…> (or FIN_DESKTOP_URL)" >&2; exit 2; }
    ;;
  brain)
    name=Brain
    identifier=dev.overmind.desktop.brain
    icon="$here/icons/brain.png"
    category=public.app-category.productivity
    extra_plist='  <!-- Voice input in the framed Overmind assistant panel. -->
  <key>NSMicrophoneUsageDescription</key><string>Brain records voice messages for the assistant panel.</string>'
    url_env=BRAIN_DESKTOP_URL
    title_bar=overlay
    url="${url:-${BRAIN_DESKTOP_URL:-}}"
    [[ -n "$url" ]] || { echo "--profile brain needs --url <https://…> (or BRAIN_DESKTOP_URL)" >&2; exit 2; }
    ;;
  *) echo "unknown profile: $profile (overmind, fin, brain)" >&2; exit 2 ;;
esac
frames_json=""
for o in ${frame_origins[@]+"${frame_origins[@]}"}; do
  [[ "$profile" != overmind ]] || { echo "--frame-origin is for other profiles" >&2; exit 2; }
  [[ "$o" =~ ^https?://[^\"\\[:space:]/]+/?$ ]] || { echo "bad frame origin: $o" >&2; exit 2; }
  frames_json+="${frames_json:+, }\"${o%/}\""
done
if [[ -n "$url" ]]; then
  [[ "$profile" != overmind ]] || { echo "--url is for other profiles; Overmind.app reads its config" >&2; exit 2; }
  [[ "$url" =~ ^https?://[^\"\\[:space:]]+$ ]] || { echo "bad URL: $url" >&2; exit 2; }
fi

version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/Cargo.toml" | head -1)"
target_dir="${CARGO_TARGET_DIR:-$root/target}"
out="$target_dir/release/bundle"
app="$out/$name.app"

(cd "$root" && cargo build --release -p overmind-desktop)

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$target_dir/release/overmind-desktop" "$app/Contents/MacOS/overmind-desktop"
if [[ "$profile" != overmind ]]; then
  cat > "$app/Contents/Resources/profile.json" <<JSON
{
  "name": "$name",
  "identifier": "$identifier",
  "url": "$url",
  "urlEnv": "$url_env",
  "titleBar": "$title_bar",
  "frameOrigins": [$frames_json]
}
JSON
fi

iconset="$(mktemp -d)/icon.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$icon" --out "$iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$icon" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/icon.icns"
rm -rf "$(dirname "$iconset")"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleExecutable</key><string>overmind-desktop</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>$identifier</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSApplicationCategoryType</key><string>$category</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
${extra_plist:+$extra_plist
}  <!-- The server may be plain http on the tailnet (100.x.y.z), which ATS would block. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$app" 2>/dev/null
(cd "$out" && rm -f "$name.zip" && ditto -c -k --keepParent "$name.app" "$name.zip")
echo "built $app"
echo "      $out/$name.zip"

if (( install )); then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$name.app"
  ditto "$app" "$HOME/Applications/$name.app"
  echo "installed ~/Applications/$name.app"
fi
