# Web UI idle-CPU harness

`idle-cpu.mjs` loads the web UI in headless WebKit against the demo API (`scripts/guide/mock.mjs`
with `GUIDE_FREEZE=1`: every poll answers a byte-identical body) and measures the CPU the browser
spends while the page sits idle. It is how #36's numbers in [docs/perf-research.md](../../docs/perf-research.md)
were taken; rerun it before and after a change that touches polling or rendering.

```sh
cd scripts/perf && npm install && npx playwright-core install webkit   # once
npm --prefix ../../web/ui run build                                   # the dist it measures
node idle-cpu.mjs [--dist ../../web/ui/dist] [--runs 3] [--idle 60] [--only list|session|mobile] [--json]
```

- Scenarios: `list` (desktop shell, 1440×900), `session` (desktop shell with a session open),
  `mobile` (the list at 390×844). Each run is a fresh browser: load, wait for the ready text,
  settle 2 s, then idle for `--idle` seconds.
- Output: one JSON line per run (`idleCpuS`, `idleCorePct`, `idleRequests`, `readyMs`, `loadCpuS`)
  and the median per scenario. Runs spread ±50 %, so compare medians of 3+ runs, before and after
  on the same machine.
- CPU is the summed time of the `ms-playwright/webkit` processes this run's browser started (told
  apart by pid, `lib.mjs`), so another Playwright WebKit on the machine is not counted (before #39 it
  was, and could triple a run). Its load still slows ours: run nothing else heavy meanwhile. The mock
  listens on 127.0.0.1:7798.
- To compare against another commit, build that commit's `web/ui` in a separate worktree and pass
  its `dist` with `--dist`.

## Interaction latency (`interaction.mjs`, #39)

`interaction.mjs` loads the desktop shell (1440×900) on a session, against the same frozen mock,
and drives real input: it clicks `--switches` sidebar rows in turn (6 sessions, 400 ms apart), then
types `--chars` characters into the open session's composer (40 ms apart).

```sh
node interaction.mjs [--dist ../../web/ui/dist] [--runs 5] [--switches 30] [--chars 120] [--json]
node interaction.mjs --renders [--runs 3]   # React commits / component renders per phase
```

- Latency per input, INP-style: from a capture-phase listener on `window` (before React's) to the
  first task after the next animation frame. Per phase: p50 / p95 / max, and `cpuS` (this browser's
  WebKit CPU). `settledP50`: click → the last DOM mutation within 1 s (the new pane's fetches and
  follow-up renders included).
- `--renders` installs a stub React DevTools hook before load and counts commits and the components
  that rendered (fibers with React's PerformedWork flag; a subtree React bailed out of is skipped).
  The hook walks the tree on every commit, so its timings are not comparable: run it on its own.
- Also prints the dist's JS / CSS size (raw, gzip -9, brotli).
- Compare builds interleaved (before, after, before, after…) and read medians: per-run p50s spread
  ±25 %.

## Web server CPU (`server-cpu.mjs`, #38)

`server-cpu.mjs` runs `web/server.mjs` under `/usr/bin/time -l` (user + sys include its reaped
children — every `overmind list` and what that runs), GETs `/api/overmind` every 5 s like the UI,
stops it with SIGTERM and prints one JSON line: node+children CPU, `overmind list` runs (counted
by an `OVERMIND_BIN` wrapper; `/api/health.discovery.listRuns` too), CPU s/min, % of a core, busy
rows at start/end. No npm dependencies.

```sh
node scripts/perf/server-cpu.mjs --scenario fleet --watch 0 --seconds 300 --json   # before (kill-switch)
node scripts/perf/server-cpu.mjs --scenario fleet --watch 1 --seconds 300 --json   # after
node scripts/perf/server-cpu.mjs --scenario burst --watch 1 --seconds 300 --list-delay 0.5 --json
node scripts/perf/server-cpu.mjs --scenario idle --watch 1 --seconds 300 --list-delay 0.2 --json
node scripts/perf/server-cpu.mjs --scenario latency --watch 1 --seconds 120 --json [--burst-latency]
node scripts/perf/server-cpu.mjs --scenario codex --watch 1 --seconds 130 --json
node scripts/perf/server-cpu.mjs --scenario exec --watch 1 --seconds 130 --json
```

- `fleet`: this machine's real sessions, read-only whatever the config says. Bound to 127.0.0.1 on
  `--port` (default 7897, never 7878/7999).
  - **Only `overmind list` runs.** The `OVERMIND_BIN` wrapper runs the real CLI for `list` and
    refuses every other subcommand (restore, send, kill, name, stack sync, …): it exits 1 and logs
    it, and the result's `refused` lists them. It should be empty.
  - **A scrubbed config.** The server reads a copy (`OVERMIND_CONFIG`) holding only your
    `web.discovery`, with uploads and memos in the temp dir: no hosts or peers, no `restore.onBoot`,
    operator, jobs, slack, inbox, grouping or briefs.
  - Autoname, grouping, briefs, inbox, slack and stacks sync are also off by env.
  - **No real state is written.** The server's own state goes to a temp `XDG_STATE_HOME`. `list`
    is not read-only (it records the snapshot), so the wrapper runs it with the real state dir and
    the real config (read only: host name, `restore.keepClosedDays`, naming), no `OVERMIND_HOST`,
    and `OVERMIND_SNAPSHOT` pointing at a temp copy of your `snapshot.json`. It does the same work
    as production, into a file the harness owns. The result's `snapshot` says whether the temp copy
    was written (`tempWritten`) and whether the real one changed (`realChanged`: only another
    writer, such as your running server, can change it).
- `burst`: a temp `HOME` with 3 fake sessions and a fake `overmind` printing their rows;
  transcripts appended 10 lines/s each, a registry rewrite every 20 s. Compare list runs per mode;
  CPU ≈ runs × the per-list cost on the real fleet. `--list-delay <s>` makes each fake list take
  that long, so events land mid-list as they do on a real fleet (use 0.5).
- `idle`: the same temp `HOME`, nothing writes: what a host with no busy session costs.
- `latency`: the same temp `HOME`, a registry rewrite every 10 s; reports write → list start
  (`/api/health` polled every 100 ms). `--burst-latency` keeps the appenders running.
- `codex`: the same temp `HOME` plus a Codex rollout streaming a line every 100 ms. Every 10.7 s
  its turn ends or starts (`task_complete` / `task_started`; `latencyMs`), and every third time a
  rollout appears for a session no list has shown yet, as when `codex` starts in a terminal
  (`newSessionLatencyMs`). Both are write → list start. The fake list reports what the files say.
- `exec`: `idle` plus a headless `codex exec` rollout streaming a line every 200 ms. It is never a
  row, so it should cost what `idle` costs.
- Run modes interleaved (0, 1, 0, 1): the fleet's busy rows change under you.
