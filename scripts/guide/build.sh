#!/bin/sh
# Build the Overmind feature guide (an HTML page + its screenshots) from demo data.
#
#   scripts/guide/build.sh                 # everything → scripts/guide/out/
#   scripts/guide/build.sh d-prs m-prs     # re-shoot only these (the rest of out/img stays)
#
# 1. builds the web UI (web/ui/dist), 2. serves it from mock.mjs (invented data only),
# 3. shoots every screen with headless Chrome (shoot.mjs), 4. captures `overmind watch` on the same
# overmind (OVERMIND_FIXTURE, in a throwaway tmux session `overmind-test-guide`), 5. converts to webp and
# writes out/overmind-guide.html with out/img/. See scripts/guide/README.md.
#
# Needs: macOS, Google Chrome, Node >= 22, ImageMagick (`magick`), tmux, cargo.
# OVERMIND_GUIDE_SETUP_URL: where the "setup i arhitektura" links point (default: docs/setup.md on GitHub).
set -eu

cd "$(dirname "$0")"
here=$(pwd)
repo=$(cd ../.. && pwd)
out="$here/out"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/overmind-guide.XXXXXX")
port=${GUIDE_PORT:-7799}
say() { printf '\033[1mguide:\033[0m %s\n' "$*"; }

for bin in node magick tmux cargo; do command -v "$bin" >/dev/null || { echo "guide: $bin not found" >&2; exit 1; }; done

mock_pid=
cleanup() {
  [ -n "$mock_pid" ] && kill "$mock_pid" 2>/dev/null || true
  tmux kill-session -t overmind-test-guide 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

say "building the web UI"
[ -d "$repo/web/ui/node_modules" ] || npm --prefix "$repo/web/ui" ci --silent
npm --prefix "$repo/web/ui" run build --silent >/dev/null

say "starting the demo API on :$port"
GUIDE_PORT=$port node "$here/mock.mjs" >"$tmp/mock.log" 2>&1 &
mock_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -fs "http://127.0.0.1:$port/api/health" >/dev/null && break; sleep 0.5; done

tui_html=
if [ $# -eq 0 ] || printf '%s\n' "$@" | grep -qx tui; then
  say "capturing the TUI"
  cargo build -q -p overmind --manifest-path "$repo/Cargo.toml"
  curl -fs "http://127.0.0.1:$port/demo/fixture.json" >"$tmp/fixture.json"
  echo '{"self":"workstation","hosts":{}}' >"$tmp/config.json"
  tmux kill-session -t overmind-test-guide 2>/dev/null || true
  tmux new-session -d -s overmind-test-guide -x 132 -y 34 \
    "cd '$tmp' && OVERMIND_CONFIG='$tmp/config.json' OVERMIND_FIXTURE='$tmp/fixture.json' '$repo/target/debug/overmind' watch"
  sleep 3
  tmux capture-pane -e -p -t overmind-test-guide >"$tmp/tui.ansi"
  tmux kill-session -t overmind-test-guide
  node "$here/ansi.mjs" "$tmp/tui.ansi" "$tmp/tui.html"
  tui_html="$tmp/tui.html"
fi

say "shooting"
mkdir -p "$tmp/shots" "$out/img"
GUIDE_BASE="http://127.0.0.1:$port/" GUIDE_TMP="$tmp" GUIDE_SHOTS="$tmp/shots" GUIDE_TUI_HTML="$tui_html" \
  node "$here/shoot.mjs" "$@" || say "some shots failed (see FAIL above); the others are kept"

say "converting to webp"
for f in "$tmp"/shots/*.png; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .png)
  case "$name" in
    m-*) magick "$f" -resize 640x -quality 80 "$out/img/$name.webp" ;;
    *) magick "$f" -resize 1600x -quality 82 "$out/img/$name.webp" ;;
  esac
done

setup_url=${OVERMIND_GUIDE_SETUP_URL:-https://github.com/vanja-jansky-productive/overmind/blob/main/docs/setup.md}
sed "s|{{SETUP_URL}}|$setup_url|g" "$here/guide.html" >"$out/overmind-guide.html"

missing=0
for img in $(grep -o 'img/[a-z0-9-]*\.webp' "$out/overmind-guide.html" | sort -u); do
  [ -f "$out/$img" ] || { echo "guide: missing $img" >&2; missing=1; }
done
[ $missing -eq 0 ] || exit 1
say "done: $out/overmind-guide.html + $(ls "$out/img" | wc -l | tr -d ' ') images ($(du -sh "$out/img" | cut -f1))"
