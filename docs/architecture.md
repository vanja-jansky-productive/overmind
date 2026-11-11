# Architecture

`overmind` has one core and several front-ends. The core knows how to find Claude Code sessions (and
Codex and pi ones — [Other harnesses](#other-harnesses)) on a
machine, drive them, manage tmux sessions and reach other machines. The CLI, the TUI dashboard and
the web app are views on top of it.

```
                ┌────────────────────────── crates/overmind ──────────────────────────┐
                │  core (library)                                                  │
                │   discovery ── Claude registry + ps + tmux/iTerm → Session[]     │
                │   backend   ── peek / send / keys / focus / spawn (tmux, iTerm)  │
                │   naming    ── generated titles + cache                          │
                │   tmux      ── tmux-session management (list/new/kill/stale…)    │
                │   config    ── the shared config file                            │
                │   hosts     ── host resolution, ssh dispatch                     │
                ├──────────────────────────────────────────────────────────────────┤
                │  cli (clap + text/JSON rendering)      tui (ratatui dashboard)   │
                └──────────────────────────────────────────────────────────────────┘
                              ▲ `overmind list --json` etc.
                ┌─────────────┴──────────── web/ ──────────────────────────────────┐
                │  server.mjs (Node ≥ 22, zero deps) — HTTP API + static PWA       │
                │  peers with the same server on other hosts                       │
                └──────────────────────────────────────────────────────────────────┘
```

## Components

### Core library (`crates/overmind/src/core`)

Pure logic plus thin process wrappers; no printing. Everything a future front-end needs is here:

- **discovery** — builds the list of live sessions (see [below](#session-discovery)).
- **backend** — per-backend control: read the screen, type text, press keys, focus, spawn.
  - tmux: `capture-pane -p -J`, `send-keys -l -- <text>` in pieces of at most 512 bytes + `Enter` (Claude Code takes a bigger burst as a paste and drops the first ~1 KB of a write longer than that; multi-line text: `load-buffer` + `paste-buffer -p`, since `send-keys -l` drops newlines), `new-session` / `new-window`.
  - iTerm: AppleScript via `osascript`; values are passed as argv, never interpolated into the
    script. Text is written without a newline, then an empty write submits it (a trailing newline
    would be swallowed by bracketed paste).
- **naming** — generates short kebab-case titles by asking `claude -p --model haiku` what a
  session is working on (falls back to git branch / first prompt); cached across runs.
- **tmux** — tmux-*session* management inherited from `ws`: matching, sanitizing, stale detection.
- **config** — reads and patches the shared config file.
- **hosts** — resolves the target host and dispatches over ssh.
- **tools** — binary lookup (`PATH`, then Homebrew, `/usr/local/bin`, `~/.local/bin`, `~/.cargo/bin`, `~/bin` and the npm-installed CLI bins: `~/.npm-global/bin`, Volta, fnm's default alias, every nvm Node newest first), `~` expansion.
- **brief** / **stack** — the [session brief](#session-briefs) and [session stack](#session-stacks)
  files: format, merge rules, storage.
- **repos** / **prs** — [`overmind repos`](cli.md#repos) (keep checkouts fresh) and
  [`overmind prs`](cli.md#pull-requests) (the GitHub PRs that need you, through `gh`, joined with
  those checkouts and their worktrees).
- **tasks** — [`overmind tasks`](cli.md#productive-tasks): your open Productive tasks over its REST
  API (`curl`), by column, cached, with each workflow's statuses; moving a task between statuses.
- **snapshot** — [session recovery](#session-recovery): records what runs, marks it dormant after
  a reboot, restores it.

### CLI and TUI

`crates/overmind/src/cli` parses arguments and renders text or JSON; `crates/overmind/src/tui` is the
`watch` dashboard (ratatui). Neither contains discovery or backend logic. `cli/mcp.rs` (`overmind
mcp`) is another view: an MCP server whose tools are generated from the clap command tree, each call
re-running the binary with the matching argv — so the CLI stays the one contract.

### Host dispatch

Every command has a target host: `-H/--host <name>`, else `OVERMIND_HOST`, else a default
(`defaultHost` for tmux-session commands, this machine for everything else). `--local` forces the
local machine.

- target == `self` → run locally;
- otherwise → `ssh <hosts.<name>.ssh> overmind <same args>`.

The remote runs `overmind --local <args>` (so it never hops again), found as `hosts.<name>.overmindBin`,
then `~/.local/bin/overmind`, then `PATH` (with `OVERMIND_CMD`/`OVERMIND_JOB_RUN`/`OVERMIND_GH_IDENTITY`/`OVERMIND_DEBUG`/`OVERMIND_DRY_RUN` exported, never
`OVERMIND_CONFIG`) — install it with `overmind install --host <name>`. ssh is
invoked with a connect timeout (`OVERMIND_CONNECT_TIMEOUT`, default 5 s), keepalives and ControlMaster
multiplexing (off with `OVERMIND_MUX=0`); a tty (`-t`) is requested when both stdin and stdout are
terminals, otherwise `-T` with `BatchMode`. Directory arguments under `$HOME` are rewritten to `~/…`
so they resolve on the remote. An ssh failure (exit 255) becomes a friendly message and exit code 4.
`OVERMIND_DRY_RUN=1` prints what would run.

There is no chained hopping: a host dispatches only to hosts in its own config.

### Web server (`web/`)

Every machine runs the same `server.mjs`. It:

- serves the static UI, installable as a PWA: the React app built to `web/ui/dist/`
  (`overmind web build`; until then `/` is a "not built" placeholder);
- exposes **its own** sessions, discovered with `overmind list --json` — run when a watched file
  says something changed (the Claude registry, transcripts of live sessions, Codex/pi rollouts,
  the names cache, `done.json`, stacks, Codex hook sidecars) and at least every 30 s while someone is asking, else the
  last list is served; with `OVERMIND_WEB_WATCH=0` (or a failed watch) a 2 s TTL cache
  (see `web.discovery` below);
- drives its own backends directly for peek/send/keys (it needs untruncated, header-free output);
- reads chat transcripts from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`;
- for the whole-overmind view, fetches each peer's local list over HTTP and merges.

Requests for another host are proxied once to that peer with `?local=1`, and requests carrying
`?local=1` are never proxied again, so there are no loops. Either machine's URL shows everything.

The server has no auth; it relies on the network (tailnet) for access control. The files
endpoints (chat file links → preview) therefore only serve paths that, after `realpath`, are
inside that host's `$HOME` or the session's cwd, and never secret stores like `~/.ssh` or `.env`.

## Config

One JSON file per machine, owned by the CLI (`overmind init`, `overmind config set`) and read by the web
server. Path: `$OVERMIND_CONFIG`, else `${XDG_CONFIG_HOME:-~/.config}/overmind/config.json`.

```json
{
  "version": 1,
  "self": "laptop",
  "defaultHost": "workstation",
  "hosts": {
    "laptop":      { "ssh": null,          "web": "http://100.x.y.z:7878" },
    "workstation": { "ssh": "workstation", "web": "http://100.x.y.z:7878" }
  },
  "web":  { "port": 7878, "bind": "0.0.0.0", "dir": null },
  "tmux": null,
  "spawnDirs": [
    { "label": "Project", "paths": { "laptop": "~/Code/project", "workstation": "~/Code/project" } }
  ]
}
```

| key | meaning |
| --- | --- |
| `self` | which `hosts` entry this machine is |
| `defaultHost` | target for tmux-session commands when no `-H` is given |
| `hosts.<name>.ssh` | ssh destination (an `~/.ssh/config` alias or `user@host`); `null` for `self` |
| `hosts.<name>.web` | that host's web server URL; hosts without one are not web peers |
| `hosts.<name>.webProxy` | HTTP proxy the web server reaches that host's `web` url through, for a peer on another network than this machine's tailnet (e.g. a second, userspace `tailscaled` with `--outbound-http-proxy-listen`); needs Node >= 24.5; default direct. The CLI goes over `ssh` and ignores it |
| `hosts.<name>.webConnect` | `host` or `host:port` the web server dials for that host's `web` url instead of the url's own name (directly, or through `webProxy`), while TLS (SNI, the certificate check) and `Host` keep the url's name; for a name the proxy cannot resolve, e.g. a coordination server's extra DNS records behind a userspace `tailscaled`. Default: the url's own address. The CLI goes over `ssh` and ignores it |
| `hosts.<name>.shared` | `true`: a shared shed (other people's sessions run there too), not one of the user's own hosts. The web UI shows it in its own group of the top bar's host rail and leaves it out of the default view ("Mine"), the Inbox and the waiting count; `/api/overmind` stamps each host with `shared` from the serving host's config; `overmind list --mine` / `--shared` split on it. Default `false` |
| `hosts.<name>.editorSsh` | ssh destination the browser's machine uses for that host in "Open in editor" links, when it differs from `ssh` or `ssh` is unset (a web-only peer); default `ssh` |
| `web.port` / `web.bind` | web server listen address; with no config at all it binds `127.0.0.1` only |
| `web.dir` | where the web app lives (repo checkout or install dir), detected by `init` |
| `web.node` | `node` binary that runs the web app; `null` → `/opt/homebrew/bin/node`, `/usr/local/bin/node`, then `PATH` |
| `web.editor` | `"vscode"` (default) \| `"cursor"` \| `null`: the scheme of the "Open in editor" link the API puts on briefs and session rows (`editorUrl`, see [Session briefs](#session-briefs)); `null` = no link (the UI hides the button) |
| `web.editorSsh` | ssh destination other machines use for **this** host in those links (e.g. the alias in the laptop's `~/.ssh/config`); default `<user>@<the hostname the browser used>` |
| `web.ui` | static UI directory to serve instead of the bundled one; unset → `web/ui/dist`. The old `"classic"` value (the removed vanilla UI) is ignored |
| `web.quickReplies` | composer chips: strings or `{ label, text }` |
| `web.models` | New session model picker: `[{ id, label }]` or bare ids (`""` = Claude's default, no `--model`); unset: the host's `overmind harness list` Claude models — Claude Code's aliases `fable`, `opus`, `sonnet`, `haiku` (always the newest model of each), labelled with the newest version Claude Code has used there (e.g. Sonnet 5.5) |
| `web.autoName` | `{ enabled, intervalMinutes }` (default off, 5 — opt in with `enabled: true`): the web server runs `overmind name --all --settled --apply` on its host on that schedule (a session is named once it has a second prompt or a brief) (tmux names follow the titles, see [Session titles](#session-titles)); a web spawn with a first prompt also gets a targeted `overmind name <id> --apply` once it has replied |
| `web.grouping` | `{ enabled, intervalMinutes }` (default off, 10): this host's web server runs `overmind group` over the whole overmind on that schedule and serves `/api/groups` (see [Smart grouping](#smart-grouping)) |
| `web.uploads` | `{ dir, maxMB, retentionDays }` (default `~/.local/share/overmind/uploads`, 100, 14): files dropped / pasted / picked in the web UI are stored there on the session's host as `YYYY-MM-DD/<rand>-<name>`, and their absolute path goes into the prompt; day dirs older than `retentionDays` are removed (`0` keeps them) |
| `web.briefs` | `{ enabled, model, idleMs, minIntervalMs, maxDeltaChars, maxCallsPerHour, minNewTurns, minNewChars, maxBriefChars }` (default off, `haiku`, 60 s, 15 min, 12000, 12, 2, 2000, 3000): background generation of [session briefs](#session-briefs) on this host; reading and editing briefs (and a manual regenerate) work either way |
| `web.stacks` | `{ syncMinutes }` (default 2): how often this host's web server runs `overmind stack sync` while any of its sessions is in a [stack](#session-stacks) |
| `web.discovery` | `{ watch, safetySeconds, fastGapMs, slowGapMs }` (default `true`, 30, 1000, 5000; a wrong type or a value below 1 / 0 / 0 fails at start): `watch` runs `overmind list` for this host's sessions when a watched file changes — at most every `fastGapMs` after the last list for the registry, names cache, `done.json`, stacks, Codex hook sidecars, a Codex/pi turn starting or ending and a new Codex/pi session's rollout, every `slowGapMs` for other transcript writes — and at least every `safetySeconds` while someone is asking; `false` (or `OVERMIND_WEB_WATCH=0`) is the kill-switch: a list on every 3 s tick behind a 2 s cache |
| `web.memos` | `{ dir, audioDir, model, vocabulary }` (default `~/.local/share/overmind/memos`, `~/.local/share/overmind/memo-audio`, `haiku`, `[]`): voice memos (`#/memos`). Each memo is `dir/<date>-<slug>.md` (frontmatter `title`, `created`, `duration`, `recording`, `status`; the transcript as the body), so `dir` can be a folder in a notes repo; segment audio stays in `audioDir`. `model` titles them via `claude -p`; `vocabulary` (names, projects, tools — up to ~1500 chars) steers the spelling of every segment's transcription. Needs the transcription key |
| `web.notes` | `{ root, name?, searchCmd?, exclude? }` (default off): the web UI's notes explorer (`#/notes`) over the markdown notes under `root` on this host — browse, full-text search (built in, or an external `searchCmd` such as `rg -n -i -F {query}`), preview with `[[wiki]]` / relative links between notes; hidden entries, `node_modules`, `.gitignore`d paths and age-encrypted blocks are never served (web/ARCHITECTURE.md → notes). Peers browse each other's notes through the usual proxy |
| `web.operator` | `{ hosts?, model?, voice?, clearIdleMinutes? }` (default `[self]`, Claude's default model, `alloy`, 60): the [voice operator](#voice-operator) — `hosts`: where it runs, the first that answers (set the same list on every machine so all talk to one operator); the model its Claude session runs; the OpenAI voice that reads its replies; `/clear` after that many idle minutes (0 = never) |
| `web.focus` | `{ host? }` (default: none): Focus mode — the sidebar toggle runs the `focus` CLI (Do Not Disturb + quitting distracting apps) on `host`, the machine you sit at; set the same on every machine. Unset, or a host without `focus` (501): no toggle |
| `web.files.roots` | array of dirs (`~` expanded, default `[]`): extra roots a relative file path in chat may be under. A relative path missing under the session cwd first matches files the session touched (from its transcript; a Codex row's rollout: `FileChange` files and its commands' writes), then ancestors of those, then these roots; the sandbox stays `$HOME` + cwd |
| `desktop.url` | the server [Overmind.app](desktop.md) opens instead of `hosts.<self>.web`; unset → this machine's server |
| `tmux` | tmux binary; `null` → `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` |
| `hosts.<name>.overmindBin` | path to `overmind` on that host; `null` → `~/.local/bin/overmind`, then `PATH` |
| `overmindBin` | this machine's `overmind` binary (used by the web server) |
| `claude` | command that launches Claude Code in spawned sessions (default `claude`) |
| `harnesses` | `{ codex: { command }, pi: { command } }`: how the [other harnesses](#other-harnesses) launch (default the bare name); plus, for `claude` / `codex` / `pi`, `model` and `effort`: the defaults a spawn uses when it picks none ([cli.md](cli.md#harnesses)). Read leniently |
| `spawnDirs` | directories offered for new sessions, per host (`paths.<host>`); also edited from the web UI (Settings → Start directories, which writes it through `overmind config set`). They are also the spawn allow-list. An entry with `"hidden": true` stays on the allow-list (e.g. a dir only an app's [embedded panel](#embed-view) spawns in) but is not offered in the New session menu; when a host has only hidden entries it offers Home, and the hidden dirs stay allowed. `overmind config show --resolved` lists them with `"hidden": true` |
| `tui` | dashboard preferences: `rows` (`"1"`, `"2"`, `"auto"`), `mouse` |
| `naming` | generated names: `enabled`, `model` (default `haiku`), `syncTmux` (tmux name follows the title, default on), `autoTitle` |
| `stacks` | [session stacks](#session-stacks): `enabled` (default `true` — `false` = never call the model; a new stack gets the skeleton StackBrief), `model` (default `sonnet`) |
| `restore` | [session recovery](#session-recovery): `onBoot` (default `false`) — when `true`, this host's web server runs `overmind --local restore --all` once at start if there are dormant sessions, at most once per boot (it remembers the boot id in `${XDG_STATE_HOME:-~/.local/state}/overmind/web-restored-boot`); the result is logged. For an always-on machine. Recently closed sessions are never part of it. `keepClosedDays` (default `7`, a number ≥ 0; `0` turns the [recently closed](#recently-closed) list off) — how long a session closed within a boot stays restorable; at most the newest 50 are kept |
| `bots` | [`overmind bots`](cli.md#bots), per machine: `{ "<name>": { schedule \| on, dir, prompt \| promptFile, command, harness, model, ghIdentity, enabled, keep, sessionName } }` — agent sessions this host starts from a recipe; `on: { github: { repo, branch, every, backfill } }` starts one per new branch instead of on a schedule ([GitHub triggers](cli.md#github-triggers)). Read leniently: a bad bot is a warning and is skipped |
| `ghIdentities` | [GitHub identities](cli.md#github-identities), per machine: `{ "<name>": { command, login, prompt } }` — GitHub Apps a spawned session can act as. Read leniently: an entry without `command` (or with a bad name) is skipped |
| `jobs` | the old name of `bots`, still read; a name in both is the `bots` one |
| `repos` | [`overmind repos`](cli.md#repos), per machine: `roots` (default `["~/Code"]`; every directory directly under a root with a `.git` is a repo; a root with its own `.git` is that one repo), `every` (default `"24h"`; `30m` / `12h` / `7d`), `overrides` (`{ "<dir name or ~/path>": "30m" }`), `exclude` (dir names or `~/` paths). Read leniently: a bad value is a warning and falls back to its default |
| `prs` | [`overmind prs`](cli.md#pull-requests), per machine: `orgs` (search only these orgs), `repos` (`owner/name`s; with `orgs`, any of them), `refresh` (default `"5m"`, at least `1m`: how old the cache may get), `worktrees` (default `"~/Code/worktrees"`: where `overmind pr checkout` puts new worktrees). None of `orgs`/`repos` = all of GitHub. Read leniently |
| `tasks` | [`overmind tasks`](cli.md#productive-tasks), per machine: `organization` (an id; may be left out when the token belongs to one organization), `projects` (ids: only tasks in these), `refresh` (default `"5m"`, at least `1m`), `token` (the Productive API token; `$OVERMIND_PRODUCTIVE_TOKEN` wins over it), `keychain` (else: the service name of a macOS keychain item holding it, read with `security find-generic-password -s <service> -w` — keeps the token out of the file; `$PRODUCTIVE_API_TOKEN` is the last fallback). Read leniently |
| `gh` | `gh` binary for `overmind prs`; `null` → `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` |
| `grouping` | smart grouping: `enabled` (default `true` — `false` = repository fallback only), `model` (default `haiku`), `host` (the one host whose web server runs it; peers proxy `/api/groups` there), `consolidateMinutes` (default 60) |
| `inbox` | the [inbox](#inbox): `host` (the one host whose web server runs it; peers proxy `/api/inbox` there — unset = no inbox), `scanMinutes` (60), `workHours` (`[8, 18]`), `workDays` (`[0,1,2,3,4,5,6]`, 0 = Sunday; the three are also set from Settings → Inbox), `model` (`haiku`, the Slack + mail scan), `briefModel` (`haiku`), `briefMinutes` (45), `language` (`"English"`, the brief's), `comms` (`true`; `false` = no Slack + mail scan). `OVERMIND_WEB_INBOX=0` turns it off on a server |
| `slack` | [Slack links](#slack-links): `host` (the host whose web server runs the bridge; peers proxy `/api/slack` there — unset = off), `owner` (your Slack user id `U…`: your messages in a linked thread are marked as the owner's), `owners` (a list of such ids, for a machine several people own, e.g. a shared shed: each is marked as an owner, may start sessions with a mention when `spawn.from` is unset, and `owner` is added first), `bridges` (`{ "<host>": "<bridge host>" }`: that host's sessions are linked by another bridge, one with its own Slack app; set it on every server you link from), `spawn` (read by the bridge's server: a mention of its app [opens a session](#slack-links) — `{ host (default: this one), dir (a spawn dir there; `~/…` = that host's home; none = its first), model, harness, ghIdentity, minutes (`1d`), mode, task, from }`, `from`: `"anyone"` in a channel the app is in, or a list of user ids; default the owners only). `OVERMIND_WEB_SLACK=0` turns it off on a server |

Rules: `~` is expanded at use time; unknown keys are preserved when the CLI rewrites the file
(writes go through the raw JSON, never the typed view); a missing file is fine — this machine is
the single host `local`, and remote features say "run `overmind init`"; a present but invalid file is
an error.

Env overrides for the web server: `OVERMIND_WEB_PORT` (or `PORT`), `OVERMIND_WEB_BIND`, `OVERMIND_WEB_UI`,
`OVERMIND_WEB_AUTONAME`, `OVERMIND_WEB_GROUPING`, `OVERMIND_WEB_BRIEFS`, `OVERMIND_WEB_WATCH`, `OVERMIND_BRIEFS_DIR`, `OVERMIND_STACKS_DIR`, `OVERMIND_CODEX_HOOKS_DIR`, `OVERMIND_BIN`, `OVERMIND_TMUX` — see [web/README.md](../web/README.md).

## Session discovery

Claude Code keeps a live registry: one `~/.claude/sessions/<pid>.json` per running interactive
session with its session id, cwd, name, status (`busy` / `idle` / `waiting`) and what it waits for.
That is the source of truth; `overmind` enriches each entry:

1. **pid → tty** via `ps`.
2. **tty → terminal**: match against `tmux list-panes -a` (pane id, window name, tmux session) and,
   on macOS, iTerm's sessions (session id, tab title). The match decides the **backend**
   (`tmux` / `iterm` / `unknown`) and the **handle** used to control it (tmux pane id like `%87`,
   or the iTerm session id).
3. **titles** from the naming cache (never generated by `list` itself).
4. **subagents and background shells** (`core::background`). The registry says `busy` while *any*
   agent of the session generates, background subagents included, and `shell` while only
   background shells run — though the main prompt is free and takes input at once. So for a
   `busy` / `shell` entry overmind reads the main transcript: a turn ends with `system` /
   `turn_duration`; an `Agent` result with `toolUseResult.status: "async_launched"` starts a
   background agent, a Bash result with `backgroundTaskId` a background shell, and a
   `<task-notification>` (in a user entry or a queue operation) ends either (`SendMessage` starts a
   finished agent again; `TaskStop` / `KillShell` stop one; what started before the process did is
   not running). When the main turn has ended and something runs beside it (or the registry says
   `shell`), the session is reported `idle` — `updated_at` then is when the turn ended — with
   `background`. An `Agent` call not answered yet in a turn in progress is a foreground agent
   (`background: false`). None of this is a stable Claude Code API: what is not recognised leaves
   the registry status as it is.

Headless runs (`claude -p`, SDK and CI entrypoints) register too and are filtered out.
A host that never ran Claude has no registry: that is no Claude rows, and Codex and pi are still
looked for ([Other harnesses](#other-harnesses)); a registry that exists but can't be read is an error. The web
server's watcher is healthy with any one session root (the registry, `$CODEX_HOME/sessions`, pi's
`sessions`); with none it lists on its TTL ([web/ARCHITECTURE.md](../web/ARCHITECTURE.md)).

### Other harnesses

Codex and pi sessions (`core::harness`) have no registry. One `ps -axww -o pid,etime,tty,args`
finds their interactive processes with a terminal (`codex`, `codex resume|fork`, `pi` — not
`codex exec|app-server|…`, `pi -p|--mode json|install|…`); one `lsof -d cwd` gives their cwds. A
harness whose state dir (`$CODEX_HOME` or `~/.codex`, `$PI_CODING_AGENT_DIR` or `~/.pi/agent`) does
not exist is skipped. Each process is matched to a transcript:

- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, first line `session_meta` (`id`,
  `cwd`, `timestamp`); only files written to since the oldest process started are read. Names come
  from `~/.codex/session_index.jsonl` (`/rename`, or the title Codex generates) with
  `name_source: "codex"`. A sub-agent thread (`spawn_agent`) writes its own rollout in the
  parent's cwd, created mid-turn, so it would win the parent's process: a first line with
  `payload.thread_source: "subagent"` (or `payload.source.subagent`) is skipped and never becomes a
  session.
- **pi**: `~/.pi/agent/sessions/--<cwd, / as ->--/*.jsonl`, first line `{ type: "session", id,
  cwd, timestamp }`; `/name` is a `session_info` entry (`name_source: "user"`).

The Codex model picker (`codex_models`) is the newest `visibility: "list"` model of each family in
`models_cache.json` — family = slug minus its version (`gpt-6.1-sol` and `gpt-6-sol` are both `sol`),
newest by version, ties to Codex's lower `priority` — in Codex's priority order; a slug without a
version is a family of its own. Its first entry reads plain `Default`, exactly like Claude's: it does not
name `config.toml`'s `model` (pi's does, `Default (x)`).

Matching: an id on the command line (`codex resume <id>`, `pi --session <id>`) wins, and so does a
transcript the process holds open itself (`lsof`, or `/proc/<pid>/fd` on Linux): an embedded Codex
TUI keeps its own rollout open, so its row shows its thread even where the guards below would
leave it contested. In daemon mode the app-server daemon holds every pane's rollout, which tells
nothing, and the rest applies. Otherwise,
later-started processes first, the newest transcript in the process's cwd created after it
started (3 s slack), then the newest written to since it started. Three guards keep a closed
sibling's transcript (same cwd) from taking a survivor's row, and one pane's thread from another's
— the row's id would change and sends, keys and approvals would go to the wrong pane:
- **Owners**: each list records which process (pid + start time) runs each thread. The file is
  `$OVERMIND_HARNESS_OWNERS`, else `<state dir>/harness-owners.json`:
  `{ "<harness>": { "<session id>": { pid, startMs, closedMtimeMs?, contestedBy?, resumed? } } }`.
  It is read, matched and written under `<file>.lock` (lists run concurrently), and written only
  when a thread starts, moves, closes or narrows. By cwd, a process never takes a thread another
  live process runs, nor a gone process's thread. The first list that sees the owner gone stores
  the transcript's mtime then (`closedMtimeMs`): the thread is foreign until it grows more than
  10 s past that (taken up again with `/resume`; the 10 s cover the app-server daemon's last
  writes after its TUI exits). A gone owner's entry is dropped once its transcript is older than
  the oldest live process. An unreadable file is said once on stderr and starts empty.
- **Starters**: a thread no one is recorded with goes to a process only when that process alone
  could have started it: the processes in its cwd that existed when it was created (3 s slack),
  less one that kept writing its own recorded older thread past then (busy, so not its `/new`).
  Nothing else rules one out. Codex stamps a thread when its TUI starts and a `/new` thread at the
  `/new`, so a pane opened within 3 s of a sibling's `/new` fits both, and so does an idle
  sibling of any fresh pane. When more than one process could have, the thread is recorded with
  them (`contestedBy`; `resumed` when it was taken up again, judged by its last write instead of
  its creation), also when no row took it, while they are all alive, and **no row shows it**: a
  row shows an older thread of its own, or none, rather than one that may be another pane's. A
  starter drops out once seen busy on its own older thread; when one live starter is left (and no
  gone one), it becomes the owner and its row shows the thread. A contested thread one of whose
  starters is gone is closed like a gone owner's (`closedMtimeMs`): no row takes it until it grows
  more than 10 s past that, then it goes to the one process that could have taken it up. The
  costs are mostly a missing thread; the one known case of another pane's thread is under "Left open":
  - A pane opened beside an idle Codex pane in the same cwd shows no thread until the idle pane is
    used again (its next turn proves it was not the `/new`) — in daemon mode; an embedded pane
    holds its rollout open and shows it at once.
  - Two panes opened within 3 s of each other in one cwd show none for as long as both stay open
    without a recorded thread; when one closes, the other's shows once it is written again.
  - A `/new` pane's row stays on its older thread until its sibling is busy on its own.
  - On a host's first list (or after an unreadable owners file) only the earliest pane in a cwd
    is certain; each later one shows its thread once the panes before it are seen busy on theirs.
    A closed sibling's thread created after a live pane started is shown as that pane's (the
    same class as the "Left open" case below).
- **Superseded**: a newer candidate is the process's `/new` only if its own recorded older thread
  went quiet when it appeared (5 s slack). Codex 0.166 does not write the old rollout after
  `/new` (checked live with the mock).

Left open: a thread started and closed between two lists, beside a sibling idle since before
it, is still taken by the sibling. A `/new`, a prompt, then `/resume` back to the older thread
makes A's older thread write past the `/new` thread's creation, which reads as proof A did not
start it; an idle same-cwd sibling B is then the only starter left, so A's `/new` thread is
recorded as B's and shown on B's row (until B is written again, while both live). No
mtime-only rule tells this from B's own `/new` while A stayed busy; accepted as rare. A planned
follow-up breaks the tie by the thread's last prompt on each candidate pane's screen. A `codex exec` / `codex review`
rollout (`session_meta` `source: "exec"` or `originator: "codex_exec"`, the markers the web
watcher drops) is only ever matched by id: by cwd, one run beside an open TUI would take its row.
A Codex session before its first prompt has no transcript yet: `session_id` is `null` and its title `<cwd>-codex`.

Codex runs a session's shell commands through a shared app-server daemon, so in them `$TMUX_PANE` is the pane that started the daemon (or unset); `$CODEX_THREAD_ID` is the session's `session_id`, and `overmind done` / `overmind slack link|reply` find their own session by it (`core::done::own_pane`).

Status from the transcript tail (512 KiB; for Codex, widened to 16 MiB when the tail holds no
`task_started` / `task_complete` / `turn_aborted`, since one turn's tool output can outgrow it):
Codex is `busy` from `task_started` until `task_complete` / `turn_aborted` (approvals: below). An embedded-mode Codex killed mid-turn never
closes its turn, and `codex resume` does not either, so an open turn in a rollout nothing was
written to since the current process started (2 s slack for `etime`) is `idle`; a daemon-mode turn
the new TUI reattached to keeps writing and stays `busy`. "Written" is the newest line `timestamp`
in the tail, mtime only when no line has one: a branch's synthetic rollout is new on disk but keeps
the original turn's stamps. pi is `busy` while the last message is the user's, a tool result, or an assistant turn
that stopped for a tool call. `context` comes from Codex's last `token_count`
(`last_token_usage.input_tokens` of `model_context_window`); pi records no window, so it is `null`.

**Codex approvals** (`core::codex_hooks`; Codex 0.166 findings in
[codex-findings.md](codex-findings.md)). Codex writes nothing for a pending
approval, so a busy Codex row is `waiting` while, and only while, its terminal shows the approval
menu. Two things only *trigger* a look at the screen:

- a **sidecar** from the opt-in hook (`overmind codex hooks install`, see [cli.md](cli.md#harnesses)):
  `PermissionRequest` runs `overmind _codex-hook` (async: it never blocks or decides), which writes
  `${XDG_STATE_HOME:-~/.local/state}/overmind/codex-hooks/<session_id>.json` (`$OVERMIND_CODEX_HOOKS_DIR`
  overrides: absolute or `~/…`, a relative value ignored; 0600, a per-process tmp file + rename) — `{ v: 1, thread_id, turn_id, transcript_path, state:
  "waiting"|"clear", event, tool, command, reason, cwd, at }`; `Stop` and `UserPromptSubmit` write
  `clear`. A `waiting` sidecar counts when `at` is no older than the process (2 s slack) and no
  `task_started` / `task_complete` / `turn_aborted` follows it. A sub-agent's approval carries the
  parent's `session_id`, and the parent's screen shows the menu;
- a **pending call that may ask** in the rollout: the current turn's oldest call that may ask, with no
  `custom_tool_call_output` / `function_call_output` for its `call_id` (and, for exec, no
  `item_completed CommandExecution` of the same command) and no turn end after it (a call that
  cannot ask, after it, changes nothing) — an `exec`
  script whose `exec_command(…)` asks `sandbox_permissions` `require_escalated` (quoted key in
  embedded mode, bare in daemon mode; the command is the first `cmd` string literal of it, " (+N)"
  when several ask) — or an escalated `exec_command` / `shell` function call (outside code mode,
  seen in embedded mode); an `apply_patch` (its own `custom_tool_call`, or `tools.apply_patch(…)` in an
  `exec` script; the files are its `*** Update/Add/Delete File:` lines); an MCP tool
  (`tools.mcp__<server>__<tool>(…)` in a script, or a `mcp__…` function call; shown `server.tool`).
  Codex 0.166 fires no `PermissionRequest` hook for a patch, so the rollout is its only trigger; an
  MCP approval fires one with `tool_name: "mcp__<server>__<tool>"` and no command.

Truth: on tmux any trigger costs one `capture-pane`; the row is `waiting` iff one of Codex's three
menus is in the last 40 lines — a head (`Would you like to run`, `Would you like to make the
following edits?`, `Allow the <server> MCP server to run tool "<tool>"?`), an option `1.` line and
that head's own footer (`Press enter to confirm` for the first two, `enter to submit | esc to
cancel` for MCP), in that order (trailing blank padding dropped; `✔ You approved …` / `• Called …`
have none, and output that merely quotes the strings has no option line between them), else
`busy`, also on a peek error. The screen names the kind, whatever triggered the look. iTerm rows peek (one
osascript, 0.1–0.3 s) only while a sidecar's command has not run (no `item_completed` of it, no
output of its call) — once answered the menu is gone for the rest of the turn, and nothing fires
to say so. Without the hook an iTerm row stays `busy`. A row with no backend has nothing to peek: a sidecar's
`waiting` stands until its command completes in the rollout or the turn ends (an approved long
command reads `waiting` until it finishes); the rollout alone never makes it wait. The look runs
every poll for as long as a trigger holds — the whole menu time, and the run of an approved
escalated command until its `item_completed`. Leaving the menu in the TUI writes no file, so the
web server reuses a list holding a waiting Codex row for its TTL (2 s), not the watcher's 30 s
safety interval; an approval answered in the TUI reads `busy` on the web ~3.5 s later (the 3 s
refresh plus one list, measured on Codex 0.166). The hook fires ~1 s before Codex draws the menu,
so the list its sidecar starts usually finds no menu yet: such a busy row carries
`approval_unseen` (the request it looked for), and the web server looks again 1 s later — at most
3 times per request, never again once that request was seen `waiting` — so the row reads `waiting`
~1–2 s after the menu shows instead of at the next unrelated list. `waiting_for` is `<label>: \`<what>\``:
`exec approval: \`<command, first line, ≤ 80 chars>\``, `patch approval: \`<file names, ", "-joined,
" (+N)" past three>\``, `MCP approval: \`<server>.<tool>\`` — the label from the menu on screen (the
hook's `tool_name` only where nothing can peek: `Bash` → exec, `apply_patch` → patch, `mcp__…` →
MCP, else `<tool> approval`); the menu text is the web card's. The trigger's request (`approval_id`)
is the current turn's **oldest** unanswered call that may ask (an escalated exec, a patch, an MCP
call) — Codex asks them in order; a call that cannot ask (`update_plan`, a plain exec) neither sets
nor clears it, and a turn start or end clears them all. Once the screen shows the menu, the row's
`approval_id` is the oldest such call **of the menu's kind** (else the oldest): a call that may ask
need not (an approved exec still running, an MCP call Codex never gates — the rollout cannot tell),
so an older running MCP call never takes a later patch's request. The patch card adds a diff preview: the
pending `apply_patch` call's patch from the rollout (≤ 60 lines), only when that call is the row's
`approval_id` (any pending one for a hook stamp), its files are exactly the menu's `Destination:`
paths **and** its `+`/`-` lines are exactly the ones Codex drew above the menu (`• Edited …`) —
none for a script with two `apply_patch` calls, nor when the drawn diff is cut short or scrolled
away. One call can ask twice (two patches or two MCP calls in one script), so the card id also
mixes in what the screen draws: a patch's drawn diff, an MCP call's arguments. Sidecars of
threads no live row has (and temp files a killed hook left) are deleted after an hour, by any
`list` on a host with a Codex home, Codex running or not — only files provably ours (a
`<thread>.json` holding that thread's v1 sidecar, the exact temp-file pattern), since
`OVERMIND_CODEX_HOOKS_DIR` may point at a dir holding other files.

Targets (`peek <target>`, `send <target>` …) resolve against title, name, session-id prefix or pid,
walking exact → prefix → substring → characters-in-order; two matches on the same rung is an error
listing the candidates, so a loose fragment can never type into the wrong session.

## Session titles

One title per session, one source of truth (`core::title`):

- **The Claude session name is the truth.** `/rename` sets it and Claude persists it in its
  session registry (`name`, `name_source: "user"`).
- **`display_title`** is derived once, in core, and shipped in `list --json`: the Claude name when
  someone chose it (`name_source` ≠ `derived`), else the generated title (`gen_title`), else a
  slug of the first prompt, else Claude's derived `<cwd>-9d` name, else the short session id / pid.
  The CLI, TUI and web UIs draw only this; the tmux name is at most metadata (details panel, the
  TUI's terminal column).
- **The tmux session name is derived**: a slug of the title (lowercase kebab, common Latin
  accents folded, ≤ 48 chars), `-2`, `-3`… on a collision; a name already derived from the title
  (with or without its suffix) is left as is. It is synced on **every** rename — `overmind rename`,
  `overmind name --apply` (auto-naming), the TUI rename buffer, the web UI — but only when the tmux
  session is that Claude session's own: one window, one pane. Shared sessions, `overmind` and the
  dashboard's own session are left alone, with a note saying so. `naming.syncTmux = false` or
  `--no-tmux-sync` opts out.
- **Reverse edge**: `overmind tmux rename` of a single-Claude tmux session renames the Claude session
  (and so the title); raw `tmux rename-session` is not watched and is overwritten the next time the
  title changes. Auto-naming never clobbers a hand-picked tmux name: a derived-name session alone in
  a non-generic tmux session (not `om-hhmmss`, digits or `<cwd>-xx`) adopts that name as its title.
- **iTerm** tab titles are not touched: Claude already puts its session name in the terminal title,
  and a tab title set by hand is the user's.
- **When `/rename` may be typed**: `/rename <title>` + Enter goes into the live Claude TUI. A
  session **waiting** on a permission prompt or question is held (the keys would answer it; `--force`
  overrides). A **busy** session is renamed: Claude Code runs `/rename` as a local command the moment
  it is submitted, mid-turn, and the turn carries on untouched (verified live; an older Claude that
  queues input would run it after the turn). Codex and pi get their own command (`/rename`,
  `/name`), and a **busy** one is held (`held: "busy"`): they would queue the text as a message.
  Nothing is queued by overmind — a held rename is refused
  with a message and retried by the caller. Known gap: text half-typed into the session's prompt
  box would be prefixed to `/rename`.

## JSON contracts

These are stable APIs — the web app, scripts and future UIs depend on them. Add fields freely;
never rename, remove or change the type of an existing one without a version bump.

### `overmind list --json`

An array of sessions; every row carries `host` (the name the *caller's* config knows that machine
by — with no config, `local`):

| field | type | notes |
| --- | --- | --- |
| `pid` | number | agent process id |
| `session_id` | string \| null | Claude session UUID |
| `name` | string \| null | Claude session name |
| `name_source` | string \| null | `"derived"` = Claude's cwd+hash fallback |
| `cwd` | string \| null | working directory |
| `status` | string | `busy` \| `idle` \| `waiting` \| `unknown` — `idle` = the main prompt is free, subagents may still run (`background`) |
| `waiting_for` | string \| null | what a `waiting` session is blocked on |
| `approval_id` | string (absent when none) | a `waiting` Codex row's approval request: its escalated call's `call_id`, else `hook-<sidecar stamp>`. The same command asked again is another id (the web card's id mixes it in) |
| `approval_unseen` | string (absent when none) | a `busy` Codex row whose approval trigger (hook sidecar or pending escalated call) fired but whose screen showed no menu when looked at: that request's id (what `approval_id` would be). The menu may not be drawn yet — a caller may look again shortly |
| `updated_at` | number \| null | last status change, ms since epoch |
| `background` | object \| null | what runs beside the main thread: `{ agents: [{ id, description, type, model, background, started_at, last_activity_at, activity }], shells }` (`background: false` = a foreground agent; `activity` = its last tool call, like `Bash: run the tests`); `null` = none or unknown |
| `prompted_at` | number \| null | last human prompt (transcript `origin.kind: "human"`), ms since epoch; `null` when unknown (none yet, Codex / pi). The web list sorts by it |
| `tty` | string \| null | |
| `backend` | string | `tmux` \| `iterm` \| `unknown` |
| `handle` | string \| null | tmux pane id or iTerm session id |
| `tab` | string \| null | tmux window name / iTerm tab title |
| `tmux_session` | string \| null | tmux session the pane lives in |
| `title` | string \| null | first prompt (can be long) |
| `gen_title` | string \| null | generated title, if cached |
| `display_title` | string | **the** title every view draws — see [Session titles](#session-titles) |
| `context` | object \| null | context-window usage (below); `null` when no transcript usage is found |
| `stack` | object \| null | `{ id, label }` of the [session stack](#session-stacks) the session is a member of; `null` when none (read-only stamp: `list` never syncs or writes stack files) |
| `harness` | string | `claude` \| `codex` \| `pi` — see [Other harnesses](#other-harnesses) |
| `model` | string \| null | the model it runs, when known (Claude: the context entry's) |
| `transcript` | string \| null | absolute transcript path (Codex / pi only) |
| `origin` | object \| null | `{ job, run }` of the [job](cli.md#bots) run that started the session (its tmux pane option `@overmind_job_run`); `null` when none |
| `embed` | string \| null | the app whose [embedded panel](#embed-view) started the session (its tmux pane option `@overmind_embed`); `null` when none |
| `git` | object \| null | the git checkout its cwd is in, read from the `.git` files: `{ branch, root, linked, repo }` — `branch` (`null` = detached), `root` (absolute), `linked` (`true` = a linked worktree, `false` = the main checkout), `repo` (GitHub `owner/name` of `origin`, `null` when none). `null` outside a checkout. The web UI links a session to a pull request by `repo` + `branch` (a linked worktree only), on any host |
| `host` | string | which machine the row came from |

`list --all-hosts --json` is the same array across every configured host.

#### Context usage

`context` is `{ used, window, pct, model }`, computed in `core::context` from the tail of the
session's transcript (`~/.claude/projects/<cwd with / and . as ->/<session_id>.jsonl`, falling
back to a scan of the project dirs when the session's cwd changed):

- **`used`** (number): prompt tokens of the **last main-thread assistant entry** with real usage —
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Sidechain (subagent)
  entries, API-error entries, `<synthetic>` and all-zero usage are skipped. Output tokens are not
  counted (the same sum Claude Code's statusline context percentage uses); the reply is counted as
  input on the next turn.
- **`window`** (number): `200000` or `1000000`, inferred — transcripts don't record it. 1M when the
  model id ends in `[1m]`, when the model is natively 1M in Claude Code without a suffix (every
  Fable and Mythos, Opus / Sonnet 5.5 and later), when `used` already exceeds 200k, when `settings.json` pins a `[1m]`
  model of that family, when Claude Code's `~/.claude.json` has recorded that exact model id as
  `<id>[1m]`, or when another live session on the same model id is past 200k without a suffix
  (the model is natively 1M). Otherwise 200k — so a 1M session under 200k with none of these
  signals over-reports its percentage.
- **`pct`** (number): `round(used / window * 100)`; can exceed 100.
- **`model`** (string \| null): `message.model` of that entry.

### Subscription usage

`overmind usage --json` (and the web's `GET /api/hosts/:host/usage`, which adds `host`) reports the
Claude subscription limits of the account logged in to Claude Code on that machine, and under
`openai` the ChatGPT plan Codex is logged in with, from `core::usage`:

```json
{
  "provider": "claude",
  "account": { "uuid": "…", "email": "…", "organization": "…", "plan": "max", "tier": "default_claude_max_5x", "plan_label": "Max 5x" },
  "limits": [
    { "kind": "session", "group": "session", "label": "Current session", "model": null, "percent": 18.0, "severity": "normal", "resets_at": "2026-09-29T22:20:00+00:00", "active": false },
    { "kind": "weekly_all", "group": "weekly", "label": "Weekly · all models", "model": null, "percent": 38.0, "severity": "normal", "resets_at": "…", "active": true },
    { "kind": "weekly_scoped", "group": "weekly", "label": "Weekly · Fable", "model": "Fable", "percent": 37.0, "severity": "normal", "resets_at": "…", "active": false }
  ],
  "extra_usage": { "enabled": false, "used": 0.0, "limit": null, "currency": "USD", "percent": 0.0 },
  "fetched_at": "2026-09-29T20:00:00+00:00",
  "stale": false,
  "error": null,
  "openai": {
    "provider": "openai",
    "account": { "uuid": "…", "email": "…", "organization": null, "plan": "plus", "tier": null, "plan_label": "ChatGPT Plus" },
    "limits": [
      { "kind": "session", "group": "session", "label": "Current session", "model": null, "percent": 3.0, "severity": "normal", "resets_at": "…", "active": false },
      { "kind": "weekly_all", "group": "weekly", "label": "Weekly", "model": null, "percent": 2.0, "severity": "normal", "resets_at": "…", "active": false }
    ],
    "extra_usage": { "enabled": false, "used": null, "limit": null, "currency": null, "percent": null, "balance": 0.0 },
    "fetched_at": "…", "stale": false, "error": null
  }
}
```

- **`openai`** (since the field was added; absent when `$CODEX_HOME/auth.json` holds no ChatGPT
  login): the same shape, from the endpoint Codex's `/status` calls (`GET
  https://chatgpt.com/backend-api/wham/usage`) with Codex's access token and `ChatGPT-Account-Id`.
  Its `primary_window` / `secondary_window` become the session and weekly limits; a
  `code_review_rate_limit` or `additional_rate_limits` add scoped ones (`Weekly · Code review`);
  `credits` becomes `extra_usage` with `balance`. Codex and pi share the plan; pi's own login is
  another OAuth app the endpoint refuses, so only Codex's is read. Cached in
  `$CODEX_HOME/overmind-usage.json` like the Claude read. When one provider fails with nothing
  cached and the other has a read, the command still succeeds: the failed one comes back with
  empty `limits` and `error` (the Claude one at the top level, with `account: null`).
- **Source**: the plan-usage endpoint Claude Code's `/usage` calls (`GET
  https://api.anthropic.com/api/oauth/usage`), authenticated with Claude Code's OAuth access
  token — the macOS keychain item `Claude Code-credentials`, else `~/.claude/.credentials.json`.
  The endpoint is undocumented: its generic `limits` list is used when present, the named windows
  (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`) otherwise. `curl` makes the
  request, with the token on stdin (never in argv). The token is never refreshed (that would
  rewrite Claude Code's credentials): an expired one is an error until Claude Code runs again.
- **`account`**: from `~/.claude.json` (`oauthAccount`) and the credentials' `subscriptionType` /
  `rateLimitTier`; `null` when unknown. The web groups hosts by `account.uuid`, so machines on one
  subscription share one card.
- **`limits[].active`**: the limit currently binding. `severity` is the endpoint's (open set:
  `normal`, `warning`, …); `percent` may exceed 100.
- **Caching**: `~/.claude/overmind-usage.json` holds the last good read and the last failure. A read
  younger than 60s is served from it; after a failure the last good read comes back with
  `stale: true` and `error`, and the endpoint isn't asked again for 2 minutes. With no good read
  at all, the command fails (exit 1) with the reason.

Only the tail is read (256 KiB, widened to 2 MiB then 8 MiB if no usable entry is in it), and the
result is cached in-process per `(path, size, mtime)`, so the `watch` dashboard re-reads a
transcript only after it has grown. Views colour `pct` in the same bands: under 60 dim, 60–85
amber, over 85 red.

### `overmind group --json`

See [cli.md](cli.md#grouping) for the shape. State file: `groups.json` (below).

### `overmind tmux list --json` / `overmind tmux stale --json`

See [cli.md](cli.md#tmux-sessions) for the shapes. `tmux list --json` lists live sessions only;
dormant ones are in `overmind restore --json`.

### `overmind prs --json`

See [cli.md](cli.md#pull-requests) for the shape. Column ids and `Pr` fields follow the add-only
rule; `local` and `rotting` are worked out on every call and never cached, and so is the **unseenMentions** column:
the cache keeps each PR's own column and its `mention`, and every read moves the PRs whose mention
is neither answered nor marked seen (`prs-seen.json`) there.

### `overmind tasks --json`

See [cli.md](cli.md#productive-tasks) for the shape. Column ids, `Task` and `Status` fields follow
the add-only rule; `column` is worked out on every call (the due-soon window moves with the date),
never cached. Each PR's `tasks` (in `overmind prs --json`) holds the task ids its title or description
links to — the join between the two lists.

### `overmind restore --json`

`{ host, bootId, dormant: [DormantView…] }`, and the restore / forget results — see
[cli.md](cli.md#session-recovery) for the shapes and [Session recovery](#session-recovery) for the
state file behind them.

### Web API

JSON over HTTP, errors as `{ "error": "..." }`. At a high level:

| method | path | purpose |
| --- | --- | --- |
| GET | `/api/health` | name, version, apiVersion, self, uptime, autoName (`lastRun`), discovery (`mode`: `watch`/`degraded`/`idle`/`ttl`, `lastListAt`, `listRuns`, `ttlMs`; with a watcher also `safetyMs`, `gaps`, `events`, `roots`) |
| GET | `/api/settings` | apiVersion, self, host names, quick replies, `transcribe: { enabled }` (this server has a transcription key), `speak: { enabled, voice }` (it can read replies aloud), `operator: { enabled, hosts }` (the [voice operator](#voice-operator) and where it runs), `focus: { host }` (`web.focus.host`, null when unset) |
| GET | `/api/overmind[?local=1]` | `{ self, hosts: [{ name, ok, error?, sessions, spawnDirs, hiddenSpawnDirs?, home?, notes?, stacks? }], snapshotAt }` — `spawnDirs` (`[{ label, path }]`): what that host offers in New session, without its hidden entries (Home when it offers none); `hiddenSpawnDirs` (same shape, present only when it has any; older servers omit it): its `hidden: true` entries, allowed for spawns (the embed view checks `dir` against both) but not offered — `home`: that host's home directory (for `~/…` paths, e.g. the [embed view](#embed-view)'s `dir`); older servers omit it — `stacks`: that host's [session stacks](#session-stacks), compact (`{ id, label, host, members: [{ session, host, live }] }`), from which the merged view stamps `stack: { id, label, host }` on the rows of members running on *other* hosts; sessions are `list --json` objects + `host` (a Codex session with no transcript yet gets `session_id: "pid-<pid>"` until it has one) (`title` capped at 300 chars) + `editorUrl` (the "Open in editor" link for its cwd, built by the server that answered — see [Session briefs](#session-briefs)); the merged view is a warm background-refreshed snapshot |
| GET | `/api/hosts/:host/sessions/:id/peek?lines=N` | plain-text screen |
| GET | `/api/hosts/:host/sessions/:id/screen` | the live terminal: the pane's visible rows with colours + size, cursor and input modes (tmux only, 409 otherwise) — see web/ARCHITECTURE.md |
| POST | `/api/hosts/:host/sessions/:id/input` | `{ data }` → raw terminal input written to the pane as is (`send-keys -H`): keys, escape sequences, mouse reports. Types into the agent like `send`; one key / mouse event per request (two escape sequences in one write reach Claude Code as Esc, which cancels a prompt) |
| GET | `/api/hosts/:host/sessions/:id/messages?limit=N[&after=<cursor>]` | conversation (no tool calls) from the transcript, plus `full`, `from`, `cursor`; `after` (the previous answer's `cursor`; present but empty = none yet) asks for only what changed since it — `full: false` = keep the messages before index `from` and append `messages` (none and `from === total` = unchanged), `full: true` = replace — and moves the on-screen prompt below into a `screen` field (`null` when none), sent on every such answer; see web/ARCHITECTURE.md → Chat deltas; an AskUserQuestion call is a message of `kind: "question"` with `id` (the tool use id), `questions` (`[{ question, header, multiSelect, options: [{ label, description }] }]`), `text` (a markdown rendering) and, once it has a result, `answers` (per question, the answer string) or `declined: true`. Claude Code (2.1.310+) writes the call to the transcript only once it is answered, so while the session waits on one the terminal is read instead: the prompt's current tab (or its "Review your answers" screen, a question with `noOther: true`) is appended as a question message with `id: "screen:<hash>"`, one question per tab. A **Codex** row waiting on an approval gets the same: its menu read off the screen as one question (`noOther: true`, the options without their `(y)`/`(p)`/`(a)`/`(esc)` hotkeys). An exec menu: `header: "Approval"`, the question `Would you like to run the following command?\n[Thread: …\n]$ <cmd>\nReason: …`, option 2 ("don't ask again for commands that start with …") `secondary: true` with a description saying it adds a permanent allow rule for every Codex session on the host. A patch menu: `header: "Edit approval"`, the question `Would you like to make the following edits?\n[Thread: …\n]Files:\n  <path relative to the cwd>…`, option 2 ("don't ask again for these files", this session only) `secondary: true`, and an optional `preview` — the pending patch, ≤ 60 lines, only when it is the one Codex drew above the menu (see Other harnesses). An MCP menu: `header: "MCP approval"`, the question `Allow the <server> MCP server to run tool "<tool>"?` plus the argument lines as drawn, "Allow for this session" and "Always allow" (writes `approval_mode = "approve"` to Codex's config.toml) `secondary: true`; a prompt typed while Claude works and still in its queue is a `kind: "user"` message with `queued: true`, always last (prompts it took mid-turn show where it took them) |
| POST | `/api/hosts/:host/sessions/:id/branch` | `{ ref, harness?, model?, effort?, prompt?, name?, title? }` (`title` and `effort` as in `/spawn`) → a **new session** whose history is the conversation up to and including the message `ref` (each `…/messages` message carries `ref`: a Claude entry `uuid`, a Codex `c-<hash of its rollout line>`); the source is untouched. Claude Code and Codex sessions only (409 otherwise). Same agent (default): the transcript is copied under a new session id — Claude: the `parentUuid` chain root → message, `sessionId` rewritten, titles dropped, a trailing tool call stripped; Codex: the rollout through the message's turn, `session_meta.id` rewritten, a `session_index.jsonl` entry for the name — and resumed in a new tmux session in the source's cwd (`claude --resume <id>` / `codex resume <id>`). Other agent: the prompts and replies (no tool calls) go to a markdown file under the prompt dir and the new agent's first prompt tells it to read it. From a **prompt** (user message) the cut is just before it and it is sent again as the first prompt (`prompt` replaces it); from a **reply**, `prompt` is an optional first message → `{ host, source: { id, harness, transcript }, ref, harness, sessionId (null for another agent), transcript, handoff, spawn }`. 400 bad request / not a prompt or reply, 404 unknown message or transcript, 409 tmux name taken. Starts an agent |
| POST | `/api/hosts/:host/sessions/:id/send` | `{ text }` → typed + Enter |
| POST | `/api/hosts/:host/sessions/:id/keys` | `{ key }` (Enter, Escape, …) |
| POST | `/api/hosts/:host/sessions/:id/answer` | `{ toolUseId, answers: [{ options: [index…], text? }] }` (one per question) → types the arrows/Enter/text a human would into the pending AskUserQuestion prompt. 400 bad answer (single-select: one option or text; multi-select: at least one), 404 unknown question, **409** (nothing typed) when it is already answered, the session isn't waiting, or the terminal isn't showing that prompt untouched (first question, cursor on option 1). A `screen:` id answers just that tab, and only while the terminal still shows it; a Codex approval is answered by its menu index (Down × index, Enter — option 3 ends the turn like Esc). A single pick (every Codex approval) reads the screen again before each ↓ after the first and before its Enter, and goes on only while the same prompt shows with the cursor where its keys put it — else 409, no Enter, the cursor at most one ↓ off (keys move the cursor relative to where it is). A Codex card's id includes the row's `approval_id`, and a `screen:` answer lists afresh to check it: a card for an earlier request is 409 against a later one with the same text |
| POST | `/api/hosts/:host/sessions/:id/rename` | `{ title }` (1–64 chars, one line) → `overmind rename <session_id> <title> --json`; 200 with the report, **409** when held (waiting on a prompt, or a busy Codex / pi session; nothing typed), 400 bad title, 502 CLI failure |
| POST | `/api/hosts/:host/sessions/:id/autoname` | regenerate one session's name → `overmind name <session_id> --apply --refresh`; 200 `{ ok, host, id, name }` (`name` null: unchanged), **409** when held (waiting on a prompt; nothing typed), 502 CLI failure |
| POST | `/api/hosts/:host/spawn` | `{ name?, title?, dir?, prompt?, model?, effort?, harness?, ghIdentity?, embed?, slack? }` → new tmux session running that [harness](#other-harnesses) (`claude` default, `codex`, `pi`; its launcher is config `claude` / `harnesses.<id>.command`; `-n <name>` for Claude and pi only); `effort` (a lowercase level, else 400) is typed as Claude `--effort`, Codex `-c model_reasoning_effort=`, pi `--thinking`, over the host's default effort — the UI offers only the levels the picked model takes (`harnesses` → `models[].efforts`, else `efforts`), and the server checks it against the same rows (cached, as `harnesses`): a level the picked model (none = Default) doesn't take is a 400 naming the ones it does, worded like the CLI — no check when the host's rows list no levels (a CLI from before per-spawn effort), and a peer sibling is checked by the peer; `/spawn`, `prs/spawn`, `tasks/spawn`, `branch` and a local stack sibling check it, `schedule` leaves it to `overmind schedule add`; `prs/spawn`, `tasks/spawn`, `schedule`, `branch` and the stack spawns take it too; `title` (1–64 chars, one line) is the name as typed — the agent's display name, the tmux session a slug of it (unless `name` is given; a title with no ASCII letters or digits gets a generated tmux name), and no auto-naming; `dir` must resolve inside one of the host's `spawnDirs`, hidden ones included (else 400; no `dir` = its first offered one); a prompt too long to type (the launch line over ~900 bytes) is written to `~/.claude/overmind-prompts/` and passed as `"$(cat <file>)"`; a first-run trust prompt is accepted (Claude: Down + Enter; Codex: Enter on "Trust and continue"); when the agent never starts (the pane is still just a shell after ~10s) the tmux session is killed and the answer is 502 with the pane's last lines. `ghIdentity` (Claude only; one of the host's `ghIdentities`, else 400): the session acts on GitHub as that [GitHub identity](cli.md#github-identities) — its launcher comes from `overmind --local gh-identity launcher`, and the pane gets `@overmind_gh_identity`. `prs/spawn`, `tasks/spawn` and the stack spawns take it too. `embed` (`[A-Za-z0-9_-]{1,40}`): the app whose [embedded panel](#embed-view) starts it — the pane gets `@overmind_embed`, `list` reports it as `embed`. `slack` (`{ url, minutes, mode?, task? }`, as `/api/slack/link`; on any host whose server reaches `slack.host`, else 400 before anything opens): the session starts with no prompt, is linked as soon as it registers (≤ ~45 s), and `prompt` (max 4000 chars) ends the link's intro as the owner's first request — or, with `slack.from` (a Slack user id: whose mention started it, `slack.spawn`), as that person's, a colleague's unless it is the owner; `dir` may start with `~/` (this host's home); the answer carries the Link as `slack`. A link that fails after the spawn: 502 (400 for a link the bridge refuses), the session stays idle, its prompt unsent |
| GET | `/api/hosts/:host/harnesses[?refresh=1]` | `{ host, harnesses: [{ id, label, command, installed, problem, models: [{ id, label, efforts? }], efforts, defaultModel, defaultEffort }], ghIdentities: [{ name, login }] }` — `overmind --local harness list --json`, cached 10 min (the defaults always fresh from the config); Claude's `models` are `web.models` when set, else the CLI's. An older CLI answers Claude alone; one without `efforts` gets a fixed list |
| PUT | `/api/hosts/:host/harness-defaults` | `{ harness, model, effort }` → the same, with `host`: the default model / effort a spawn of `harness` uses on that host (`harnesses.<id>.model` / `.effort`, written through `overmind --local config set`, live at once). `null` or `""` clears one. Settings → Models sends it to every host. It drops the cached `harnesses` rows, so the next read carries Default's levels for the new default model |
| GET | `/api/hosts/:host/usage[?refresh=1]` | that host's Claude subscription limits: `overmind usage --json` + `host` (see [Subscription usage](#subscription-usage)); 502 with the CLI's reason (no login, endpoint down with nothing cached) |
| POST | `/api/hosts/:host/prs/checkout` | `{ pr: "owner/repo#123" }` → `{ host, worktree }`: `overmind pr checkout --json` on that host |
| POST | `/api/hosts/:host/prs/seen` | `{ pr: "owner/repo#123" }` → `{ host, pr, seenAt }`: `overmind pr seen --json` on that host — its @mentions of you so far are seen |
| POST | `/api/hosts/:host/prs/spawn` | `{ pr, prompt?, name?, model?, effort?, harness? }` → `{ host, worktree, spawn }`: the checkout, then a new session in the worktree whose first prompt is `worktree.contextLine` + `prompt` (like a stack sibling: the web spawner, not `overmind pr spawn`). Starts an agent |
| GET | `/api/hosts/:host/prs[?refresh=1]` | the GitHub PRs that need you, as `gh` on that host sees them: `overmind prs --json` + `host` (see [cli.md](cli.md#pull-requests)), and `local.editorUrl` ("Open in VS Code / Cursor" for the worktree, like a session's `editorUrl`); 502 with the CLI's reason (no `gh`, not logged in, GitHub down with nothing cached), 501 when that host's CLI predates `overmind prs` |
| GET | `/api/hosts/:host/tasks[?refresh=1]` | your open Productive tasks, as that host's token sees them: `overmind tasks --json` + `host` (see [cli.md](cli.md#productive-tasks)); 502 with the CLI's reason (no token, several organizations and none configured, Productive down with nothing cached), 501 when that host's CLI predates `overmind tasks` |
| POST | `/api/hosts/:host/tasks/status` | `{ task, status }` → `{ host, task }`: `overmind task status --json` on that host — moves the task (for everyone) |
| POST | `/api/hosts/:host/tasks/spawn` | `{ task, dir, prompt?, name?, model?, effort?, harness? }` → `{ host, task, spawn }`: a new session in `dir` (validated like `/spawn`) whose first prompt is the task's `contextLine` (`overmind task show --json`) + `prompt`. Starts an agent |
| GET/POST | `/api/hosts/:host/focus` | that host's `focus status`: `{ host, active, remainingMs, endsAt, apps, stale }`; POST `{ on, minutes? }` runs `focus start [minutes]` / `focus stop` (a no-op when already so) and answers the new status. 501 when that host has no `focus` CLI, 502 with its message when it fails |
| GET | `/api/hosts/:host/spawn-dirs` | that host's stored `spawnDirs` (canonical `{ label, paths, hidden? }`, `hidden` only when true, keys it does not know kept), whether each of its own paths is a directory there, what it offers now (`offered`) and its hidden dirs now (`hiddenSpawnDirs: [{ label, path }]`) |
| PUT | `/api/hosts/:host/spawn-dirs` | `{ spawnDirs, dryRun? }` → validated on that host (its own paths must exist; `hidden` must be a boolean, stored only when true; other keys on an entry are kept), written with `overmind --local config set spawnDirs`, used at once (no restart); 400 with per-entry `errors`. As powerful as spawn (it widens the spawn allow-list); no auth, like spawn |
| GET/PUT | `/api/hosts/:host/repos` | Settings → Git repos: that host's `repos` settings, every repo (`overmind --local repos --json --all`) and its sync timer; PUT writes `repos` with `overmind --local config set` |
| GET | `/api/hosts/:host/jobs` | `{ host, jobs }`: that host's [bots](cli.md#bots) (the API keeps their old name, jobs), `overmind --local jobs --json` (each with its latest run and live sessions, see [cli.md](cli.md#bots)); a prompt file also gets `prompt.abs` — `~` expanded on that host — `prompt.root` — its git checkout, else its directory — and editor links built like the notes': `prompt.editorUrl` opens the file (at line 1, so a remote path opens as a file), `prompt.rootEditorUrl` its root; null without an editor or ssh alias); 501 when that host's CLI predates `overmind jobs` |
| GET | `/api/hosts/:host/jobs/:name` | one job with every kept run, newest first, each run's sessions with `parent`: `overmind --local jobs show <name> --json` + `host`; 404 no such job. Names: `[A-Za-z0-9_-]{1,40}` (else 400) |
| POST | `/api/hosts/:host/jobs/:name/run` | `{ force? }` → `{ host, name, output }`: `overmind --local jobs run [--force] <name>`. Starts an agent (spawn's trust level); 409 `{ error, busy: true }` while a session of the job is working, unless `force` |
| POST | `/api/hosts/:host/jobs/:name/enabled` | `{ enabled: boolean }` → `{ host, name, enabled, output, job }`: `overmind --local jobs enable\|disable <name>`, then the job as `show` reports it |
| GET | `/api/hosts/:host/schedule` | `{ host, entries }`: `overmind --local schedule --json` — pending and recent scheduled sessions ([CLI](cli.md#scheduled-sessions)) |
| POST | `/api/hosts/:host/schedule` | `{ at \| task (+ time), dir, prompt?, name?, model?, effort?, harness?, ghIdentity? }` → `{ host, entry }`: `overmind --local schedule add`. `dir` must be in the host's spawn dirs, like a spawn; starts an agent later |
| POST | `/api/hosts/:host/schedule/:id/cancel` | → `{ host, id, output }`: `overmind --local schedule cancel <id>` |
| POST | `/api/hosts/:host/repos/sync` · `/repos/service` | `{ names? }` → `overmind --local repos sync --json` (409 while one runs); `{ install }` → `overmind --local repos install-service [--uninstall]` |
| POST | `/api/hosts/:host/sessions/:id/sleep` | `{}` → `overmind --local sleep <id> --json` (ends it, keeps it dormant), then closes its iTerm tab if it had one |
| POST | `/api/hosts/:host/sessions/:id/kill` | `{}` → a busy or waiting Codex row first gets Esc (its turn ends with `turn_aborted`; waits ≤ 5 s for the row to read idle), then — for that busy or waiting row, embedded mode only — the tool processes of its current turn are TERMed (only `<shell> -c <a command the turn asked for>` — or that command itself, exec'd by the shell — children of the row's own TUI, started no earlier than that call, in its cwd, each re-checked to be the same process right before — see web/ARCHITECTURE.md; `tools: { pids, result }` in the answer; in daemon mode nothing is signalled — the daemon serves every pane, and Codex ends a closed thread's commands ~60 s after its TUI goes; an idle row's commands, a dev server it was asked to start, are left running), then SIGTERM (then SIGKILL) the agent, then KILL the tool processes still running after 4 s (each re-checked to be the same process), then kill its tmux session (or just its window when the session has others) / close its iTerm tab |
| GET | `/api/groups` | the Board view's groups: `{ enabled, host, intervalMinutes, running, updatedAt, lastRun, groups: [{ id, label, description, source, members: [{ host, id, dormant? }] }] }` (`dormant: true` only on a member that is dormant on its host; never set from stored groups, so the UI also cross-references `GET …/dormant`); served by the grouping host, proxied by every other server (`enabled: false` when nobody runs it) |
| GET | `/api/inbox` | the [inbox](#inbox): `{ enabled, host, error?, updatedAt, brief: { text, at, model } \| null, sources: { github?, productive?, sessions?, comms? : { at, ok, error, count, nextAt?, running? } }, items: [{ id, source, kind, section, title, ask, url, href, from, at, firstSeen, effort, meta }] }` — served by `inbox.host`, proxied by every other server (`enabled: false` when none is set) |
| GET | `/api/slack` | [Slack links](#slack-links): `{ enabled, host, error?, socket: { connected, error }, bot: { userId, team, url }, owner, links: [Link], ended: [Link], bridges? }` (with `slack.bridges`: `links` / `ended` of every bridge, `bridges: [{ host, enabled, error?, socket, bot }]`; `host`, `socket`, `bot` stay `slack.host`'s) — Link = `{ id, host, session, sessionName, channel, threadTs \| null, permalink, task, mode, createdAt, until \| null, minutes \| null, pending, delivered, replies, endedAt, endReason, startedBy, blocked }` (`blocked`: `{ at, what }` while its session waits on the owner and the thread was told, else null; `until: null`: no end, it lasts until unlinked; `minutes`: the duration it was linked for, null = no end; `startedBy`: `{ user, name, owner }` when a mention started its session, else null); `spawn`: this bridge's `slack.spawn` (`{ host, dir, model, harness, ghIdentity, mode, task, minutes, from }`, `host` resolved) when it opens sessions on a mention, else null; `bot.name`: the app's bot user name; with `slack.bridges` each of `bridges` carries its own `spawn`; served by `slack.host`, proxied by the others (`enabled: false` when none is set) |
| POST | `/api/slack/link` | `{ host, session \| pane \| tmuxSession, url \| user, minutes (1–10080, or like `2h`, `2d`, `1w`, or `forever`: no end), task?, mode?: mention \| proactive, first? }` (`user`, or a `url` that is not `http…`: a person — `@name` / name / `U…` — and the link is the app's DM with them; the Link then has `dm: { user, name }`) → Link (`renewed: true` when that session already followed that thread). 400: a bad link or duration, a session on another host, a conversation the app cannot see; 404: no such session |
| PUT | `/api/slack/spawn` | `{ bridge? (default `slack.host`), spawn: { host?, dir?, model?, harness?, ghIdentity?, minutes?, mode?, task?, from? } \| null }` → that bridge's `/api/slack` status: sets its `slack.spawn` (`overmind config set`, only the fields given) and applies it at once, no restart; `null` turns it off (Settings → Slack). Served by the bridge, proxied there once. 400: a bad duration / mode / `from`, a `host` that is neither the bridge nor a peer; 404: an unknown bridge |
| POST | `/api/slack/links/:id/unlink` | end the link now → Link |
| POST | `/api/slack/links/:id/relink` | `{ minutes? }` → Link: link that link's session to the same thread / conversation / DM again, with the same instructions and mode (an ended link, from `ended`; an active one is renewed). No `minutes` = the duration it had. 404: no such link or the session is gone |
| POST | `/api/slack/reply` | `{ link, text, thread?, pane? \| session? }` → `{ ok, link, channel, ts, threadTs, permalink }`: post in the linked thread (`ts`: the new message's own; `permalink`: null when Slack would not give one). 403: `pane`/`session` is not the linked session; 410: the link has ended |
| POST | `/api/slack/history` | `{ link, cursor?, limit? (1–200, 50), oldest?, latest?, pane? \| session? }` → `{ link, channel, threadTs, order: "newest first" \| "oldest first", messages: [Message], nextCursor \| null }`: the linked conversation (`conversations.history`; a thread link: `conversations.replies` of its thread). Message = `{ ts, threadTs, user, name, owner, you, session, bot, subtype, text (plain), replies, latestReply, files: [{ id, name, mimetype, size }] }`. `session`: the name of another session that posted it through the same app (then `you` is false), else null. 403 / 410 as `reply`; 429: Slack's rate limit |
| POST | `/api/slack/thread` | `{ link, ts, cursor?, limit?, pane? \| session? }` → the same shape, oldest first (Slack: the first message, then the latest replies; `nextCursor` pages back to earlier ones): one thread of the linked conversation (a thread link: its own only, else 403) |
| POST | `/api/slack/file` | `{ link, file, pane? \| session? }` → `{ link, id, name, mimetype, size, data (base64) }`: a file shared in the linked conversation (its `files.info` shares; a thread link: in its thread, else 403), at most 20 MB (413). Needs `files:read` |
| POST | `/api/inbox/refresh` | Scan now: start a Slack + mail scan (also outside work hours; its brief skips the `briefMinutes` wait) and re-read every other source; answers the GET shape |
| POST | `/api/inbox/dismiss` | `{ id }` → the item is done: off the list until its source drops it — a Slack / mail item, a session or a PR mention comes back on newer activity; answers the GET shape (404: no such item) |
| PUT | `/api/inbox/settings` | `{ scanMinutes?, workHours?, workDays? }` (15–1440 min; `[from, to)` hours; weekdays 0–6) → `overmind config set inbox.<key>` on the inbox host, live at once; answers the GET shape, whose `settings` carries the three |
| POST | `/api/groups/run` | `{}` → run the grouping pass now (on the grouping host) → the same shape; 501 when grouping is off |
| POST | `/api/groups/edit` | `{ op: "rename", id, label }` or `{ op: "move", host, session, to }` / `{ op: "move", host, session, label }` (a new group) / `{ op: "create", label }` / `{ op: "delete", id }` (empty groups) → `overmind group --rename/--move/--create/--delete` on the grouping host (proxied there) → the same shape; 400 bad body, 409 refused (unknown id, taken label), 501 when grouping is off |
| POST | `/api/hosts/:host/uploads?name=<file>` | raw file body → stored under that host's `web.uploads.dir` → `{ host, path, name, size }` (absolute `path`; 413 over `web.uploads.maxMB`); streamed through to a peer |
| POST | `/api/transcribe?hint=<words>` | raw audio body (webm / ogg / mp4 / mp3 / wav, ≤ 25 MB) → `{ text, model }` via OpenAI `gpt-4o-transcribe`; always this server, never proxied. `hint` (≤ 400 chars: session name, repo) steers spelling. Key: `$OPENAI_SPEECH_TO_TEXT_API_KEY`, else the macOS Keychain item of that name (never the config file). 501 without a key, 415 non-audio, 413 too large, 502 upstream errors (including a bad key), 429 rate limit |
| PUT | `/api/memos/recordings/:rec/segments/:n` | voice memos, always this server: one segment's raw audio (≤ 25 MB) is stored under `web.memos.audioDir`, then transcribed → `{ stored: true, transcribed, error? }` (a failed transcription keeps the audio; `finish` retries it). `:rec` is the client's recording id (`[a-z0-9-]`, 8–64), `:n` 0-based. 501 without a transcription key |
| POST | `/api/memos/recordings/:rec/finish` | `{ segments, startedAt, durationMs }` → transcribes what is missing, titles it (`claude -p`, else `Memo <date> <time>`), writes `web.memos.dir/<date>-<slug>.md` → the memo (below). Idempotent: again updates the same file. 409 a segment was never uploaded |
| GET | `/api/memos` | `{ dir, memos: [{ id, title, created, durationSec, status: done\|partial, words, preview }] }`, newest first (only files with a `recording` frontmatter key) |
| GET / PUT / DELETE | `/api/memos/:id` | one memo (`+ transcript, path`); PUT `{ title }` renames (the body is kept); DELETE removes the file and its audio |
| POST | `/api/memos/:id/retry` | transcribe the segments that failed and rewrite the memo |
| POST | `/api/speak` | `{ text }` (markdown is fine: code, tables, URLs and ids are dropped, at most ~4000 chars) → `audio/mpeg` via OpenAI `gpt-4o-mini-tts`; always this server. Key: `$OPENAI_TEXT_TO_SPEECH_API_KEY` (env, else Keychain), else the transcription key (which needs the audio scope). 400 nothing to say, 501 without a key, 502 upstream errors, 429 rate limit |
| GET/POST | `/api/operator` | the [voice operator](#voice-operator): `{ host, dir, session }` (`session`: its `overmind list` row, null when not running); POST finds it or starts it → `+ { started, tmuxSession }` (409 when a tmux session `operator` exists without it). Served by the first host of `web.operator.hosts` that answers (proxied with `?local=1`; an unreachable peer, or one without an operator, passes to the next); 503 when none does |
| POST | `/api/hosts/:host/autoname` | `{}` → run the naming pass on that host now → `{ renamed: [{ from, to }], tmux, held, errors }` |
| POST | `/api/hosts/:host/sessions/:id/files/stat` | `{ paths }` (≤ 200, as written in chat, `:line` allowed) → per path: resolved absolute path, `exists`, `isFile`, size, mtime, `kind` (markdown/text/image/pdf/other); the UI links only existing files |
| GET | `/api/hosts/:host/sessions/:id/files/raw?path=…[&download=1]` | the file itself, streamed (also through a peer); text/markdown over 5 MB only as a download |
| GET | `/api/hosts/:host/sessions/:id/complete?kind=skills\|files\|brain` | composer autocomplete, listed on the session's host (cached ~10 s): `skills` → `{ skills: [{ name, description, source: builtin\|user\|project\|plugin, argumentHint? }] }` (Claude Code's built-in commands, `~/.claude/skills` + `commands`, the cwd's and its ancestors' `.claude/skills` + `commands`, enabled plugins as `plugin:name`); `files` → `{ files, truncated }` (the `.md` / `.plain` files under the cwd: `git ls-files`, else a walk); `brain` → `{ available, notes: [{ ref, path, title? }] }` (the markdown under `brain_root:` in `~/.brainrc`; `ref` = file name, or path when two share it). 400 bad kind |
| POST | `/api/hosts/:host/sessions/:id/files/open` | `{ path }` → opens it with its default app **on that host** (`open` / `xdg-open`; runnable files are revealed in their folder instead) |
| POST | `/api/hosts/:host/sessions/:id/files/plain` | `{ path }` of a servable `.plain` file → `{ root, files: [abs], truncated }`: every PlainLang module of its git checkout (tracked + untracked, not ignored; else its directory's), at most 2000 — the UI looks a term up in the modules it imports / requires, then in the rest |
| GET | `/api/hosts/:host/sessions/:id/diff[?base=<ref>&since=<fingerprint>]` | the diff reviewer: the session's worktree (tracked edits + untracked files) against the merge-base of HEAD with `base` (default branch by default) → `{ host, id, root, branch, base: { ref, sha }, tree, fingerprint, unchanged, files: [{ path, oldPath, status, additions, deletions, hunks: [{ …, lines: [{ t, o, n, text }] }], plain? }], stats, truncated }` — a `.plain` (PlainLang) file also carries `plain: { old, new }`, its whole text at the base and now (null when absent or over 512 KB), for the reviewer's Spec view; with `since` equal to the current `fingerprint` → `unchanged: true` and no `files` (cheap polling). 409 outside git |
| GET | `/api/hosts/:host/sessions/:id/diffs[?since=<fingerprint>]` | the diff reviewer over **every checkout the session works in**: its cwd's, then the checkouts holding the files it worked on (tool inputs from its transcript, most recent first, at most 12, never `$HOME`) — a session in a meta repo editing several worktrees sees them all → `{ host, id, cwd, fingerprint, unchanged, repos: [{ root, label (relative to the cwd when inside it, else `~/…`), branch, head, base, tree, fingerprint, files, stats, truncated } \| { root, label, error }] }`; `since` = the combined fingerprint → `unchanged: true` without `repos` |
| GET | `/api/hosts/:host/sessions/:id/review` | the diff reviewer's comment threads → `{ host, id, threads: [{ id: "c-…", path, side: new\|old, start, end, code, status: draft\|sent, resolved, reviewId, entries: [{ body, sentAt, state: draft\|sent\|queued\|working\|done, replies: [{ text, ts, final }] }] }], reviews, drafts }`; every comment / reply was typed into the session with its marker `[review c-…]`, and the replies are read back from the transcript (the assistant messages after the marked prompt, up to the next prompt) and kept in `<state>/overmind/reviews/<session_id>.json` on the session's host |
| POST | `/api/hosts/:host/sessions/:id/review/threads` | `{ path, side, start, end, code: [lines], body, draft }` (+ `root`: the checkout, absolute — the prompt names the file relative to the session cwd, `display`) → a thread; `draft: false` types the comment (the lines quoted, fenced) into the session now, `draft: true` keeps it for submit → `{ …, thread }`. Types into the agent like `send` |
| POST | `/api/hosts/:host/sessions/:id/review/threads/:thread/reply` | `{ body }` → a follow-up typed into the session with the thread's marker; 409 on a draft |
| PUT / DELETE | `/api/hosts/:host/sessions/:id/review/threads/:thread` | `{ body?, resolved? }` (body: drafts only, else 409) / remove the thread from the review (what was sent stays in the conversation) |
| POST | `/api/hosts/:host/sessions/:id/review/submit` | `{ body? }` → every draft in one prompt (the overall note, then each comment with its marker and lines); 409 without drafts |
| POST | `/api/hosts/:host/sessions/:id/ask` | `{ question, root?, path?, side?, start?, end?, code? }` → `{ host, id, ask: { id: "q-…", status: running\|done\|error\|cancelled, question, label, text, activity, error, costUsd, forked, startedAt, endedAt } }`: a side question about lines of the diff, answered by `claude -p --resume <id> --fork-session --no-session-persistence` in the session's cwd with read-only tools (Read, Grep, Glob) — it knows the conversation, but nothing is typed into the session and no transcript is written. Kept in memory on the session's host only (30 min after it ends); at most 3 running per host (429). Claude sessions only (409) |
| GET / DELETE | `/api/hosts/:host/asks/:ask` | poll a side question (`text` grows while `status: running`; the final answer once `done`) / stop and forget it; 404 once forgotten |
| GET | `/api/hosts/:host/prs/:owner/:repo/:n/diff[?since=<fingerprint>&refetch=1]` | the diff reviewer over a PR **without a session or worktree**, from this host's clone (`local.repoPath` of `overmind prs`): `git fetch origin +refs/pull/<n>/head:refs/overmind/pr/<n>/head +refs/heads/<base>:refs/overmind/pr/<n>/base` (at most once a minute; `refetch=1` now), diffed from their merge-base — the checkout, index and branches stay untouched → `{ host, id: null, cwd, pr: { owner, repo, number, title, url, author, headBranch, baseBranch, headOid, draft }, fingerprint, unchanged, repos: [one checkout, as in …/diffs] }`; 404 when the PR is not in this host's list, 409 without a clone |
| GET / POST | `/api/hosts/:host/prs/:owner/:repo/:n/notes` | review notes on the PR, kept in Overmind (`<state>/overmind/pr-notes/<owner>__<repo>__<n>.json`) in the thread shape of …/review (`status: draft`, one entry, `posted: { url, at } \| null`) → `{ host, pr, threads, reviews: [], drafts }` (drafts: not on GitHub); POST `{ path, side, start, end, code, root?, base?, body }` → `{ …, thread }` |
| PUT / DELETE | `/api/hosts/:host/prs/:owner/:repo/:n/notes/:note` | `{ body?, resolved? }` (body: 409 once posted) / remove it (GitHub keeps a posted comment) |
| POST | `/api/hosts/:host/prs/:owner/:repo/:n/notes/:note/post` | `{ headOid }` → the note as a GitHub review comment on its lines (`gh api …/pulls/<n>/comments`, RIGHT = new side, LEFT = old; a range sets `start_line`), as this host's `gh` login; 502 with GitHub's reason when refused |
| POST | `/api/hosts/:host/prs/:owner/:repo/:n/notes/handoff` | `{ summary? }` → like `prs/spawn`: the PR's worktree (made when missing) and a session there whose first prompt is the PR's context line + every unresolved note with its lines; 409 without notes |
| POST | `/api/hosts/:host/prs/:owner/:repo/:n/ask` | `{ question, path?, side?, start?, end?, code?, head?, base? }` → a side question (as …/ask) in a fresh `claude -p` in the clone (no session to fork), told the PR and to read its files with `git show <head>:<path>`; read-only tools plus `git show / diff / log / blame` |
| GET / POST | `/api/hosts/:host/sessions/:id/queue` | the prompt queue → `{ host, id, items: [{ id: "q-…", text, createdAt }], paused, held }` / `{ text }` → adds one (`{ …, item }`; 409 past 20). Queued prompts go in one per run, only once the session is `idle` and its `updated_at` has moved past the last delivery (never while `waiting`); kept in `<state>/overmind/prompt-queue.json` on the session's host. The `messages` response carries the same `queue` (null when empty) |
| POST | `/api/hosts/:host/sessions/:id/queue/pause` | `{ paused }`: a pause holds the queue for the run under way; when that run ends it clears itself and the queue is `held` until the next run ends. `paused: false` resumes at once (the next idle sends) |
| PUT / DELETE | `/api/hosts/:host/sessions/:id/queue/:item` | `{ text }` edit / remove one |
| POST | `/api/hosts/:host/sessions/:id/queue/:item/send` · `…/:item/move` | type it in now, whatever the session is doing / `{ to }` new index |
| GET | `/api/hosts/:host/sessions/:id/brief` | the session's [brief](#session-briefs): `{ host, id, exists, markdown, parsed: { summary, resources, todos, plan }, updated, editedAt, generatedAt, generatedThrough, generating, enabled, continuePrompt, absCwd, gitRoot, worktrees, editor, editorUrl }` — an empty skeleton (`exists: false`) before there is one; a gone session's brief is still served by its full id. `parsed.plan` is a **deprecated** alias of `parsed.todos` (the section was called Plan), kept for one release |
| GET | `/api/hosts/:host/notes/{tree,search,file,raw}` | the notes explorer (`web.notes`): the file list, `?q=` search with snippets + match ranges, `?path=` one note (frontmatter split, encrypted blocks withheld), `?path=` an image; 501 when the host has no `web.notes.root` |
| PUT | `/api/hosts/:host/sessions/:id/brief` | `{ markdown }` → a human edit (sets `editedAt`) → the same shape |
| GET | `/api/hosts/:host/stacks` | `overmind --local stack list --json` → `{ host, stacks: [StackView + editorUrl] }` ([session stacks](#session-stacks); `editorUrl` for `absCwd`, built like briefs' via `lib/editor.mjs`) |
| GET | `/api/hosts/:host/stacks/:id` | `overmind --local stack show <id> --json` → StackView (+ `editorUrl`); 404 when unknown |
| PUT | `/api/hosts/:host/stacks/:id` | `{ markdown, expectUpdated? }` → `overmind --local stack set <id> [--expect-updated] --json` (markdown on stdin) → StackView; **409** `{ error, updated }` on conflict; 400 bad body (markdown a string ≤ 64 kB) |
| POST | `/api/hosts/:host/stacks/:id/rename` | `{ label }` (one line, 1–80 chars) → `overmind --local stack rename <id> <label> --json` → StackView; 400 bad label; 404 unknown |
| DELETE | `/api/hosts/:host/stacks/:id` | `overmind --local stack rm <id> -f --json` → `{ removed }` |
| POST | `/api/hosts/:host/stacks/:id/spawn` | `{ prompt?, name?, model?, effort?, harness?, dir?, host? }` → a sibling in that stack: `dir` defaults to the stack's `absCwd`; otherwise as the session route below, without `ensure` |
| POST | `/api/hosts/:host/sessions/:id/stack/spawn` | `{ prompt?, name?, model?, effort?, harness?, dir?, host? }` → (1) `overmind --local stack ensure <session_id> --json` (timeout 150 s: it may call the model); (2) the server's own spawner (tmux, trust prompt handled) in the session's cwd (or `dir`, inside the session's cwd or a spawn dir) with `prompt` = `contextLine + ' ' + prompt`; (3) in the background, find the new session (by tmux session name, ≤ ~75 s) and `overmind --local stack add <stack id> <session_id> --json` → 200 `{ host, stack: StackView, created, generated, spawn: { name, dir, tmuxSession, command, trusted, model } }`. With `host` (a peer of `:host`, the stack's home): `dir` is required (a path there), the peer's `/spawn` starts it with `remoteContextLine + ' ' + prompt`, the join watches the peer's list and runs `stack add … --on <host> --input -` here; `spawn.host` names the peer |
| POST | `/api/hosts/:host/stacks/:id/add` | `{ session, host? }` (a full session id; `host`: the peer it runs on, default `:host`) → put an existing live session in that stack after the fact: its row from that host's list, then `overmind --local stack add <id> <session> [--on <host> --input -] --json` → `{ host, stack: StackView, created: false, generated: false }`. Already a member → the stack unchanged; 404 not live there; **409** already in another stack; 400 bad body or a host that is not a peer with a web url |
| POST | `/api/hosts/:host/sessions/:id/stack/link` | `{ session, host?, label? }` → link two existing sessions: `overmind --local stack ensure <session_id>` (the session's stack — created when it has none, timeout 150 s: it may call the model), then adds `session` as `…/stacks/:id/add` does → `{ host, stack, created, generated }`; 400 linking a session to itself |
| POST | `/api/hosts/:host/stacks/sync` | `overmind --local stack sync --input - --json` with the merged `/api/overmind` body on stdin (plain `sync` when it cannot be built) → `{ host, changed, stacks }` |
| GET | `/api/hosts/:host/dormant` | [session recovery](#session-recovery): `overmind --local restore --json` → `{ host, bootId, dormant: [DormantView], closed: [ClosedView] }` (`closed`: [recently closed](#recently-closed), from CLIs that know it); 501 when this host's CLI has no `restore` |
| POST | `/api/hosts/:host/dormant/restore` | `{ target, dryRun? }` (a dormant tmux name or session id, one line ≤ 200 chars) or `{ all: true, dryRun? }` → `overmind --local restore [--dry-run] (-- <target> \| --all) --json` → `{ host, restored, failed }`. Starts agents, like spawn: **409** `{ error, candidates }` when the target is ambiguous (exit 2), 404 no match (exit 3), 502 `{ error, restored: [], failed }` when nothing came back; a partial `--all` is 200 with `failed` filled. The overmind list (and a stack sync) refresh as the sessions register. Proxy timeout 6 min |
| POST | `/api/hosts/:host/dormant/forget` | `{ target }` or `{ all: true }` → `overmind --local restore (--forget=<target> \| --forget-all) --json` → `{ host, forgotten }`; 409 / 404 as restore |
| | | Both POSTs take `closed: true` for a [recently closed](#recently-closed) entry (→ `--closed`); `{ all: true, closed: true }` is a 400 on restore (closed ones are resumed one at a time), allowed on forget. A CLI without `--closed` → 501 |
| POST | `/api/hosts/:host/sessions/:id/brief/regenerate` | `{}` → **202** `{ host, id, started, queued, generating: true }`, the model call runs in the background (poll GET); **429** `{ error, retryAfterMs }` at the hourly cap |

`:host` is `self` or a configured peer; `:id` is a session id or a unique prefix (≥ 8 chars) — on
the `/stacks/:id` routes a stack id (or anything `overmind stack` resolves). The
full contract (status codes, limits, timeouts) lives with the server: [web/README.md](../web/README.md),
[web/ARCHITECTURE.md](../web/ARCHITECTURE.md).

## Embed view

`#/embed?host=<host>&dir=<dir>[&theme=dark|light][&app=<name>]` is Overmind's session chat for one directory,
made for another app to frame (an `<iframe>` panel: Fin's assistant, later Brain) instead of
each app writing its own chat UI. It is a separate tree in the web UI (`screens/EmbedScreen.tsx`,
`lib/embed.ts`): no sidebar, no Overmind navigation, no scratchpad, stacks or diff reviewer.

- **List**: the live sessions on `host` whose cwd is `dir` or beneath it (worktrees inside the
  repo), latest first, and **New session**: the New session form with host and directory fixed
  (agent, model, first prompt, attachments, voice as usual) → `POST /api/hosts/:host/spawn`.
- **Session**: the mobile session screen (`#/s/:host/:id`, chat / terminal, composer, AskUserQuestion
  answers, attachments, voice, the details drawer with Close) with Back to the list. Sessions on
  other hosts are not opened.
- **`dir`**: absolute or `~/…` (expanded with the host's `home`, now part of each `/api/overmind`
  host; an older server matches a spawn dir with the same tail). It must be one of that host's
  `spawnDirs` (offered or `hiddenSpawnDirs`) or beneath one, else the view shows an error and offers no spawn — the same rule
  the server applies to `/spawn`.
- **`app`**: the framing app's label (`[A-Za-z0-9_-]{1,40}`, default the dir's last folder).
  Sessions spawned from the view carry it (`embed` on their `list` row): Overmind's own list sets
  them aside like bot sessions — out of every status filter but **Apps** (and their app chip on
  rows / cards), except while one waits on you. A session restored after a reboot loses it.
- **`theme`**: the framing app's mode; without it the OS preference. It never changes the
  viewer's Overmind theme setting.
- **URL form**: the hash router moves a route's query into the page's query string, so the
  canonical URL is `https://<overmind>/?host=…&dir=…[&theme=…]#/embed` (`#/embed?…` works and is
  rewritten to it). The query stays while the frame moves to `#/s/…`, which is how a reload
  inside the frame stays in the embed view. Every move inside the view replaces the history
  entry, so the framing page's Back button stays its own.
- **Framing**: the server sends no `X-Frame-Options` / `frame-ancestors`, so any page that can
  reach it can frame it — like the rest of the API it relies on a private network (no auth).
  The frame talks to its own origin only (same-origin API calls; no cookies), so nothing
  cross-origin is needed. Voice needs the frame to allow it: `allow="microphone"`. There is no
  `postMessage` contract.
- **Desktop shell**: a profile app frames it only with the Overmind origin in its
  `frameOrigins` ([desktop.md](desktop.md#other-apps-profiles)).

## Voice operator

`#/operator` (web UI): talk to the overmind. The operator is a Claude session the web server starts
on request (POST `/api/operator`) in tmux session `operator`, in its own workspace
`${XDG_STATE_HOME:-~/.local/state}/overmind/operator/` — regenerated at every server start:

- `CLAUDE.md` — its brief: a dispatcher that answers by voice (short spoken sentences, the
  user's language), always looks before it answers, and acts only on an unambiguous target;
  closing or interrupting needs an explicit yes. Your own additions go in `CLAUDE.local.md`.
- `.claude/settings.json` — allows `overmind`, `./api`, `jq` and `date` without permission prompts
  (a prompt would stall a voice conversation); extend it in `.claude/settings.local.json`.
- `api` — `./api METHOD /path [JSON]`: this server's HTTP API (which reaches every host).

The screen records with `POST /api/transcribe`, sends the text with the ordinary `send` route,
polls `messages`, and reads each new final reply aloud with `POST /api/speak` — or, without a
speech key (or after it fails), the device's own voice (Web Speech API). A reply is read as soon
as its final message is in the transcript (Claude writes a message only once it is complete), not
when the status turns idle, and it is voiced in pieces (`speechChunks`): a short first piece of one
or two sentences, then pieces of up to ~500 characters, all requested at once and played in
order — the voice starts in about a second instead of after the whole reply is synthesized
(roughly 1 s per 90 characters). The brief points the operator at `./api GET /overmind` (the server's
snapshot of every host, instant; an unreachable host is `ok: false`) rather than
`overmind list --all-hosts` (ssh to each host, which waits out the connect timeout on a machine that
is asleep, and sees only hosts with an ssh destination), gives one-command recipes for the common
questions, and keeps replies under ~400 characters. Measurements, and what running it on Codex or pi would take:
[operator.md](operator.md). Sessions that start
waiting on you are announced while the screen is open (from the overmind poll, no model call).
The operator is found by its cwd. Its row in `/api/overmind` carries `operator: true` and the UI
keeps it out of session lists (the CLI still shows it). `web.operator.hosts` picks one operator
for every device: each server sends `/api/operator` to the first host of the list that answers.

**Auto-clear**: every 5 minutes the server checks its operator; idle for `clearIdleMinutes`, it
gets `/clear`. Claude Code then starts a new session (a new session id, an empty transcript), so
the next conversation starts fresh and the app shows no history. A cleared session has no context
until it is used, which keeps it from being cleared again.

## Voice memos

`#/memos` (and the red record button on the phone's session list) records a conversation and
saves it as a titled transcript (`web.memos`). One recorder serves the whole app, so recording
continues while you look at other screens. The mic is cut into 5-minute segments — a fresh
`MediaRecorder` on the same stream, so each is a file the transcriber takes on its own — and every
finished segment is uploaded and transcribed while recording goes on; stopping only waits for the
last one, then `finish` titles and writes the memo. There is no length limit.

Nothing is lost on the way: audio chunks (5 s) go to IndexedDB as they are recorded and are
dropped only once the server has stored the segment. A failed upload is retried with backoff,
when the network comes back and when the app is shown again; a recording whose tab died (no
heartbeat for 30 s) is stopped where it ended and saved by the next app start. The screen is
kept awake while recording (Wake Lock) — a phone that locks or backgrounds the app may end the
mic, and what was recorded is saved.

## Smart grouping

The web Board view shows sessions as columns of work streams, and nobody maintains those groups:
`core::grouping` (the `overmind group` verb) does, with one source of truth for the whole overmind.

- **Where it runs.** One host: `grouping.host`, or — without it — the host whose server has
  `web.grouping.enabled`. That server runs `overmind group --input - --apply --json` every
  `web.grouping.intervalMinutes` (default 10, first run 20s after start) with its merged
  `/api/overmind` body on stdin — so it needs no ssh to its peers, only their web servers — and early
  (≥ 2 min after the last run) when the warm snapshot shows live sessions no group knows. Every
  other server proxies `/api/groups` to it (and finds it by asking peers when `grouping.host` is
  unset). The state lives on that host (`~/.local/state/overmind/groups.json`).
- **Input per session**: display name (generated title, else name), name, the last two cwd
  segments (worktree paths carry the branch-ish name; the git branch itself is not read — a
  remote session's branch isn't cheaply known), host, the first prompt's first 160 characters.
  Prompts are capped at 12k characters per call; overflow goes to another call, at most 4 per run.
- **Stability.** Assignments persist per `host/sessionId` with a fingerprint of those inputs; an
  unchanged session is never re-sent. New or changed sessions are classified into the existing
  groups (the model sees their labels and a few member names and is told never to rename them) or
  a new group; a new label equal to an existing one reuses that group. Consolidation — merge
  clearly identical streams, fix a clearly wrong label — runs at most hourly, only after changes,
  and is capped at 2 merges + 2 renames per pass. Group ids never change; empty groups vanish;
  sessions of a host that didn't answer keep their group.
- **Dormant sessions** (left by a reboot, see [Session recovery](#session-recovery)) count as
  present: they keep their assignment (and so their group), are never sent to the model, and come
  back with `"dormant": true` on their member object in a pass's report (`overmind group --json`, and
  so `/api/groups`; absent otherwise, never set by `--cached`). The pass reads this machine's
  snapshot and, for each other answering host, `overmind -H <host> restore --json` — in parallel with
  the session fetch. A host whose dormant list can't be read is treated like a host that didn't
  answer: none of its assignments are pruned that run (an overmind too old to have `restore` has none).
- **Hand edits win.** Renaming a group on the Board locks its label (never renamed, never merged
  away); a session dragged to another group is a `manual` assignment the passes never touch.
  A group made on the Board (`manual`) stays even when empty, until the user deletes it.
  Column order is the UI's (`overmind.boardOrder`, per browser), not part of the state.
- **Fallback.** Model disabled, missing, logged out, or answering garbage (one retry on an
  unparseable answer, none on a failed call): group by repository, marked `fallback`, reclassified
  once the model is back. The UI does the same grouping client-side when no server runs grouping.
- **Cost.** A run with nothing new makes no model call; a typical run after one new session makes
  one (haiku, ~2–8k prompt characters, 10–45s wall clock with `claude -p` start-up).

## Inbox

One live to-do list for the whole day, kept by the system: every item links to the thing that
waits on you, and drops off by itself once its source says it is done — or at once when you mark
it Done (dismissals are kept in the state file; the scan is told which messages are done)
(`web/lib/inbox.mjs`, the `#/inbox` screen). One host's server runs it (`inbox.host`, best the
always-on one); the others proxy `/api/inbox` there.

| Source | How | Model |
|---|---|---|
| `github` | `overmind --local prs --json` every 2 min: review requests, unseen @mentions, your PRs approved / with changes requested / with failing CI | none |
| `productive` | `overmind --local tasks --json`: overdue and due-soon tasks, tasks in progress touched in the last 3 days | none |
| `sessions` | the merged overmind: sessions on any host with status `waiting` (link `#/s/<host>/<id>`) | none |
| `comms` | Slack + Gmail through the claude.ai connectors: one `claude -p --output-format json` with only read-only connector tools allowed (writes and built-ins denied), every `scanMinutes` within work hours. It looks back to the previous scan minus 2 h (3 days the first time) and is handed the items it returned last time, so their ids stay and answered threads drop off | `model` |

Sections: `quick` (quick wins — a review of ≤ 150 changed lines in ≤ 6 files, an approved PR to
merge, a waiting session, a message the scan rated `quick`), `waiting` (on you: other reviews,
mentions, changes requested, failing CI, overdue tasks, other messages), `mine` (your work: due
tasks, recent tasks in progress). Items are sorted by section, then newest first.

The **brief** (3–8 bullets in `language`) is one `claude -p` over the numbered item list; it links
what it names as `[name](#<n>)`, which the server turns into the item's url (else its in-app
href) — no URL comes from the model. It runs only when the
set of items changed, at least `briefMinutes` apart, and outside work hours only the first of the
day. A failing source keeps its last list and reports the error; a failed scan waits for the next
slot. State (`<overmind state>/inbox.json`): the scan's items and time, the brief, when each item was
first seen (the UI's "new" dot).

## Slack links

A session, for a while, talks with the people in one Slack thread / channel / DM (`web/lib/slack.mjs`,
[CLI](cli.md#slack-links), Details → Slack in the web UI). One host's server runs the bridge
(`slack.host`, best the always-on one); the others proxy `/api/slack` there. A host with its own
Slack app runs its own bridge: `slack.bridges.<host> = <host>` on the other servers sends a link or
reply for that host's sessions there (a bridge refuses one proxied to it for a host it does not
serve, so a session is never linked by two apps); unlink / relink go to the bridge that has the
link, and the status lists every bridge's links. Sessions on any host
can be linked: the bridge lists a link's host's sessions (`GET /api/overmind?local=1` on that peer)
and types into them through it (`POST …/sessions/:id/send`); a proxied reply carries the proxying
server's name as `host`, and the reply's pane is checked on that host.

- **Slack App, Socket Mode.** The bridge opens a WebSocket to Slack (`apps.connections.open` with
  the app-level token `SLACK_APP_TOKEN`, `xapp-…`, scope `connections:write`), acks every envelope
  and reconnects when Slack asks. No public URL, so it works behind Tailscale. The Web API calls use
  the bot token `SLACK_BOT_TOKEN` (`xoxb-…`; scopes `channels:history`, `groups:history`,
  `im:history`, `mpim:history`, `chat:write`, `chat:write.customize` (a session posts as "<app> (<session>)"; without it Slack shows the app's name), `reactions:write`, `users:read`, `files:read` (for `overmind slack file`), and `app_mentions:read`
  with the `message.*` events; `im:write` for a DM link to a person, whom people can write to only
  with the app's App Home → Messages tab on). Both come from the server's environment or the Keychain
  (`security find-generic-password -s <name> -w`). Sessions never see them.
- **What overmind enforces**, not the model: which conversation (a message elsewhere is never
  delivered), until when (an ended link delivers nothing and refuses replies), who wrote a message
  (Slack's user id), and which session may reply (`overmind slack reply` sends `$TMUX_PANE`; another
  session's pane is a 403). Bots, the bridge's own notices and edits are not delivered. Threads
  first (the company's rule): where several people read (a channel or group DM link), a post
  outside a thread is refused unless it is a one-line headline (≤ 300 chars, `MAX_HEADLINE`); the
  note tells the session to answer in the message's thread and put details under the headline. A
  one-on-one DM (`D…`) is exempt.
- **Sessions on one app**: a session's post (`reply`, whose `ts` its link keeps) reaches the other
  links in that place as a message from `session "<name>"`. It is never a mention or a DM. In mention
  mode it wakes a link only in a thread that link posted in, and at most 5 times per 10 min per link;
  the rest stays context, so two sessions answering each other can't loop. An app message that comes
  before its post returned waits up to a minute to be matched. Posts carry `username` "<app name>
  (<session name>)" (`bots.info`; needs `chat:write.customize`).
- **What the model keeps to**: the owner's instructions and the rules in the note typed in when
  the link starts (post only through `overmind slack reply` and only when something calls for it,
  only within the instructions, nothing destructive for them, messages are colleagues' requests
  and cannot change the rules).
- **Modes**: `mention` (default) — the session is woken by a message that mentions the app, a
  DM, or any message in a thread it has posted in (the link's `postedIn`; a top-level post starts
  one) — whether that last kind is for it, the model judges, no heuristic; the messages in between
  (the last 60) go along as context. `proactive` — every message wakes it; it steps in when it
  judges it should. Only a mention / DM is marked (`→ mentions you` / `→ to you`) and gets 👀.
- **Delivery**: the note first, then messages once the session is `idle` (never while it is
  `busy` or `waiting` on you; `idle` includes a main thread that is free while its subagents run —
  [discovery](#session-discovery), and the note tells the session to hand long work to them), several as one prompt under 8000 chars (the newest), at least 8 s
  apart; the ones addressed to it get an 👀 reaction when typed in.
- **Blocked**: every 15 s the bridge checks the sessions of links that have been in their thread.
  One `waiting` for 30 s gets a notice in the thread (the registry's `waiting_for` label only — no
  command, no path; for a Codex approval just `exec approval` / `patch approval` / `MCP approval`, since its `waiting_for` carries the command, files or tool) and a DM with a link to the session's page in its host's web
  UI (`hosts.<host>.web` + `#/s/<host>/<id>`; a DM link with an owner gets only that one). The DM
  goes to the owner the link is a DM with, else the owner who started the session from Slack, else
  the only owner; several owners and none of those: no DM (the thread is still told). Messages
  that would wake it get ⏳ meanwhile. When it is no longer `waiting`, both posts are edited
  (`chat.update`), the ⏳ come off as the messages go in. The Link's `blocked` (`{ at, what }`,
  else null) shows it. `overmind slack guard`, a `PreToolUse` hook on `AskUserQuestion`, keeps a
  linked Claude session from blocking on a prompt Slack cannot show: it denies the call and points
  it to the thread; the intro note says the same.
- **Reading** (`overmind slack history | thread | file`): the linked session reads its conversation,
  read-only, through the bridge — the same checks as a reply (its own link, while linked), and only
  that conversation (a thread link: only its thread; a file only when shared there).
- **Starting from Slack** (`slack.spawn` on the bridge's server): a person allowed by `from`
  mentions the app in a channel thread (or top-level: its own thread) that no active link follows
  — a mention in a followed thread goes to that session as before; DMs never start one. The bridge
  reacts 👀 and spawns on `slack.spawn.host` (`POST /api/hosts/:host/spawn` with `slack: { url,
  minutes, mode, task, from }`), the message without the mention as the prompt. The intro says who
  asked; a colleague's request stays a colleague's (the rules above hold). A failed spawn is said
  in the thread. One spawn per thread at a time; an event Slack sends twice opens one session.
  The session runs as the host's user — with `from: "anyone"`, everyone in those channels can make
  it act on that host. The app needs the `message.channels` (and, for private channels,
  `message.groups`) events. Settings → Slack (`PUT /api/slack/spawn`) turns it on or off per bridge
  and applies at once; so does a change to the file (`overmind config set`, a hand edit), within a few seconds; `null` turns it off.
- **Live settings**: `slack.owner`, `slack.owners` and `slack.spawn` are re-read when the config file changes (the
  server checks every 5 s); a link marks whoever is the owner now. `slack.host` and `slack.bridges`
  are read at start: changing them needs a web server restart (`overmind config set` says so).
  A link's `sessionName` follows the session's name (`/rename`) whenever the bridge lists it.
- **State** (`<overmind state>/slack-links.json`, 0600): the active links with their undelivered
  messages and the last 20 ended ones.

## Session briefs

A brief is a small markdown doc per session: 1–3 sentences on exactly what the session is doing,
where it stands and what comes next (where it runs is shown beside it), every resource it
produced, and its todos with progress — enough to start a **new** session from it and just
continue (`continuePrompt` in the API is that first prompt). The user can edit it; their edits are authoritative.

**Storage.** One file per session on the host the session lives on:
`$OVERMIND_BRIEFS_DIR/<session_id>.md`, else `${XDG_STATE_HOME:-~/.local/state}/overmind/briefs/<session_id>.md`
(dir `0700`, files `0600`), always written atomically (temp file + rename). The web server owns
generation (`web/lib/briefs.mjs`); any other reader/writer — `overmind brief` (`core::brief`, a port
of `web/lib/brief-format.mjs` and the PUT rules) — uses the same files and must follow the same
format and merge rules. Both implementations pin the shared fixtures in `testdata/briefs/`
(regenerate the expected outputs from the server code with `node testdata/briefs/gen.mjs`).

**Format** (a contract, like the JSON outputs — add keys freely, never rename or retype one):

```markdown
---
session: <session_id>
host: laptop
cwd: ~/Code/project
updated: 2026-01-02T03:04:05.000Z
generatedThrough: 48213
generatedAt: 2026-01-02T03:04:05.000Z
editedAt: 2026-01-02T03:10:00.000Z
todos: 3f2a9c01b7de
dismissed: ["https://github.com/owner/repo/pull/9"]
git: Git: `fix-login` · worktree `~/Code/project-wt`
---
## Summary
Fixing the login redirect loop in ~/Code/project on branch fix-login; the fix is in review.

## Resources
- Origin: [Task 42: login loop](https://app.example.dev/tasks/42)
- Git: `fix-login` · worktree `~/Code/project-wt`
- PR: [owner/repo#12](https://github.com/owner/repo/pull/12)
- File: `src/login.ts`
- Spec: `specs/login/SPEC.md`
- Artifact: [Login report](https://claude.ai/code/artifact/…)
- Link: [docs.example.dev/auth](https://docs.example.dev/auth)

## Todos
- [x] reproduce the loop
- [ ] fix the redirect (in progress)
```

- Frontmatter: `key: value` lines between `---` fences. Numbers are bare, arrays/objects are
  one-line JSON, a string that would read back as another type is a JSON string. Keys:
  `session`, `host`, `cwd` (informational, written by the server); `updated` (last write of any
  kind, ISO 8601); **`generatedThrough`** — the **byte offset** into the session's transcript JSONL
  (`~/.claude/projects/<encoded cwd>/<session_id>.jsonl`) up to which the conversation has been
  summarised, always at a line boundary (a transcript smaller than it was replaced: start over);
  `generatedAt` (last model generation); `editedAt` (last human edit, absent until one);
  `todos` (hash of the todo list last copied into Todos); `dismissed` (resource keys a human
  deleted — never added back; at most 200); `git` (the auto `Git:` line last written; its
  presence also means the legacy `Branch:` / `Worktree:` lines were migrated). Unknown keys are
  preserved.
- Body: exactly three `## ` sections, written in this order — `Summary`, `Resources`, `Todos`.
  Parsers are tolerant: headings case-insensitive, sections in any order or missing, text before
  the first heading and other `## ` sections are kept (written after Todos), `*`/`+` bullets,
  `[X]`. A `## Plan` section (the name before Todos) is read as `## Todos` and written back as
  `## Todos` on the next write.
- Resources: one bullet per item, `- <Kind>: <value>`, value a markdown link `[label](url)` or a
  code span `` `path` ``. Kinds: `Origin` (where the work came from: a task, a Slack thread, an
  issue), `PR`, `Issue`, `Artifact`, `Spec`, `File`, `Git`, `Link` (and the legacy `Branch`,
  `Worktree`). Any other bullet (no kind, free text) is a hand-written line and
  kept as is. An item's **key** is its URL (fragment and trailing `/` dropped), else its path
  (`branch:<name>` / `worktree:<path>` for the legacy kinds); every `Git` line has the key `git`.
  Paths are relative to the session's cwd when inside it, else `~/…`, else absolute.
- The **Git line** — one per brief, where the session's checkout is: ``- Git: `<branch>` · worktree
  `<root>` `` for a linked worktree, `` · repo `<root>` `` for the main checkout (`<root>` = the
  checkout root, `~/…`; `detached` in place of the branch). A Git line in exactly this form is the
  auto one and is **replaced in place** when the branch or root changes; with no Git line at all
  one is inserted at the top of Resources unless `git` is in `dismissed` (a human deleted it). A
  Git line in any other form (e.g. with a note appended) is a human's and left alone. Migration:
  before the `git` frontmatter key exists, the server's old auto lines — exactly
  `` - Branch: `<name>` `` / `` - Worktree: `<path>` `` — are dropped on the next write and the Git
  line takes the first one's place; hand-written variants (other bullets, extra text) stay.
- Todos: `- [ ] todo` / `- [x] todo` lines; other lines in the section are kept.

**Merge rules** (every writer): never drop a line a human wrote; new auto items are appended
unless their key is already present or in `dismissed` (the Git line: replaced in place, above; an
`Origin` item whose link is already there as an auto `Link:` / `Issue:` line turns that line into
`Origin:`); a
human edit (PUT) that removes a resource line adds its key to `dismissed`; the machine keys
(`generatedThrough`, `generatedAt`, `todos`, `dismissed`, `git`) are the writer's, not taken from
an edited body.

**Generation** (hybrid, `web/lib/brief-extract.mjs` + `web/lib/briefs.mjs`):

1. *Resources without a model*, read incrementally from the transcript: files the session wrote
   (Edit / Write / MultiEdit / NotebookEdit targets, shell redirects and `tee`; temp dirs skipped;
   `SPEC.md`, `FINAL.md` and files under `specs/` are `Spec`), PR/issue URLs printed by
   `gh pr|issue create`, artifact URLs returned by an Artifact publish, PR/issue/artifact/other
   links in the assistant's text, PR/issue/artifact links in the user's prompts; `Origin` = the
   other links (issue, task, Slack thread, …) of the session's **first** prompt, plus the `Origin:`
   list of a brief that prompt hands over (so the origin carries down a chain of continued
   sessions — as do the handed brief's PR links); the Git line
   (branch, checkout root, linked worktree or not) from one `git rev-parse` in the cwd. Links to this machine or the private network (IP
   literals, dotless or `.local`/`.ts.net` hosts), schema hosts, templated or `…`-truncated URLs are
   dropped. Read-only tool output (a file that lists PRs) never counts.
2. *Todos without a model* when the session keeps todos: the latest `TodoWrite` list, or the task
   list from `TaskCreate`/`TaskUpdate`, is the Todos section (rewritten only when the list
   changes, so a hand edit stands until the next todo change).
3. *Summary* (and the Todos when the session keeps none) from `claude -p --model <model>` — flags as in
   `core::naming` (prompt on stdin, `--strict-mcp-config`, tools disallowed, a neutral cwd) plus
   `--no-session-persistence`, 2 min timeout. Input: the current Summary + Todos (≤ `maxBriefChars`)
   and ONLY the conversation since `generatedThrough` — user prompts and turn-ending assistant
   text, each clipped, newest kept, ≤ `maxDeltaChars` — told that hand-edited content is
   authoritative and to update, not rewrite. The answer must be a `## Summary` (≤ 1200 chars) and
   optionally a `## Todos` of checkboxes (`## Plan` is accepted too); anything else keeps the old brief. An edit that lands
   while the model runs wins (the answer is discarded).

A **Codex** row reads its rollout (the `transcript` discovery puts on the row) instead of a Claude
transcript: files its completed `FileChange` items changed and its `CommandExecution` commands
wrote (resolved against the item's cwd), `gh pr|issue create` output, links in its replies and
prompts (Codex's own context messages skipped), dirs from `session_meta` / `turn_context`; it keeps
no todo list, so the Todos come from the model. The Summary is still `claude -p`'s (background jobs
stay on Claude).

**Continue prompt** (`continuePrompt` in `web/lib/brief-format.mjs`, `continue_prompt` in
`core::brief`; byte-identical, pinned by `testdata/briefs/sample.continue.txt`) — the first prompt
of a new session that picks the work up. It carries only what the next session needs to find the
work, not the session's detail:

```text
Continue the work of session <id> on <host> in <cwd>. Its brief:

<Summary>

Origin:
- [Task 42: login loop](https://app.example.dev/tasks/42)

PRs:
- [owner/repo#12](https://github.com/owner/repo/pull/12)

Worktree: `~/Code/project-wt` (branch `fix-login`)

---
```

`Origin:` / `PRs:` / `Worktree:` (a linked worktree only) are left out when empty; files,
artifacts, links and todos are never included. The **task** for the new session goes below the
`---` line (the UI puts the caret there; `overmind spawn --from <s> "<task>"` appends it); sent with
nothing below it, the task is `Pick up where it left off. Check the current state (git status, the
PRs above) before changing anything, and tell me briefly what you found first.` Extraction treats
the text below the separator as the user's own prompt and the part above it as the handed brief.

**Budget** — model calls are what costs, so every automatic one has to pass all of:

- the session is `idle` or `waiting`, and has been for `idleMs` (registry `updated_at`);
- its transcript grew past `generatedThrough` by ≥ `minNewTurns` user prompts or ≥
  `minNewChars` characters of conversation;
- ≥ `minIntervalMs` since that session's last call (a gated update stays pending and runs when the
  gate opens, without needing more growth);
- no other brief call is running on this host (one at a time), and fewer than
  `maxCallsPerHour` calls in the last hour.

The background pass checks this host's live sessions every 30 s (the discovery cache — no
extra `overmind list` while a UI is polling) and forgets sessions that are gone. Resource and todo
extraction (no model) runs whenever the transcript grew — in the background pass and on GET. A
manual regenerate skips the idle, interval and new-content gates (with nothing new it re-reads the
recent conversation) but waits for the one-at-a-time slot and counts against the hourly cap. Each
call is logged with its input size (`[briefs] idle 1a2b3c4d: claude -p --model haiku, 12 msg(s) /
3 user turn(s), 8123 chars in (4/12 this hour)`); `/api/health` reports `briefs: { enabled, model,
callsLastHour, maxCallsPerHour, generating, lastRun }`.

**Open in editor.** GET/PUT brief bodies carry `absCwd` (the session's directory on its host,
absolute, no `~`), `gitRoot` (the checkout root — repo or linked worktree — containing it, absolute;
null outside git), `editor` (`web.editor` of the answering server) and `editorUrl`; session rows in
`/api/overmind` carry `editorUrl` for their cwd. `worktrees` lists the git checkouts the session works
in — `[{ path, display, branch, linked, editorUrl }]`, the cwd's first, then the checkouts of the
directories the transcript records the session in (its entries' `cwd`, kept in the brief's `dirs`
frontmatter key) and of the File / Spec resources; a directory's checkout is the nearest ancestor
with a `.git`, deduped by root — each with its own `editorUrl`. The link targets `gitRoot`, else `absCwd`:
`vscode://file/<path>` when the session is on the machine the browser runs on, else
`vscode://vscode-remote/ssh-remote+<hosts.<host>.ssh><path>` (Remote-SSH with **that** server's ssh
alias for the host). The browser's machine is read from the request: a loopback address is the
answering server's own host, an address equal to a host's `web` url hostname is that host, anything
else (a phone) is none of them. For a session on the answering server's own host seen from another
machine the ssh destination is `web.editorSsh`, else `<server user>@<the hostname the browser
used>`. `cursor://…` alike for `web.editor: "cursor"`; `null` when `web.editor` is null,
there is no absolute path, or the host has no usable `ssh` alias. A proxied request is answered by
the peer (which knows only its own absolute paths) and the server that received it fills in
`editor` / `editorUrl` from its own config and the request's address.
`overmind brief <target> --open` does the same from the CLI: `code <path>` here, `code --remote
ssh-remote+<ssh dest> <path>` for a session on another host (`cursor` with `web.editor: "cursor"`).

## Session stacks

A **stack** is N Claude Code sessions — on one host or across hosts — sharing one context
layer: a markdown file, the **StackBrief**. Any session can spawn a *sibling* (`overmind stack
spawn`, the web UI's "Spawn sibling"), on its own host or on another one (`--on <host>`, the
form's Host choice); the sibling joins the source's stack, which is created around the source
first when it has none. Every session spawned into a stack starts with the **context line**:

```
You're running in the session stack with shared context: <abs path to the stack file>. <prompt>
```

(nothing after the period when the prompt is empty; `core::stack::context_line` /
`stack_prompt`, and `contextLine` in every `--json` output so the web server prepends the same
text). A sibling on **another host** than the stack's home cannot read that path, so it gets the
**remote context line** instead (`core::stack::remote_context_line`, `remoteContextLine` in the
StackView):

```
You're running in the session stack with shared context: stack <id> on host <home>. Read it with `overmind -H <home> stack show <id>` and update it with `overmind -H <home> stack set <id>` (the whole markdown on stdin; `overmind -H <home> stack show <id> --json` has it under `markdown`). <prompt>
```

`overmind -H <home> stack show` / `set` reach the home over ssh when there is a destination for it,
else over its web server (`hosts.<home>.web`, the stack routes below — the sheds have web urls
for each other and no ssh). The StackBrief is generated once, at creation; after that it is
maintained by scripts (membership) and by hand. Logic: `core::stack`; CLI: `overmind stack`
([cli.md](cli.md#stacks)); the web server only shells out to `overmind --local stack … --json` and
never parses the markdown.

**Storage.** `$OVERMIND_STACKS_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/overmind/stacks/`, one
`<stack_id>.md` per stack (dir `0700`, files `0600`, atomic temp + rename writes). The file is
the state — no index; "which stack is session X in" scans the dir. Stack id: `st-` + 8 random
lowercase hex, never changes. A stack lives on the host where its file is — its **home**
(frontmatter `host`) — and every `overmind stack` command about it runs there (`-H <home>` from
elsewhere). Its members may run on any host: `members[].host` (a member without one is on the
home). Only the home host knows the stack: `overmind list` on another host does not stamp its
members' rows (the web server does, from the home's `/api/overmind` entry — see below), and
`overmind stack list` there does not show it.

**Format** (a contract: add keys freely, never rename or retype one):

```markdown
---
stack: st-1a2b3c4d
label: Login redirect fix
host: laptop
cwd: ~/Code/project
created: 2026-09-29T10:00:00.000Z
updated: 2026-09-29T12:00:00.000Z
generatedAt: 2026-09-29T10:00:05.000Z
editedAt: 2026-09-29T11:00:00.000Z
members: [{"session":"<uuid>","host":"laptop","name":"login-redirect","added":"2026-09-29T10:00:00.000Z","closed":null,"cwd":"~/Code/project","firstPrompt":"Fix the login redirect loop"}]
---
> Shared context for the session stack **Login redirect fix** (`st-1a2b3c4d`). Every session in
> this stack reads this file when it starts. Keep **Summary** and **Resources** current for your
> siblings (PRs, worktrees, folders, decisions). **Sessions** is maintained by `overmind stack` — do
> not edit it; read a sibling's brief or transcript from there when you need to know what it did.

## Summary
2–4 sentences on the stack as a whole: what, and where (repo, branch/worktree, host).

## Resources
- Git: `fix-login` · worktree `~/Code/project-wt`
- PR: [owner/repo#12](https://github.com/owner/repo/pull/12)
- Folder: `~/Code/project`

## Sessions
- **login-redirect** (`1a2b3c4d`, live) — added 2026-09-29 10:00 · brief `~/.local/state/overmind/briefs/<uuid>.md` · transcript `~/.claude/projects/<encoded cwd>/<uuid>.jsonl`
  first prompt: "Fix the login redirect loop"

## Notes
free text; any other `## ` section is kept as is
```

- Frontmatter: the briefs' encoding (`key: value`, arrays/objects one-line JSON). Machine keys —
  `stack`, `host`, `cwd`, `created`, `updated` (last write of any kind), `generatedAt` (the model
  wrote Summary/Resources), `editedAt` (last human edit), `members` — are never taken from an
  edited body; `label` is (from the submitted frontmatter). Unknown keys are preserved.
- `members[]`: `{ session, host, name, added, closed, cwd?, firstPrompt?, transcript? }` — `host` is where
  the session runs (the stack's home when absent), `name` is the
  display title at the last sync, `closed` `null` while live and an ISO time once the session was
  seen gone (members are never removed automatically; `overmind stack remove` does), `cwd` (`~/…`,
  or absolute on another host) and `firstPrompt` (≤ 160 chars) are kept so the Sessions line
  survives the session; `transcript` (`~/…`, Codex / pi members only) is the rollout discovery
  named, since theirs can't be derived from cwd + id. Unknown member keys are preserved.
- Body: the header blockquote and `## Sessions` are **regenerated** on every machine write
  (Sessions from `members`: `live` / `closed <date>`, `, on <host>` for a member on another host
  than the home (its paths are paths there), the brief path whether or not it exists, the
  transcript path (a Codex / pi member's `transcript`, else Claude's for its cwd), `first prompt:` when known; dates UTC). `Summary`,
  `Resources`, `Notes` and any other section, and text above the first heading, are a human's
  and kept verbatim. Parsing is tolerant like briefs (case-insensitive headings, any order,
  missing sections); Resources bullets parse like a brief's (`parse_resource_line`; `Folder:`
  lines get the kind `Folder`).
- Human edit (`overmind stack set` / `edit`, web PUT): the submitted body is authoritative except
  for the header and Sessions; machine keys are the stored file's; `editedAt` + `updated`
  stamped; `--expect-updated` / `expectUpdated` refuses a stale edit (CLI exit 3, HTTP 409). At
  most 64 kB.

**Membership sync** (`core::stack::sync`, no model): for every stack file on this host, a member
whose session id is not among the live sessions *of its host* gets `closed = now` (once); a live
one gets its `name` refreshed from `display_title` (and `closed` cleared — a resumed session).
A member is judged only against the rows of its own host (`core::stack::Observed`): plain
`overmind stack sync` knows this machine's sessions, so members on other hosts are left as they
were; `--input <src>` (`-` = stdin; a `list --json` array or a `/api/overmind` body) adds the other
hosts' live rows, and a host with `ok: false` there is still not judged. The web server passes
its merged overmind that way, so a sibling that ended on another host is closed within a sync
interval (and re-opened if it comes back). Only files whose members changed are rewritten. It
runs in `overmind stack list` / `show` / `sync` and after `spawn` / `add` / `remove`; the web server
runs `stack sync` after a kill, once 30 s after start, and every `web.stacks.syncMinutes` while
any session is in a stack or it knows a stack. Nothing is marked closed when the session
registry can't be read, and a member dormant on this machine (left by a reboot,
`snapshot::dormant_session_ids`) is not marked closed either — it is left as it was. StackView
members carry `host`, `dormant: true|false` next to `live` (dormant = not live and in this
machine's dormant set); for a member on a host not observed, `live` is `closed == null`,
`status` is `null` and `briefPath` is `null` (the brief is on that host). `overmind list` only
stamps `stack: { id, label, host } | null` on each row (read-only; `host` = the stack's home).

**Generation** (creation only; `stacks.model`, default `sonnet`): one `core::naming::ask_claude`
call (`-p --model <m> --strict-mcp-config`, tools disallowed, prompt on stdin, neutral cwd, 120 s)
with the source session's display title, cwd, host, its Git line (`git rev-parse` in the cwd),
first prompt, its session brief's body when there is one, and the last ~6000 characters of its
conversation (user prompts and turn-ending assistant text, main thread, tool blocks skipped; a
Codex source's from its rollout, its own context messages skipped).
The answer must be `Label: <2–5 words>`, `## Summary` (≤ 1000 chars, generalised to the stack)
and `## Resources` (`- Kind: value` bullets of things really in the input); the Git line and a
Folder line are added when missing. Anything unparseable, a failed call, `--no-llm`,
`OVERMIND_FIXTURE` or `stacks.enabled: false` → the skeleton (Summary "Started from <title> in
<cwd>.", Resources = Git line + Folder): a model failure never blocks creating the stack
(`generated: false` and a `warning`). There is no regeneration after creation (v1).

## Session recovery

After a reboot overmind shows what was running as **dormant** and brings it back on demand: the same
tmux session name, windows, panes and cwds, every Claude pane re-launched with
`<launcher> <flags> --resume <sessionId>`. The session id is unchanged by `--resume` (only
`--fork-session` mints a new one), so groups, stacks and briefs — all keyed by session id — carry
over. Code: `core::snapshot` (no printing); CLI: `overmind restore` and `overmind enter`
([cli.md](cli.md#session-recovery)).

### `snapshot.json`

One per machine: `$OVERMIND_SNAPSHOT`, else `${XDG_STATE_HOME:-~/.local/state}/overmind/snapshot.json`
(dir `0700`, file `0600`, written atomically under a `snapshot.json.lock` file lock). Unknown keys
are preserved at every level on rewrite — it is a contract like `groups.json`.

```json
{
  "version": 1, "host": "laptop", "bootId": "1727000000", "updatedAt": "2026-10-04T12:00:00Z",
  "tmux":  [ TmuxSnap… ],
  "iterm": [ ClaudeSnap… ],
  "dormant": { "tmux": [ TmuxSnap… ], "iterm": [ ClaudeSnap… ] },
  "closed":  { "tmux": [ TmuxSnap… ], "claude": [ ClaudeSnap… ] }
}
TmuxSnap   = { name, windows: [ { index, name, layout, active, autoName,
                                  panes: [ { index, cwd, active, claude: ClaudeSnap|null } ] } ],
               since?, goneAt?, closedAt? }
ClaudeSnap = { sessionId, name, cwd, title, flags: [argv…], since?, goneAt?, closedAt?, tmuxSession? }
```

- `tmux` — the live tmux sessions of the current boot; `iterm` — live Claude sessions that are
  not in a tmux pane overmind can see (iTerm, unknown). `dormant` — what earlier boots ran.
  `closed` — what ended within a boot ([Recently closed](#recently-closed)); added later, so a
  file without it is an empty list. A session id is never both dormant and closed.
- `layout` is `#{window_layout}`; `autoName` = tmux named the window itself (a restore then
  leaves the name to tmux). `title` is the display title when recorded. `flags` is the
  replay-safe part of the Claude command line (`--dangerously-skip-permissions`, `--chrome`,
  `--model`, `--permission-mode`, `--add-dir`, `--agent`, `--fallback-model`; `--k=v` is
  normalised to `--k v`).
- `since` (dormant entries) — when it went down: the old boot's last `updatedAt`. An unchanged
  snapshot is still rewritten every 10 minutes so this stays accurate.
- `goneAt` (live entries) — it vanished this long ago; after 5 minutes it moves into `closed`. A
  restart quits the terminal apps (and the Claude sessions in them) before it kills the daemons,
  and a poll in between must not erase them; a Claude session gone from a pane that is still there
  lingers in that pane, one whose pane is gone lingers in `iterm` (with `tmuxSession`).
- `closedAt` (closed entries) — when it ended (its `goneAt`). `tmuxSession` — the tmux session a
  Claude session ran in, kept when it left its pane (`/exit`, the shell stayed).
- `bootId` — `$OVERMIND_BOOT_ID` (tests), else Linux `/proc/sys/kernel/random/boot_id`, else macOS
  `kern.boottime` seconds. Unknown → nothing is ever marked dormant.

**Recording** happens on every local `overmind list` with a successful discovery (one `tmux
list-panes -a`, one `ps` for the Claude pids), never in fixture mode, never when tmux fails for a
reason other than "no server", and only writes when something changed. Rules: a stored boot id
different from the current one moves the stored `tmux`/`iterm` into `dormant` (merged by tmux name
/ session id); then `tmux`/`iterm` become the live state; a dormant Claude session that is live
again (resumed by hand) leaves `dormant` (inside a dormant tmux session its pane becomes a plain
shell), and a dormant tmux session left with no dormant Claude pane whose name is live again is
dropped. Readers that do not record (the `watch` header, `overmind tmux list`, the `list` footer)
apply a pending reboot in memory; `overmind restore` and the dormant lookup of `overmind enter` record
first, so the first command after a reboot already sees the old boot as dormant.

**For other views** (groups, stacks, the web Board): `core::snapshot::dormant_session_ids()` is the
set of this machine's dormant session ids; for another host, `overmind -H <host> restore --json` and
the `sessionId`s under `dormant[].sessions`. A dormant session counts as *present*, not gone:
grouping keeps its assignment and flags the member `dormant: true` ([Smart
grouping](#smart-grouping)); stack sync doesn't close it and StackView members carry `dormant`.

### Slept sessions

`overmind sleep` (Deactivate in the app, whose dormant list is called Inactive; `core::sleep`) is a Close that keeps the session dormant. It
records the snapshot, ends the agent and its tmux window/session, records again (the session now
lingers as just ended) and `snapshot::put_to_sleep` moves that entry — the whole tmux session when
it went with it, else the lone Claude session — into `dormant`, `since` = now, `slept: true`. From
there it is like any dormant entry (restore, `enter`, forget, groups, stacks), except that
`restore --all` (and so `restore.onBoot`) skips it.

### Recently closed

A session that ends *within* a boot — Close in the app, `overmind kill`, `/exit`, a killed tmux
session — is **closed**, deliberately separate from dormant: it is never part of `restore --all`,
`restore.onBoot`, `overmind enter`'s auto-restore, `dormant_session_ids()` or the groups'/stacks'
dormant sets, so a closed session's group and stack membership lapses as before. It can still be
brought back by hand for `restore.keepClosedDays` (default 7; `0` = off), the newest 50 at most.

- It shows as closed at once: `core::snapshot::closed_entries` is the stored `closed` lists plus
  whatever still lingers with `goneAt`. When the grace period ends it moves into `closed`
  (`closedAt` = its `goneAt`); a reboot within the grace period makes it dormant instead (and it
  leaves the closed list). Older closed entries stay closed across a reboot (expiry still applies).
- Whole tmux sessions are kept only when they had a Claude pane; plain shell sessions are not. A
  Claude session that exits while its tmux pane lives on is a lone closed entry with
  `tmuxSession`.
- A closed (or dormant) Claude session whose id is live again leaves the list; a closed tmux
  session left with no Claude pane goes. A newer closed tmux session of the same name replaces
  the older one, whose Claude sessions stay as lone entries.
- Restore (`overmind restore --closed <target>`) is the dormant restore: a tmux session with its
  layout (non-Claude panes a plain shell), a lone Claude session in a new tmux session named
  after its title — except one with a `tmuxSession` that still exists, which gets a new window
  (`new-window -d`) there running the resume line. Same launcher, flags, name-clash handling,
  dry run, file lock and exit codes (2 ambiguous, 3 no match).

## Extension points

- **Another web UI.** The HTTP API is the contract; point `web.ui` (or `OVERMIND_WEB_UI`) at a
  directory with its own `index.html` and it is served same-origin with `/api/*`, or build a
  separate app against the same API.
- **A different TUI or native app.** Link the core library (`overmind::core`) directly, or shell out
  to `overmind list --json` and the other commands.
- **Integrations** (notifications, chat bots, status bars): poll `overmind list --all-hosts --json`
  or `GET /api/overmind`; act through `overmind send` / `POST …/send`. Treat anything that can send as
  having the agent's full permissions.
- **New backends** (another terminal emulator): implement discovery matching (tty → handle) and
  the control operations in `core::backend`; everything above picks it up.
- **The Claude Code skill** (`overmind skill install`) teaches an agent to use `overmind` itself —
  e.g. to hand work off to another session.
