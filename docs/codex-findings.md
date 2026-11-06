# Codex 0.166 — approvals, hooks and the daemon (live findings)

What issue #34 phase 1a builds on, checked live on 2026-11-04 against Codex `0.166.0` on a
real `~/.codex` (one throwaway tmux session in a directory without `.git`, `-s read-only -a
on-request`; the app-server daemon was running the whole time and never restarted). The phase 0
spike before it is summarised in §1. The screens behind the menu parser are committed as
fixtures: `web/tests/fixtures/codex-approval.txt` (a plain menu) and
`web/tests/fixtures/codex-approval-child.txt` (a sub-agent's request shown in the parent).

## 1. Codex records no pending approval

No file says a session waits on an approval, in either mode: the rollout has no
`*_approval_request` line (the event names exist in the binary but are not persisted),
`thread_turns` stays `inProgress`, the daemon log and `logs_2.sqlite` say nothing. What exists:

- the **screen**: `Would you like to run the following command?` … `$ <cmd>` … three options …
  `Press enter to confirm or esc to cancel`;
- the **rollout**: the turn's last `custom_tool_call` (`name: "exec"`) whose `input` asks
  `sandbox_permissions` `require_escalated`, with no `custom_tool_call_output` for its `call_id`
  yet. Two shapes: embedded mode quotes the key (`"sandbox_permissions":"require_escalated"`),
  daemon mode does not (`sandbox_permissions:"require_escalated"`). The same string also sits in
  the session's instructions and in `compacted` lines, so only `custom_tool_call` lines count;
- a **`PermissionRequest` hook**, when one is installed and trusted: `session_id`, `turn_id`,
  `transcript_path`, `cwd`, `tool_name: "Bash"`, `tool_input: { command, description }`.
  Nothing fires when the approval is answered, and approving writes nothing either: the next
  rollout line for the call is the command's `item_completed`, when it ends.

Hence Overmind's rule: the hook or the rollout only *triggers* a look; the screen decides.
And since leaving the menu touches no file, the web server's watcher cannot see it: a list
holding a waiting Codex row is reused for the short TTL only, not the watcher's safety interval.
Measured: an approval answered in the TUI reads `busy` on the web ~3.5 s later — the 3 s refresh
plus one list; `?fresh=1` changes nothing (the CLI itself reads `busy` within 0.1 s).

## 2. Hooks

| Check | Result |
| --- | --- |
| `overmind codex hooks install` on a hooks.json with a user `PostToolUse` group | one group appended to each of `PermissionRequest`, `Stop`, `UserPromptSubmit`; the user's group untouched |
| Trust | the next TUI start shows "Hooks need review — 3 hooks are new or changed"; "Trust all and continue" writes `[hooks.state."<abs hooks.json>:<event>:<group>:0"] trusted_hash` to `config.toml` |
| **Daemon mode** (TUI without `-c`, daemon started hours before hooks.json) | **the hook fires**: a sidecar for the new session at the approval, no daemon restart. Sessions already running when hooks.json changed keep the hook set they started with (one running since before the install never wrote a sidecar) |
| Embedded mode (`-c model_reasoning_effort=medium`) | fires the same |
| Sub-agent approval | the hook carries the **parent's** `session_id` and the child's `transcript_path`; the **parent's** screen shows the menu, with a `Thread: Agent (<child id>)` line and `… or o to open thread` in the footer. So the parent row waits, through the hook. Without the hook the parent row stays `busy`: the escalated call is in the child's rollout. Two sub-agents asking at once both write the parent's sidecar |
| `_codex-hook` cost (release build, warm) | median 3.5 ms, p90 3.7 ms (first run 310 ms, cold); exit 0 with empty stdout/stderr also on garbage, empty stdin and a path-like `session_id` (measured with `OVERMIND_CODEX_HOOKS_DIR` in a temp dir) |
| `uninstall` | removes only Overmind's groups; the user's `PostToolUse` group stays; `[hooks.state]` left alone |
| `timeout` unit | **seconds**: the `/hooks` detail shows `Timeout 5s`, a sync `sleep 10` is killed after 5 s (`hook timed out after 5s`) — §4 |
| A hook that fails, exits 2, prints a decision, or is async | **a sync hook can deny for the user**; Overmind's hook is async — §4 |

`trusted_hash` is Codex's own hash of the hook; Overmind does not reproduce it. A hook `install`
rewrote keeps the old entry at the same key until the user accepts the review (§4: a changed hook
is a new hash), so `codex hooks status` compares that entry with the one `install` recorded.

## 3. Menu, interrupt and resume

| Check | Result |
| --- | --- |
| Option 1 (Enter) | `✔ You approved codex to run … this time`; runs |
| Option 2 (Down, Enter) | `✔ You approved codex to always run commands that start with …`; adds one `prefix_rule(… decision="allow")` line to `~/.codex/rules/default.rules` for every session on the host (removed after the test) |
| Option 3 (Down Down Enter) | `✗ You canceled the request …`, `■ Conversation interrupted` — ends the turn like Esc, no inline text field |
| Hotkeys `(y)` / `(p)` / `(esc)` | not needed: the arrow keys reach every option |
| Approved `sleep 20 && …` answered in the TUI | the row reads `busy` on the next forced list, `idle` when it ends; the card's answer gets 409 and types nothing |
| Esc on a busy daemon-mode turn, then SIGTERM (web close) | `custom_tool_call_output "aborted by user"`, `turn_aborted interrupted` before the TUI went. The running tool process (`sleep 30`, a daemon child) was not stopped by the abort and ended on its own |
| Esc on a busy embedded-mode turn, then SIGTERM (web close) | same: `turn_aborted interrupted`, and the turn's `sleep 30` stayed alive, reparented to pid 1. So neither Esc nor SIGTERM stops a tool process the turn started, in either mode — the web close stops it itself since #34 phase 5 (§6) |
| Esc on a waiting embedded-mode row (menu = "No"), then SIGTERM | same `turn_aborted interrupted` |
| Embedded TUI killed mid-turn (`sleep 45`), then `codex resume <id>` | **resume writes nothing** before the first prompt: the rollout's last line stays the open turn's `custom_tool_call` until the next prompt, ten minutes later. The resumed row reads `idle` (open turn, nothing written since this process started) |

## 4. A hook that fails

One project `.codex/hooks.json` per variant (a `PermissionRequest` group only, `timeout: 5`) in a
throwaway dir without `.git`, a fresh embedded TUI (`-s read-only -a on-request`) per variant,
trusted through Codex's own folder-trust and hook-review prompts; the prompt asks for one
escalated `printf … > file`. Times are from the hook's start to the screen.

| Variant | `/hooks` shows | What Codex does | Time |
| --- | --- | --- | --- |
| Command not found (`…/does-not-exist/overmind _codex-hook`) | Sync, 5s | `• Hook failed └ hook exited with code 127` (hooks run through a shell, so no spawn error), then the **normal menu** | immediate |
| `sleep 10`, `timeout: 5` | Sync, 5s | `hook timed out after 5s`, hook process killed (its line after `sleep` never written), then the **normal menu** | 5 s blocked |
| Exit 2, a stderr line | Sync, 5s | **`• Blocked by hook └ <stderr>`: denied, no menu** — the model reads "Automatic approval review rejected it" | immediate |
| Prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"deny"}}` (PreToolUse shape) | Sync, 5s | `Hook failed └ hook returned invalid permission-request JSON output`, then the **normal menu** | immediate |
| Prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"…"}}}` (Claude Code's shape) | Sync, 5s | **`Blocked by hook └ <message>`: denied, no menu** | immediate |
| `"async": true`, `sleep 10` | **Async**, 5s | the **normal menu** at once (it was on screen before the hook's first line), the full payload delivered on stdin, no failure line; the script is still stopped by the timeout | 0 s |
| `"async": true`, prints the `decision: deny` above **and** exits 2 | Async, 5s | the **normal menu**: output and exit code ignored | 0 s |

So a **sync** `PermissionRequest` hook decides for the user on exit 2 — clap's exit code for an
unknown subcommand, i.e. what an overmind build without `_codex-hook` at the hooked path returns —
and on a Claude-shaped `decision`. Overmind installs its hook with `"async": true`: the sidecar
arrives a few ms after the menu (the screen is the truth anyway), and no binary at that path can
block or decide. A changed hook (sync → async, a moved binary) is a new hash: Codex asks for review
again at the next start. A hook that is not trusted does not run at all (one mis-trusted run above:
the menu, no hook line).

## 5. Patch and MCP approvals (#34 phase 5)

Checked live on 2026-11-06 against the Codex `0.166.0` TUI (daemon mode, and embedded with
`-c model_reasoning_effort=medium`), a temp `CODEX_HOME`, `-a on-request -s read-only`, and a mock
Responses API that scripts the calls (the account has no credits): `PATCH: <files>` emits an
`apply_patch` `custom_tool_call` (or `tools.apply_patch("…")` in a code-mode `exec`), `MCP: <tool>
<args>` an MCP call on a tiny local stdio server (`[mcp_servers.tiny]` in the temp config: a
`write_note` tool, and a `readOnlyHint` `echo`). Screens are committed as fixtures (paths replaced;
the 90-column ones re-wrapped the way Codex wraps them): `web/tests/fixtures/codex-approval-patch.txt`,
`codex-approval-patch-wrapped.txt`, `codex-approval-mcp.txt`, `codex-approval-mcp-narrow.txt`.

| Check | Result |
| --- | --- |
| Patch menu | `Would you like to make the following edits?`, `Description: Apply proposed file edits`, one `Destination: <abs path>` per file (the label alone and the path hard-wrapped below it when it does not fit), then `› 1. Yes, proceed (y)` / `2. Yes, and don't ask again for these files (a)` / `3. No, and tell Codex what to do differently (esc)`, footer `Press enter to confirm or esc to cancel`. The diff is drawn *above* the menu, in the history (`• Edited 2 files (+3 -0)` … `+ Show details`) |
| Patch option 2 | approves; the same files are then patched without asking for the rest of the session; nothing is written to `config.toml` or `rules/` |
| Patch option 3 / Esc | `■ Conversation interrupted`, `custom_tool_call_output "aborted by user"`, `turn_aborted` — ends the turn |
| Patch rollout | the `apply_patch` call (or the code-mode `exec`) with no output while the menu shows: the rollout trigger |
| Patch hook | `PermissionRequest` with `tool_name: "apply_patch"` fired in the live server run, not in an earlier probe right after trusting the hooks — so the rollout is the trigger to rely on |
| MCP menu | an elicitation form: `Field 1/1`, `Allow the tiny MCP server to run tool "write_note"?`, one `key: value` line per argument (cut to the width with `...`), `› 1. Allow  Run the tool and continue` / `2. Allow for this session` / `3. Always allow` / `4. Cancel` (label and description in columns, a long description wrapped under its column), footer `enter to submit \| esc to cancel` |
| MCP option 3 "Always allow" | writes `[mcp_servers.tiny.tools.write_note] approval_mode = "approve"` to `config.toml` (the temp one; restored after) — every later call, every session |
| MCP option 2 | remembered by that TUI's session only; `config.toml` unchanged |
| MCP option 4 / Esc | `Failed tiny.write_note └ Error: user cancelled MCP tool call`; the turn goes on |
| MCP hook | `PermissionRequest` with `tool_name: "mcp__tiny__write_note"`, no `command` |
| MCP call shapes | code mode calls it as `tools.mcp__tiny__write_note({…})` inside `exec`; a bare `function_call` `mcp__tiny__write_note` is `unsupported call` in 0.166's code mode. A `readOnlyHint: true` tool runs without asking |
| Exec outside code mode | an `exec_command` `function_call` with `sandbox_permissions: "require_escalated"` shows the usual exec menu (embedded mode; code mode's `exec` timed out negotiating with its code-mode host there) |

Answered from the web by menu index with the exec card's checks (the id, `untouched`, the cursor
read again before every key, a fresh list and the row's `approval_id` in the card id): yes / these
files / no on patches, allow / session / always / cancel on MCP each picked exactly the option
(tmux log: `Enter`, `Down Enter`, `Down Down Enter`, `Down Down Down Enter`); a ↓ pressed in the
terminal first, a wrong card id and a stale card (the same files asked again by another call) each
got 409 with no key sent. Waiting showed 1–2.5 s after the prompt.

## 6. Tool processes and closing a row

| Check | Result |
| --- | --- |
| Where a tool runs | `<shell> -c <cmd>` (`-lc` outside code mode), its own process group, a direct child of a codex process: in daemon mode the app-server daemon (`app-server --managed-daemon`), which is itself a child of the **TUI that started it** and serves every later pane on the host; in embedded mode the TUI itself |
| A command that runs past `exec_command`'s yield | the call returns, the turn ends (`task_complete`, row `idle`) and the process keeps running |
| Daemon mode, the pane closed | Codex's daemon ends that thread's running commands ~60 s after its TUI goes (`item_completed CommandExecution`, `source: "unified_exec_startup"`, `status: "failed"`, `exit_code: -1`; measured 62 s) |
| Embedded mode, the pane closed | the command is reparented to pid 1 and runs to its end (§3) |
| `ps -E` | shows no environment of these processes, so `CODEX_THREAD_ID` cannot tell whose a tool is; `ps` prints a newline in the args as `\012` |
| Daemon mode, whose shells | the daemon serves every pane on the host, and is a child of the pane that started it only until that pane goes (then pid 1; a managed daemon `codex app-server daemon` runs under launchd from the start). Two panes on one checkout run the same `npm test` / `npm run dev` under it — command, cwd and start time cannot tell whose a shell is |
| What a web close stops | **embedded mode only**: the TUI's own `<shell> -c` children running a command of the row's **current turn**, for a busy or waiting row. Daemon mode: nothing (Codex ends the thread's commands ~60 s later, above). An idle row: nothing — a dev server the user asked for keeps running |

## 7. Open

- iTerm rows: covered by unit tests only (one osascript peek, only while the hook's approved
  command has not run).
- Daemon mode: a close stops no tool process; Codex ends a closed thread's commands ~60 s after
  its TUI goes (§6). An embedded row's commands from an earlier turn are never stopped by a close.
