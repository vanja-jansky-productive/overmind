# Codex 0.166 — approvals, hooks and the daemon (live findings)

What issue #34 phase 1a builds on, checked live on 2026-11-04 against Codex `0.166.0` on the
real `~/.codex` (one throwaway tmux session in a directory without `.git`, `-s read-only -a
on-request`; the app-server daemon was running the whole time and never restarted). The phase 0
spike before it is summarised in §1. Evidence paths point into the run's scratch directory
(`loop-34/live/`: screen snapshots, acceptance logs), which is not part of the repo.

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
  Nothing fires when the approval is answered; the next rollout line for the call says so.

Hence Overmind's rule: the hook or the rollout only *triggers* a look; the screen decides.

## 2. Hooks

| Check | Result | Evidence |
| --- | --- | --- |
| `overmind codex hooks install` on a hooks.json with a user `PostToolUse` group | one group appended to each of `PermissionRequest`, `Stop`, `UserPromptSubmit`; the user's group untouched | `loop-34/live/01-install.txt`, `02-status-before-trust.json` |
| Trust | the next TUI start shows "Hooks need review — 3 hooks are new or changed"; "Trust all and continue" writes `[hooks.state."<abs hooks.json>:<event>:<group>:0"] trusted_hash` to `config.toml` | `03-start-daemon.txt`, `04-trusted.txt` |
| **Daemon mode** (TUI without `-c`, daemon started hours before hooks.json) | **the hook fires**: a sidecar for the new session at the approval, no daemon restart. Sessions already running when hooks.json changed keep the hook set they started with (om-40, running since before the install, never wrote one) | `snaps/222912-d1-daemon-waiting.txt` (3 warnings = daemon), `accept-a1-daemon-hook-card.log` |
| Embedded mode (`-c model_reasoning_effort=medium`) | fires the same | `snaps/223233-e1-embedded-waiting.txt` (4 warnings = embedded), `accept-a1-embedded-hook-card.log` |
| Sub-agent approval | the hook carries the **parent's** `session_id` and the child's `transcript_path`; the **parent's** screen shows the menu, with a `Thread: Agent (<child id>)` line and `… or o to open thread` in the footer. So the parent row waits, through the hook. Without the hook the parent row stays `busy`: the escalated call is in the child's rollout | `snaps/223132-c1-child-approval.txt`, `web/tests/fixtures/codex-approval-child.txt` |
| `_codex-hook` cost (release build, warm) | median 3.5 ms, p90 3.7 ms (first run 310 ms, cold); exit 0 with empty stdout/stderr also on garbage, empty stdin and a path-like `session_id` | measured with `OVERMIND_CODEX_HOOKS_DIR` in a temp dir |
| `uninstall` | removes only Overmind's groups; the user's `PostToolUse` group stays; `[hooks.state]` left alone | `05-uninstall.txt` |
| `timeout` unit | **seconds**: the `/hooks` detail shows `Timeout 5s`, a sync `sleep 10` is killed after 5 s (`hook timed out after 5s`) | §4 |
| A hook that fails, exits 2, prints a decision, or is async | **a sync hook can deny for the user**; Overmind's hook is async | §4 |

## 3. Menu, interrupt and resume

| Check | Result | Evidence |
| --- | --- | --- |
| Option 1 (Enter) | `✔ You approved codex to run … this time`; runs | `snaps/222936-d2-daemon-approved-idle.txt` |
| Option 2 (Down, Enter) | `✔ You approved codex to always run commands that start with …`; adds one `prefix_rule(… decision="allow")` line to `~/.codex/rules/default.rules` for every session on the host (removed after the test) | `snaps/223041-m2-after-option2.txt` |
| Option 3 (Down Down Enter) | `✗ You canceled the request …`, `■ Conversation interrupted` — ends the turn like Esc, no inline text field | `snaps/223109-m3-after-option3.txt` |
| Hotkeys `(y)` / `(p)` / `(esc)` | not needed: the arrow keys reach every option | — |
| Approved `sleep 20 && …` answered in the TUI | the row reads `busy` on the next poll, `idle` when it ends; the card's answer gets 409 and types nothing | `accept-a1b-a3-tui-approved-sleep.log` |
| Esc on a busy daemon-mode turn, then SIGTERM (web close) | `custom_tool_call_output "aborted by user"`, `turn_aborted interrupted` before the TUI went. The running tool process (`sleep 30`, a daemon child) was not stopped by the abort and ended on its own | `accept-a4-kill-busy-daemon.log` |
| Esc on a waiting embedded-mode row (menu = "No"), then SIGTERM | same `turn_aborted interrupted` | `accept-a4-kill-waiting-embedded.log` |
| Embedded TUI killed mid-turn (`sleep 45`), then `codex resume <id>` | **resume writes nothing** before the first prompt: the rollout's last line stays the open turn's `custom_tool_call` (21:32:58Z) until the next prompt (21:42:23Z). The resumed row reads `idle` (open turn, nothing written since this process started) | `snaps/223303-k1-embedded-busy-sleep.txt`, `snaps/223331-s1-resumed-after-crash.txt`, archived rollout `01a1a87a-…` lines 36–38 |

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

## 5. Open

- `apply_patch` and other non-exec approvals: untested; their screen is not the exec menu, so
  such rows stay `busy`.
- iTerm rows: covered by unit tests only (one osascript peek, only when the hook triggered).
