#!/bin/sh
# Deploy `main` on this machine from its repo checkout: pull, install the CLI, build the web UI,
# restart the web server, wait until it answers.
#
#   scripts/deploy.sh                        # on the machine itself
#   ssh <host> '~/Code/project/scripts/deploy.sh'   # another host, from its own checkout
#
# Refuses a checkout with uncommitted changes to tracked files (that is someone's work in
# progress — deploy what is pushed, not what is lying around). The binary goes to
# ~/.local/bin/overmind (where `overmind install` and the launchd agent expect it), replaced
# atomically. Restart: the `overmind.web` launchd agent (`overmind web install-service`), else a tmux
# session `overmind-web`, else it only tells you to restart the server yourself.
set -eu

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
repo=$(pwd)
say() { printf '\033[1mdeploy:\033[0m %s\n' "$*"; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "deploy: uncommitted changes in $repo — refusing (commit, stash or deploy from a clean checkout)" >&2
  exit 1
fi
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || { echo "deploy: $repo is on '$branch', not main" >&2; exit 1; }

say "pull"
git pull --ff-only --quiet
say "at $(git log --oneline -1)"

say "build the CLI"
cargo build --release --locked -q -p overmind
mkdir -p "$HOME/.local/bin"
# Copy then rename: overwriting a running binary in place can get it killed on macOS.
cp target/release/overmind "$HOME/.local/bin/.overmind.new"
mv -f "$HOME/.local/bin/.overmind.new" "$HOME/.local/bin/overmind"
say "installed $("$HOME/.local/bin/overmind" --version)"

say "build the web UI"
"$HOME/.local/bin/overmind" web build --dir "$repo/web" --install >/dev/null

port=$("$HOME/.local/bin/overmind" --local config get web.port 2>/dev/null || true)
case "$port" in '' | *[!0-9]*) port=7878 ;; esac

uid=$(id -u)
if launchctl print "gui/$uid/overmind.web" >/dev/null 2>&1; then
  say "restart (launchd overmind.web)"
  launchctl kickstart -k "gui/$uid/overmind.web"
elif tmux has-session -t overmind-web 2>/dev/null; then
  say "restart (tmux overmind-web)"
  tmux respawn-pane -k -t overmind-web "while true; do '$HOME/.local/bin/overmind' web serve --dir '$repo/web'; sleep 2; done"
else
  say "no overmind.web launchd agent or overmind-web tmux session — restart the web server yourself"
  exit 0
fi

i=0
until curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "deploy: the web server did not answer on :$port within 30s" >&2
    exit 1
  fi
  sleep 1
done
say "web server up on :$port"
