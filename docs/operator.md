# Voice operator: latency and harnesses

Notes from measuring the [voice operator](architecture.md#voice-operator) end to end (October
2026, a workstation on the tailnet, phone network excluded). Numbers are wall-clock medians of a
few runs; they move with model load, but the proportions hold.

## Where a question's time goes

| Step | Before | After (`operator-latency`) | Notes |
| --- | --- | --- | --- |
| Speech to text (`/api/transcribe`, gpt-4o-transcribe) | 0.7–1 s | same | for a 4–5 s question |
| Send → operator busy | ~0.2 s send, status flips after ~2.5 s | same | the screen shows "Thinking…" at once |
| Model + tools, "what's in my inbox" | Fable 14–30 s, Opus 11–16 s, Sonnet 10–12 s | Fable 8–14 s, Sonnet 7–11 s | 2 turns: one `./api GET /inbox`, then the answer |
| Model + tools, "who is waiting on me" | Fable 19–46 s (4–5 turns), Sonnet 9–11 s | Fable ~7–12 s, Sonnet 5–10 s (2 turns) | the brief's one-command recipe |
| Final reply → status idle | 0.6–2.2 s | 0 (read on the final message) | the screen used to wait for idle |
| Text to speech before the first sound | 5–12 s (whole reply, ~1 s per 90 chars) | 0.8–3 s (first piece) | OpenAI starts streaming after ~0.6 s, the server buffered it all |
| Reply length | 750–1200 chars (45–75 s of audio) | 300–450 chars | "under 400 characters" in the brief |
| **Question → first sound** | **17–25 s typical, 60 s+ on long turns** | **7–11 s** | |

Tools themselves are not the bottleneck: `./api GET /overmind`, `/inbox` and `messages` answer in
50–80 ms. The slow ones are `overmind prs` (~10 s) and `overmind list --all-hosts`, which ssh-es to
each host with an ssh destination and waits out `OVERMIND_CONNECT_TIMEOUT` (5 s) on one that is
asleep — and sees only hosts with an ssh destination, so on a machine whose config has none it
reports just itself. The web snapshot (`/api/overmind`) has neither problem.

The model's time is mostly the number of turns (each one 2.5–6 s of model time), then the
model: Fable 5.1 costs 0.4–0.6 USD a question against 0.01–0.10 for Sonnet 5.5, and is 1.5–3×
slower. `--effort low` changed little. Startup MCP servers (~45 claude.ai connectors, ~130 tools)
add ~10k tokens of context and ~2 s to a cold start, but a running operator pays that once.

## Running the operator on Codex or pi

What the operator needs from a harness, and where each one stands:

| Need | Claude Code | Codex | pi |
| --- | --- | --- | --- |
| Reads the brief | `CLAUDE.md` | `AGENTS.md` only | `AGENTS.md` and `CLAUDE.md` |
| Runs `./api`, `overmind`, `jq` without prompts | `.claude/settings.json` allow list | `--dangerously-bypass-approvals-and-sandbox` (or `-s danger-full-access -a never`) | no approvals by default |
| Reaches the local web API | yes | **not in the default sandbox**: `./api` fails to connect and `overmind list` returns `[]` silently | yes |
| Turn end is reliable for "read it now" | `stop_reason` on every transcript line | `task_complete`; assistant text is final only until a tool call follows | last message not a tool call |
| `/clear` (auto-clear) | yes | `/new` | `/new` |
| Found by `lib/operator.mjs` | yes | no: `isOperator` and `ensure()` assume Claude | no |

So a Codex operator needs: an `AGENTS.md` next to `CLAUDE.md`, a launch with the sandbox off,
`isOperator`/`ensure()` to take the harness from `web.operator.harness`, the auto-clear command
per harness, and the screen to keep waiting for idle on non-Claude harnesses (it does).

## Connectors outside Claude Code

The claude.ai connectors (`claude mcp list` shows them as `claude.ai <name>`) are proxied by
Anthropic with tokens held by claude.ai; Codex and pi cannot use them. The servers behind most of
them are public MCP endpoints, though, and can be added directly with your own credentials:

| Connector | Endpoint | Auth for a direct client |
| --- | --- | --- |
| Productive (ai-agent) | `https://ai-agent.productive.io/mcp` | bearer = base64 of `{organization_id, person_id, user_id, user_email, personal_access_token}` (a read/write personal token) — no browser |
| Productive (public) | `https://mcp.productive.io/mcp` | OAuth with dynamic client registration: `codex mcp login` / `pi mcp login` |
| Slack | `https://mcp.slack.com/mcp` | OAuth, **no** dynamic registration: needs an internal Slack app with MCP enabled, its client id and secret |
| Gmail, Calendar, Drive, Docs, Sheets | `https://{gmail,calendar,drive,docs,sheets}mcp.googleapis.com/mcp/v1` | Google OAuth, no dynamic registration: needs a Google Cloud OAuth client (desktop) with those APIs enabled |
| Claude Docs | Anthropic only | not portable |

Codex logged in with ChatGPT also has its own app connectors (the built-in `codex_apps` MCP
server), a separate set from claude.ai's.
