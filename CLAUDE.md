# overmind — contributor & agent guide

Supervise Claude Code sessions across machines: a Rust CLI (`overmind`) and a zero-dependency Node web
app. Read [README.md](README.md) and [docs/architecture.md](docs/architecture.md) first.

## Layout

```
Cargo.toml             workspace
crates/overmind/          the `overmind` binary + library
  src/core/            discovery, backends (tmux/iTerm), naming, tmux sessions, hosts/config — no printing
  src/cli/             argument handling and text/JSON rendering
  src/tui/             the `watch` dashboard (ratatui)
  SKILL.md             Claude Code skill installed by `overmind skill install`
  tests/               integration tests
crates/overmind-desktop/  Overmind.app: Tauri 2 shell around the web UI (not a default member — use -p overmind-desktop)
web/                   web server (server.mjs, lib/), Node >= 22, no npm deps
  ui/                  React + shadcn/ui PWA (npm, Vite build → ui/dist, gitignored) — see web/ui/README.md
docs/                  setup, architecture, CLI reference, migration
scripts/guide/         feature guide: demo API + headless-Chrome screenshots → one HTML page
scripts/perf/          idle-CPU harness for the web UI (headless WebKit on the frozen demo API) and the
                       web server's CPU / `overmind list` runs (server-cpu.mjs) — see its README
```

Keep logic in `core`; the CLI, the TUI and any future UI (a second web UI, another TUI) are views
on it.

## Build & test

macOS: needs the Xcode Command Line Tools. If linking fails with an Xcode license error, prefix
cargo with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` (or accept the license).

```sh
cargo build                       # from the repo root
cargo test                        # Rust unit + integration tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo run -q -p overmind -- --help   # run the CLI from source
cargo test -p overmind-desktop       # the desktop app (crates/overmind-desktop/bundle.sh builds Overmind.app)

cd web && node --test tests/      # web tests (no network, child processes mocked)
cd web/ui && npm ci && npm run build && npm run lint && npm test   # React UI (overmind web build does ci+build)
cd web && node server.mjs         # run the web server against your local config
```

Tests use temp dirs and fixtures (`OVERMIND_CONFIG`, `OVERMIND_FIXTURE`, `HOME` pointing into a tempdir) —
never a real home directory, real config or live sessions.

## Git workflow

- Commit and push straight to `main` as soon as a change works: no branches, no PRs. The user
  tests every push right away in the desktop app.
- The desktop app talks to the workstation's web server, which runs from its own checkout: a
  push is live only after `scripts/deploy.sh` runs there (over ssh, from that checkout).
- Deploy every push to **all** hosts in the overmind config, not just the one serving the desktop
  app: each host runs its own web server and CLI, and a spawn or fix on one host may go
  through another's. Run `ssh <host> '~/Code/project/scripts/deploy.sh'` for each (they can run
  in parallel) and check that each one ends with "web server up". A host provisioned by other
  tooling may keep its checkout elsewhere (e.g. `~/.local/src/overmind`): run that checkout's script.
- Commit only your own files, because other sessions may have uncommitted work in the same tree.
- If you hit a conflict because another session is changing the same thing (a rejected push, a
  rebase conflict, overlapping edits), move your work into a git worktree. Rebase it onto `main`
  there, then push.

## Rules

- **Privacy: this repo is public.** Never commit personal config, IP addresses (including
  Tailscale `100.x.y.z` addresses), hostnames, usernames, home paths (`/Users/<name>/…`), emails,
  ssh key names or tailnet names — not in code, tests, fixtures, docs or commit messages. Use
  placeholders: hosts `laptop` / `workstation`, `100.x.y.z`, `~/Code/project`, `$HOME`. Real values
  live only in the user's `~/.config/overmind/config.json`, which is never committed (`config.json` is
  gitignored).
- **JSON contracts are stable APIs**: `overmind list --json`, every other `--json` output, the config
  file shape and the web HTTP API. Adding fields is fine; renaming, removing or retyping one is a
  breaking change — bump the version and document it in `docs/`.
- **The config file is shared**: the CLI owns it, the web server only reads it. Preserve unknown
  keys on rewrite; a missing config must keep single-host local use working.
- **Commands that type into live agents** (`send`, `rename`, `name --apply`, `spawn`, `handoff`,
  web `send`/`keys`/`spawn`) must never resolve an ambiguous target — error with candidates.
- **Mutating tests against real tmux** use throwaway sessions named `overmind-test-*` and clean them
  up; never touch sessions you did not create.
- The web **server** (`web/server.mjs`, `web/lib/`) stays dependency-free (`node:`
  built-ins only) and build-free. npm dependencies live only in `web/ui/`, whose build output
  (`web/ui/dist`) is what gets served and installed.
- Update `docs/cli.md` when you change a command or flag, and `docs/architecture.md` when you
  change a contract.
