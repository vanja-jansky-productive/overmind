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
| `timeout` unit | seconds (`timeoutSec` in Codex's hook metadata) — not yet confirmed live | §4 |
| A hook that cannot run (missing binary, timeout, exit 2, prints a decision) | **not yet run live** | §4 |

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

## 4. Open

- The broken-hook matrix (hooks.json pointing at a missing binary, at `sleep 10` with
  `timeout: 5`, at a script exiting 2, at one printing a `deny` decision), the `timeout` unit and
  whether `"async": true` delivers the payload without blocking. The plan runs these only on the
  throwaway session (`-c hooks.*`), and only while the other Codex sessions on the host are idle.
  Until then Overmind's hook relies on its own guarantees: it prints nothing, always exits 0, and
  takes milliseconds.
- `apply_patch` and other non-exec approvals: untested; their screen is not the exec menu, so
  such rows stay `busy`.
- iTerm rows: covered by unit tests only (one osascript peek, only when the hook triggered).
