# UI performance research (Nov 2026)

Answer to [#35](https://github.com/vanja-jansky-productive/overmind/issues/35): what makes the Overmind UI
cost what it does, and which stack would make it faster. Measured first, on `main` at `2f930e5`, with
real session data (9 sessions, one host).

## TL;DR

- **The stack is not the problem.** Overmind.app is already Tauri 2 on the system WKWebView, not
  Electron. Cold start to an interactive session is ~250 ms in WebKit on an M-series Mac.
- **The idle cost is our own re-renders.**
  - Three top-level components re-render the whole UI **every second** to update "Xs ago" text.
  - Every poll swaps in a new state object even when nothing changed.
  - Fixing just that cut idle CPU by **~80%** in WebKit (1.97 → 0.41 s of CPU per minute with a session open).
- **A framework switch is not worth it.** On js-framework-benchmark, Solid and Svelte are ~25–30% faster than React on DOM work. Our measured win from render hygiene is ~80%, for a day's work instead of a 4–10 week rewrite.
- **Code splitting** halves the startup JS (1.36 MB → 0.73 MB), but gave no measurable load gain on the
  desktop. It's worth it only for the phone over Tailscale, and it needs chunk tuning.
- **Push (SSE) instead of polling** barely helps client CPU once renders are fixed. Its value is
  latency, server CPU (the server re-runs `overmind list` every 3 s while anyone watches) and
  bandwidth (each chat poll re-downloads the whole conversation: ~750 KB/min per open session).

## What runs today

| | |
| --- | --- |
| Shell | Tauri 2 (`crates/overmind-desktop`) around WKWebView |
| UI | React 19, Vite 8, Tailwind 4, shadcn/Radix, xterm.js; ~38k lines |
| Bundle | one 1.36 MB JS file (386 KB gzip) + 140 KB CSS |
| Data | HTTP polling: session list 5 s, chat 3 s, plus slack, dormant, brief, tasks, PRs; 19 req/min on the list, 40 req/min with a session open |

Bundle composition, by minified bytes attributed through the sourcemap:

| Source | Share | Note |
| --- | --- | --- |
| `@xterm/xterm` | 21% | only the live terminal uses it |
| `react-dom` | 15% | |
| app `lib/` + hooks | 10% | |
| lucide, sonner, vaul, `cn`, Radix | ~10% | |
| every other screen | rest | all loaded at startup |

## Measurements

### Real app, as used (Overmind.app, 5 days uptime)

| Process | CPU over 5 days | CPU per minute in the foreground |
| --- | --- | --- |
| WebKit WebContent (the UI) | 45 min | 2.26 s (3.8% of a core) |
| `overmind-desktop` (Tauri shell) | 12.7 min | 0.87 s (1.5%) |
| `node server.mjs` | 2.4 min | 0.06 s |

The server's real cost is in its children: while anyone is watching, it re-runs
`overmind list --json` every 3 s (`lib/snapshot.mjs`), and each run takes ~0.10 s of CPU. That's ~3.5% of a core.
Altogether, keeping the dashboard current costs **~9% of a core** continuously.

Every API endpoint answers from cache in < 5 ms, so the server is not a latency problem.

### Prototypes

All prototypes were measured against the same live data, served by a throwaway server.
- **WebKit:** Playwright WebKit 26, headless; CPU is the sum over its WebContent, Networking and GPU processes.
- **Chromium:** headless shell with the CPU throttled 4× as a phone stand-in.

| | What changed |
| --- | --- |
| **A** | `main` as is |
| **B** | the three `useNow(1000)` clocks (`DesktopShell`, `ListScreen`, `SessionScreen`) tick every 30 s (stand-in for moving the clock into a tiny `<Ago>` component); the session-list and chat polls keep the previous state when the data is unchanged; the unused `refreshing` flag is no longer toggled on every poll |
| **C** | B + route-level code splitting (every screen except list and session, plus `LiveTerm`/xterm, behind `React.lazy`) |
| **D** | B + session-list and chat polls stretched to 60 s (approximates push when nothing changes) |

**Idle, 60 s, CPU seconds per minute:**

| | WebKit, list | WebKit, session open | Chromium 4×, session open |
| --- | --- | --- | --- |
| A | 1.22 | 1.91 – 1.97 | 1.64 |
| B | **0.28** | **0.41 – 0.59** | **0.27** |
| D | – | 0.45 – 0.63 | – |

The Chromium profile of A's idle minute shows where the time goes: `react-dom` 40% of JS self
time, then lucide icon creation, Radix, the shortcut and dialog components. That is reconciliation,
not network or JSON. Chromium spends ~8× less CPU than WebKit on the same page, so the real app (WebKit) pays more for every needless render.

**Cold load to an interactive session screen, median of 7:**

| | JS loaded | WebKit ready | WebKit CPU | Chromium 4× ready | Chromium 4× script |
| --- | --- | --- | --- | --- | --- |
| A | 1.33 MB | 257 ms | 0.56 s | 408 ms | 228 ms |
| B | 1.33 MB | 249 ms | 0.54 s | 394 ms | 219 ms |
| C | **0.84 MB** | 262 ms | 0.59 s | 525 ms | 291 ms |

Why C doesn't help here:
- The session screen still pulls in shared chunks (sessions, swipe, icons) that the split separated from the main file.
- On a local server with a fast CPU, parsing the extra ~480 KB costs only milliseconds, and the extra chunk requests cancel that out.

## Desk research (frameworks, shells, push)

The frameworks figures are js-framework-benchmark results, Chrome 156 run of Oct 2026, recomputed from the raw data (1.00 = fastest).

| | CPU (weighted) | Runtime brotli | First paint |
| --- | --- | --- | --- |
| Solid 1.9 | 1.14 | 4.5 KB | 54 ms |
| Svelte 5 | 1.19 | 9.7 KB | 66 ms |
| Preact 11 | 1.31 – 1.62 | 6 – 8 KB | 55 – 62 ms |
| React 19.2 | 1.56 | 51 KB | 228 ms |
| React 19 + Compiler | 1.61 | 50 KB | 224 ms |

- **What a switch buys.** React is ~15% of our bundle, so a switch saves ~45 KB brotli and ~25–30% on raw DOM work. Our measured problem was avoidable renders, which every framework would also pay for.
- **Migration cost.** The main driver is the shadcn/Radix layer.
  - Svelte has the best parity (shadcn-svelte / Bits UI).
  - Solid's ports are thinner, and Solid 2.0 is still at RC with breaking changes.
  - Preact is the only near drop-in, but its React 19 compat is unconfirmed.
  - Estimate: 4–10 engineer-weeks.
- **React Compiler 1.0** (stable since Oct 2025): reported 10–30% render and INP gains in real apps. It would mostly auto-memoize what B does by hand. Worth trying after B.
- **Shell.**
  - A native Swift + WKWebView shell runs the same WebContent process, so it would cost the same as Tauri.
  - A fully native SwiftUI client would idle cheaper, but it means a second UI to maintain, and the phone PWA stays.
  - Electron would be heavier (Chromium bundled, ~2× memory).
- **Push.**
  - Under HTTP/1.1, SSE counts toward the ~6 connections per host, so use one multiplexed stream per client, or a WebSocket.
  - iOS drops SSE silently when backgrounded: reconnect on `visibilitychange`/`pageshow` and refetch a snapshot.
  - WKWebView already throttles or suspends timers in a hidden window, so a hidden Overmind.app already polls little.

## Recommendation

| # | Change | Expected | Cost |
| --- | --- | --- | --- |
| 1 | **Render hygiene.** Move every per-second clock into a small `<Ago at>` component. Make polls bail out on unchanged data (overmind, chat, queue, slack, dormant). Stop toggling `refreshing` on background polls. Memoize the session rows. | −75–80% idle UI CPU | ~1 day |
| 2 | **Chat deltas.** `…/messages?after=<ref>` or ETag/304, so an unchanged chat is a 304 and a new message is a few KB | −95% chat bandwidth (~750 KB/min → ~0 per open session) | ~1 day |
| 3 | **Cheaper discovery on the server.** Run `overmind list` when `~/.claude/sessions/` or the transcripts change (`fs.watch`) plus a slow safety refresh, instead of every 3 s | ~3.5% of a core back on each host | 1–2 days |
| 4 | React Compiler (after 1, measure again) | 10–30% render time | hours |
| 5 | Code splitting tuned for the phone (`xterm`, review, notes, memos, operator, settings as separate chunks, with shared chunks kept in the main file) | −35% startup JS on the phone; no desktop gain | ~1 day |
| 6 | One SSE stream per client (session list deltas, chat appends, questions), with polling as the fallback | Updates appear immediately instead of within 3–5 s; fewer requests | ~1 week |
| — | Framework switch (Solid / Svelte / Preact) | Smaller than 1; risky | 4–10 weeks: **not recommended** |
| — | Native shell or client | No gain for the web content; doubles the UI | **not recommended** |

## Caveats

- WebKit numbers come from headless Playwright WebKit 26, not Overmind.app itself. A's idle cost matched the real app (1.97 vs 2.26 s/min), but the shell's own 0.87 s/min was not re-measured after the fixes. It is likely compositor work driven by the same re-renders.
- One machine (Apple silicon), one host, 9 sessions. No real phone was measured; the 4× throttled Chromium stands in for it.
- Prototype B slows the clocks down instead of isolating them, so it's an upper bound on the win from #1.
- The framework figures are Chrome-only micro-benchmarks.
