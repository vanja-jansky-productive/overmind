# Lessons

Lessons are what sessions learn about doing their work: a rule, why it matters, and the quote that
taught it. Overmind keeps them on each host, puts the few that fit into a new session's context,
and trades them with other people's agents in the portable `agent-memory` JSONL format (schema 1).
Issue #29.

## The record

One lesson is one schema-1 line ([format below](#agent-memory-jsonl-schema-1)), stored as is:

| field | meaning |
| --- | --- |
| `id` | `<handle>/<persona>#<n>` — yours get `lessons.handle` (default `$USER`); an imported one keeps its source id |
| `kind` | `approach` (default), `friction`, `intuition`, `style`, `fluency`, or any other word |
| `title`, `rule`, `consequence` | a short name; what holds ("When X, do Y"); what goes wrong without it |
| `scope`, `repo` | `global`, or `repo` with `repo: "owner/name"` |
| `tier` | `0` always injected, `1` injected when it fits (default), `2` only found by `lesson search` |
| `status` | `active` or `retired` (with `retired_reason`, `retired_at`) |
| `confidence` | 0–1. Learned on purpose: 0.7; accepted from mining: 0.5; imported: 0.3. `confirm` adds 0.05 (up to 0.95) |
| `occurrences` | times it was seen or confirmed |
| `evidence[]` | `{ kind: session \| confirm \| manual, quote, at, session? }` — `session` is the Claude session id, the link back (`claude --resume <id>`) |

Overmind adds two fields of its own: `origin` (`manual`, `mined`, `imported`) and `adopted_from`
(the file an imported lesson came from). Readers of the format ignore fields they do not know.

## Where it lives

`$OVERMIND_LESSONS_FILE`, else `${XDG_STATE_HOME:-~/.local/state}/overmind/lessons.json`:

```json
{ "version": 1, "next": 13, "lessons": [], "proposals": [], "rejected": [], "adopted": [], "mined": {} }
```

- `proposals`: lessons mined from finished sessions, waiting for `accept` or `reject`.
- `rejected`: every rejected proposal's title, rule and reason. With the retired lessons, this is
  the memory that stops the miner proposing the same thing again.
- `adopted`: every id ever imported, so a lesson is never adopted twice, even after you retire it.
- `mined`: session id → transcript bytes already mined, so a resumed session is mined only for
  what it added.

Writes take a file lock and replace the file atomically. One store per host: `-H <host>` reaches
another host's.

## Getting them in

- **On purpose:** `overmind lesson learn --rule … --consequence … [--title] [--quote]`. Inside a
  Claude session the evidence links back to it on its own (`$CLAUDE_CODE_SESSION_ID`). Active at
  once.
- **Mined at close:** the `SessionEnd` hook starts `overmind lesson mine` in the background. It
  compacts the transcript (prompts, replies, tool errors; from where the last mine stopped), asks
  `claude -p` (`lessons.mineModel`, default `sonnet`) for at most 3 lessons, and queues them as
  proposals. A proposal is dropped when its evidence quote is not in the transcript (no invented
  evidence), or when it looks like a rejected or retired lesson. One that looks like an active
  lesson confirms that lesson instead (occurrences + 1). Sessions with fewer than 3 prompts are
  not mined.
- **Accepted by you:** `overmind lesson proposals`, then `accept <pid>` (optionally changing
  tier, kind, scope, …) or `reject <pid> --reason …`.
- **Imported:** `overmind lesson import <file.jsonl>…` adopts active lessons scoped `global` or to
  a repo you work in (a repo under `repos.roots`, a repo one of your lessons names, or `--repo`),
  at confidence 0.3 and never tier 0, never twice by id.

## Getting them back

`overmind lesson hook` is a Claude Code hook (reads the hook JSON on stdin; fails open, prints
nothing on any error):

- `SessionStart` → up to **5** lessons as `additionalContext`: every tier-0 lesson in scope first,
  then tier-1 lessons by score. A lesson is in scope when it is `global` or its repo is the
  session's repo (from the cwd's `origin`).
- `UserPromptSubmit` (optional) → on the session's first prompt only, up to 3 more lessons that
  fit the prompt, never one already injected.
- `SessionEnd` → starts the miner (above).

Headless sessions (`claude -p`, `CLAUDE_CODE_ENTRYPOINT=sdk-*`) and `OVERMIND_LESSONS=off` get
nothing and are never mined.

**Score** (tier 1): text relevance (a BM25-style match of the task text — repo name, branch,
the session's brief, the first prompt; generic task verbs like fix/add/run are ignored — against the lesson's title, rule and consequence) + 1 for a
lesson of this very repo + 0.5 × confidence + 0.1 × ln(1 + occurrences). A tier-1 lesson is a
candidate only when it is about this repo or matches the task text — two distinct task words, one
of them rare among the lessons (in at most a tenth of them), so "fix" + "test" alone match nothing.
At a bare `SessionStart` in a new repo, only tier 0 comes back. `overmind lesson recall [--task …]` shows what a session here
would get, with scores.

The injected block names the commands that close the loop: `lesson show <id>` (evidence),
`lesson confirm <id>` when a lesson held, `lesson retire <id> --reason …` when it misled.

## agent-memory JSONL (schema 1)

One object per line, sorted by `id`: `schema` (1), `id`, `persona`, `persona_hash`, `kind`,
`title`, `rule`, `consequence`, `scope`, `repo`, `tier`, `status`, `confidence`, `occurrences`,
`uses`, `first_seen_at`, `last_confirmed_at`, `last_used_at`, `retired_at`, `retired_reason`,
`evidence[] { kind, quote, at }` (+ overmind's `session`). Timestamps are ISO 8601 UTC.

`overmind lesson export [--out <dir>]` writes your own lessons (never imported ones): JSONL on
stdout, or one `<persona>.jsonl` per persona into a directory. Evidence quotes that look like
secrets or personal data (tokens, keys, emails, private IPs) are left out and home paths become
`~`.

## Install

`overmind lesson hook --print-config` prints the `hooks` block for `~/.claude/settings.json`
(`SessionStart`, `UserPromptSubmit` and `SessionEnd`, each `overmind lesson hook`, timeout 10s);
merge it into the hooks you have. Leave `UserPromptSubmit` out for start-time lessons only, and
`SessionEnd` out (or set `lessons.mine: false`) for no mining.

Config (`lessons` in `config.json`, all optional): `handle`, `persona` (default `claude`),
`mineModel` (default `sonnet`), `mine` (default `true`; `false` keeps the `SessionEnd` hook
from mining).

## Borrowed from Lapidary, and where this differs

Borrowed: the record (rule + consequence + evidence quote), the schema-1 line format and its
import rules, tiers, the proposal queue that needs consent, remembered rejections and
retirements, mining once per session at close from a byte offset, confirm → occurrences.

Different:

- **Store**: one JSON file per host, not SQLite — the rest of overmind's state is JSON files and
  the CLI has no database dependency. Fine for hundreds of lessons.
- **Tier 0 is capped** by the same 5-lesson budget (Lapidary: 80 lines); tier 2 is "search only"
  (Lapidary's export README: "kept out").
- **Selection by relevance**: Lapidary injects tier 0 and leaves tier 1 as a catalogue the agent
  reads; overmind ranks tier 1 against the repo and task and injects the best few.
- **Capture**: no lexical (swearing, hedged predictions) or structural (`Stop`) hooks, no hourly
  consolidation pass, no per-origin accept/reject counts yet — the miner and `learn` only.
- **Evidence** carries the session id, so every lesson links back to its thread.
- **Personas**: overmind sessions are generalists; persona is kept on the record and in exports,
  but selection ignores it.
