# overmind

Command a swarm of Claude Code and Codex sessions across your machines — from a terminal or from your phone.

`overmind` is one Rust CLI plus a small web app (a zero-dependency Node server and a React PWA). It finds every live Claude Code
session on a machine (in tmux panes or iTerm tabs), shows what each one is doing, and lets you
peek at, steer, rename, spawn and hand work off to them. [Codex](https://github.com/openai/codex)
and [pi](https://pi.dev) sessions are found and driven too — pick the agent and its model when you
spawn (`overmind spawn --harness codex`, or the web New session form); see
[docs/cli.md → Harnesses](docs/cli.md#harnesses). A Codex session waiting on a command approval
shows as waiting, with the approval as a card in the web chat (an optional hook covers iTerm tabs:
[docs/setup.md](docs/setup.md)). In the web chat, any prompt or reply of a Claude Code or
Codex session can be **branched**: the branch icon under it opens a new session with the
conversation up to and including that message — same or other agent, any model. It also manages the tmux sessions on an
always-on **workstation** over ssh, so the same command works from your laptop and on the
workstation itself.

The setup it is built for:

- an always-on Mac (the *workstation*) runs Claude Code inside tmux, 24/7;
- your laptop and phone reach it over [Tailscale](https://tailscale.com);
- closing the laptop lid never interrupts an agent — the tmux server lives on the workstation.

Overmind is a fork of [fleet](https://github.com/ilucin/fleet) by ilucin, and runs side by side with it: its own binary
(`overmind`), config (`~/.config/overmind/`), state dirs and web port (**7878**, fleet's is 7777).

## Architecture

```
  laptop                         phone                           workstation (always on)
 ┌─────────────────────────┐   ┌────────────────────┐          ┌──────────────────────────────────┐
 │ overmind <cmd>          │   │ browser / PWA      │          │ tmux server (24/7)               │
 │  ├─ local sessions      │   │ (overmind web UI)  │          │  ├─ job-a: claude                │
 │  └─ -H workstation ─────┼ssh┼────────────────────┼────────▶ │  ├─ job-b: claude                │
 │                         │   │                    │   http   │  └─ overmind: overmind watch     │
 │ overmind web serve :7878│◀──┼── http ────────────┼────────▶ │ overmind web serve :7878         │
 └─────────────────────────┘   │                    │ (tailnet)└──────────────────────────────────┘
            ▲                  └────────────────────┘                        ▲
            └─────────────── Tailscale (WireGuard mesh, private IPs) ────────┘
```

- **CLI** — `overmind` discovers sessions from Claude Code's own registry (`~/.claude/sessions/`),
  drives them through tmux or iTerm, and dispatches to other hosts by re-running itself over ssh
  (`ssh <host> overmind <same args>`).
- **Web** — every machine runs the same server. It serves its own sessions and merges in its
  peers', so any one URL shows the whole overmind. A keyboard-first desktop UI and a phone PWA:
  session list and board, chat with a prompt queue, a live terminal, briefs, a live diff reviewer, spawning now
  or later — plus the modules around the sessions: an Inbox of everything waiting on you,
  Productive tasks, pull requests, Slack links, bots, a voice operator, voice memos and notes.
- **Config** — one small JSON file per machine (`~/.config/overmind/config.json`), written by
  `overmind init`, read by both the CLI and the web server.

Details: [docs/architecture.md](docs/architecture.md).

## Quickstart

Requirements: macOS (the only tested platform; iTerm support is macOS-only), tmux, Claude Code, Rust (to build),
Node ≥ 22 (for the web app), Tailscale + ssh between machines for multi-host use.

Build prerequisites: a Rust toolchain ([rustup](https://rustup.rs); the repo pins it in
`rust-toolchain.toml`) and, on macOS, the Xcode Command Line Tools (`xcode-select --install`) for
the linker. If a full Xcode is installed but its license was never accepted, linking fails with
"You have not agreed to the Xcode license agreements" — run `sudo xcodebuild -license accept`, or
build against the Command Line Tools instead:
`DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo install --path crates/overmind`.

```sh
git clone https://github.com/vanja-jansky-productive/overmind && cd overmind
cargo install --path crates/overmind  # installs `overmind` into ~/.cargo/bin
overmind web build                    # build the web UI (npm ci + vite build → web/ui/dist)

overmind init                         # interactive: this machine's name, hosts, spawn dirs, web port
overmind install --host workstation   # copy the binary + web app (incl. built UI) to the workstation
overmind doctor                       # reachability, versions on both ends, config sanity

overmind list                         # Claude sessions on this machine
overmind -H workstation list          # ...on the workstation
overmind web serve                    # web UI on :7878 (run it on each machine)
```

Then open `http://<workstation-tailscale-ip>:7878` on your phone and add it to the home screen. On a
Mac, `crates/overmind-desktop/bundle.sh --install` builds **Overmind.app**, the same UI as a desktop app
([docs/desktop.md](docs/desktop.md)). Other apps can frame one directory's sessions as a chat
panel: the embed view, `https://<overmind>/?host=…&dir=…#/embed`
([docs/architecture.md → Embed view](docs/architecture.md#embed-view)).

Building the whole setup from scratch (always-on Mac, Tailscale, ssh, tmux, phone):
[docs/setup.md](docs/setup.md).

## Commands

| area | commands |
| --- | --- |
| Claude sessions | `list` · `peek` · `send` · `rename` · `name` · `spawn` · `handoff` · `brief` · `stack` · `group` · `watch` (default) · `skill` |
| finishing | `done` — an agent reports its work finished (the UI shows it Done; you close it) · `ask-done` · `sleep` — close a session but keep it dormant (the app's Deactivate) |
| Slack | `slack link <thread-url \| @person> --for 2h` · `slack` · `slack unlink` · `slack reply` — a session talks, for a while, with the people in one Slack thread, channel or DM; with `slack.spawn`, mentioning the app in a thread opens a new session there |
| tmux sessions | `tmux list\|enter\|last\|new\|kill\|rename\|stale` (alias `t`), shortcuts `enter` · `last` · `new` |
| after a reboot | `restore` — dormant sessions (the app's Inactive): list, bring back (same tmux layout, `claude --resume`), forget; `--closed` for recently closed ones |
| hosts | `exec` · `ssh` · `doctor` · `usage` (Claude and ChatGPT plan limits) · `harness` · `gh-identity` (act on GitHub as a GitHub App) |
| setup | `init` · `config path\|show\|edit\|set` · `install --host <name>` |
| pull requests | `prs` — the GitHub PRs that need you (unseen @mentions, yours, waiting on your review, waiting on their author), through `gh`, with their local worktrees |
| Productive tasks | `tasks` · `task show\|status\|spawn\|schedule` — your open Productive tasks (due soon, in progress, to do), moved between statuses, a session started on one now or on its start date |
| later | `schedule add --at <when> \| --task <task>` · `schedule` · `schedule cancel` — one-off sessions started later on this host |
| git repos | `repos` · `repos sync` · `repos install-service` — fetch + fast-forward every repo under `~/Code`, on a timer |
| bots | `bots` · `bots show\|run\|enable\|disable` · `bots check\|forget` · `bots install-service` — agent sessions a host starts from a recipe (prompt + schedule, or a GitHub trigger: a new branch matching a pattern), like Claude Code routines; everything a bot session spawns joins its run. `jobs` is the old name, still an alias |
| web | `web serve` · `web build` · `web install-service` |
| lessons | `lesson learn\|list\|recall\|confirm\|retire` · `lesson proposals\|accept\|reject` · `lesson import\|export` — what sessions learned, injected into new ones by a Claude Code hook and mined from finished ones; agent-memory JSONL interop ([docs/lessons.md](docs/lessons.md)) |
| agents | `mcp` — every command above as an MCP tool, for Claude Code and other agents |

Global flags: `-H, --host <name>`, `--local`, `--json` (where it applies). Full reference:
[docs/cli.md](docs/cli.md).

A few examples:

```sh
overmind                                # live dashboard (TUI); piped, it prints `list`
overmind peek docs-refresh              # what that session shows right now
overmind send docs-refresh "run the tests" # type into it and press Enter
overmind list -a --json                 # every host, one array, rows tagged with host
overmind new billing-fix -C ~/Code/project # attach to (or create) a tmux session on the workstation
overmind last                           # back to the previous tmux session
overmind tmux stale                     # idle shells nothing is using
```

## Docs

- [docs/setup.md](docs/setup.md) — end-to-end guide: workstation, Tailscale, ssh, tmux, Claude Code, phone
- [docs/architecture.md](docs/architecture.md) — components, config, discovery, JSON contracts, extension points
- [docs/cli.md](docs/cli.md) — command reference
- [docs/desktop.md](docs/desktop.md) — Overmind.app, the web UI as a macOS app (Tauri)
- [docs/migration.md](docs/migration.md) — coming from `tb-fleet`, `ws` or `overmind-web`
- [web/](web/) — the web server and its HTTP API
- [scripts/guide/](scripts/guide/) — the feature guide: every screen, screenshotted from demo data

## Security

There is **no authentication** in the web app. It is meant to be reachable only over your
tailnet: bind it to the Tailscale interface (or firewall it) and never expose it publicly. Anyone
who can reach the port can type into your Claude sessions (and read the notes under `web.notes.root`, when set). See
[docs/setup.md#security](docs/setup.md#security).

## License

MIT — see [LICENSE](LICENSE). Portions derived from
[productiveio/cli-toolbox](https://github.com/productiveio/cli-toolbox).
