# Migrating from tb-fleet, ws or fleet-web

`overmind` replaces three tools:

- **tb-fleet** — the Rust CLI that sees and steers Claude sessions on one machine;
- **ws** — a shell script that managed tmux sessions on a remote workstation over ssh;
- **fleet-web** — the Node web app that showed the overmind on a phone.

Behavior and JSON output are kept; names, config and env vars changed.

## Steps

1. Install `overmind` on every machine (`cargo install --path crates/overmind` on one,
   `overmind install --host <name>` for the others).
2. Run `overmind init` on each machine. It replaces the old per-tool config (fleet-web's
   `config.json` next to `server.mjs`, ws's host variable and machine detection).
3. Replace scripts and aliases using the tables below; rename `WS_*` / `TB_OVERMIND_*` env vars.
4. Install the new skill and remove the old one: `overmind skill install`, then delete
   `~/.claude/skills/tb-fleet`.
5. Stop the old web server and start `overmind web serve` (or `overmind web install-service`).
6. Update tmux bindings that run `tb-fleet` (e.g. a `overmind` session running `tb-fleet watch`
   now runs `overmind watch`).
7. Remove the old binaries (`tb-fleet`, `ws`) and any shell function or alias named `ws` — an old
   shell function shadows a binary on `PATH` (check with `type ws`).

## tb-fleet → overmind

The session commands are identical; only the binary name changes. They now also accept `-H <host>`.

| tb-fleet | overmind |
| --- | --- |
| `tb-fleet` / `tb-fleet watch` | `overmind` / `overmind watch` |
| `tb-fleet list [--json]` | `overmind list [--json]` (+ `-a/--all-hosts`; rows now carry `host`) |
| `tb-fleet peek <t>` | `overmind peek <t>` |
| `tb-fleet send <t> <text>` | `overmind send <t> <text>` |
| `tb-fleet rename <t> <name>` | `overmind rename <t> <name>` |
| `tb-fleet name …` | `overmind name …` |
| `tb-fleet spawn …` | `overmind spawn …` |
| `tb-fleet handoff …` | `overmind handoff …` |
| `tb-fleet skill install` | `overmind skill install` |
| `TB_OVERMIND_FIXTURE` | `OVERMIND_FIXTURE` |

The `list --json` schema is unchanged except for the added `host` field. The naming cache (`~/.claude/overmind-names.json`) and handoff
briefs (`~/.claude/overmind-handoffs/`) keep their locations. Settings from tb-fleet's `config.toml` move into
`config.json` by hand: `[ui]` → `tui` (`rows`, `mouse`), `[naming]` → `naming` (`enabled`, `model`,
`syncTmux`, `autoTitle`), and `command` → `claude`. For example
`overmind config set naming.model haiku`.

Dropped: the toolbox version/update check.

## ws → overmind

`ws` ran commands on the workstation over ssh, or locally when run on it. `overmind` does the same
through the host model: tmux-session commands target `defaultHost` unless you pass `-H` or
`--local`, and "which machine am I" comes from `self` in the config instead of hostname or a
machine file.

| ws | overmind |
| --- | --- |
| `ws` / `ws list [-q]` | `overmind tmux` / `overmind tmux list [-q]` (alias `overmind t`) |
| `ws enter <query>` | `overmind enter <query>` |
| `ws last` | `overmind last` |
| `ws new [name] [-d] [-C dir] [-- cmd]` | `overmind new [name] [-d] [-C dir] [-- cmd]` |
| `ws kill <query> [-f]` | `overmind tmux kill <query> [-f]` |
| `ws rename <query> <name>` | `overmind tmux rename <query> <name>` |
| `ws stale [--kill] …` | `overmind tmux stale [--kill] …` |
| `ws f` / `ws overmind` | `overmind -H workstation list` |
| `ws f watch` | `overmind -H workstation watch` |
| `ws f <args…>` | `overmind -H workstation <args…>` |
| `ws f spawn …` (implied `--backend tmux`) | `overmind -H workstation spawn …` (tmux is the default over ssh) |
| `ws exec [-C dir] [-t] -- cmd` | `overmind exec [-C dir] [-t] -- cmd` |
| `ws ssh [cmd]` | `overmind ssh [cmd]` |
| `ws doctor` | `overmind doctor` |
| `ws --host <alias>` | `overmind -H <name>` (a config host name; its `ssh` field holds the alias) |
| `ws --local` / `--remote` | `overmind --local` / `overmind -H <name>` |
| `ws -n` | `overmind -n` / `OVERMIND_DRY_RUN=1` |

Note that `overmind rename` is the *Claude* rename (formerly `ws f rename`); the tmux rename is
`overmind tmux rename`.

### Environment variables

| old | new |
| --- | --- |
| `WS_HOST` | `OVERMIND_HOST` (a config host name, not an ssh alias) |
| `WS_LOCAL=1` | `--local` |
| `WS_DRY_RUN=1` | `OVERMIND_DRY_RUN=1` |
| `WS_DEBUG=1` | `OVERMIND_DEBUG=1` |
| `WS_CONNECT_TIMEOUT` | `OVERMIND_CONNECT_TIMEOUT` |
| `WS_MUX=0` | `OVERMIND_MUX=0` |
| `WS_OVERMIND_TIMEOUT` | dropped — the stale cross-check is in-process now (`OVERMIND_REMOTE_TIMEOUT` bounds remote calls) |
| `TB_OVERMIND_FIXTURE` | `OVERMIND_FIXTURE` |
| tb-fleet `command` config / wrapper | `OVERMIND_CMD` or config `claude` |
| `NO_COLOR` | `NO_COLOR` |

## fleet-web → overmind web

The server and UI moved into `web/` and are started by the CLI.

| fleet-web | overmind |
| --- | --- |
| `node server.mjs` / `bin/dev.sh` | `overmind web serve` |
| its tmux / launchd start scripts | `overmind web install-service`, or a tmux session running `overmind web serve` |
| its deploy-to-workstation script | `overmind install --host workstation` |
| `config.json` next to `server.mjs` | `~/.config/overmind/config.json` (shared with the CLI) |
| `self` | `self` |
| `port`, `bind` | `web.port`, `web.bind` |
| `peers: { name: url }` | `hosts.<name>.web` |
| `tbOvermind` | `overmindBin` (optional; `overmind` is found on `PATH`) |
| `tmux` | `tmux` |
| quick-reply chips (hard-coded) | `web.quickReplies` |
| `autoName: { enabled, intervalMinutes }` | `web.autoName: { enabled, intervalMinutes }` (runs `overmind name --all --apply`) |
| `spawnDirs: [{ label, path }]` | `spawnDirs: [{ label, paths: { <host>: dir } }]` — one list for all hosts |
| `OVERMIND_WEB_CONFIG` | `OVERMIND_CONFIG` |
| `PORT` | `OVERMIND_WEB_PORT` (`PORT` still works) |

The HTTP API is unchanged; session objects are `overmind list --json` objects plus `host`.
