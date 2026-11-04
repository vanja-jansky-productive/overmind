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
- CPU is the summed time of every process with `ms-playwright/webkit` in its command line, so run
  nothing else on Playwright's WebKit meanwhile. The mock listens on 127.0.0.1:7798.
- To compare against another commit, build that commit's `web/ui` in a separate worktree and pass
  its `dist` with `--dist`.

## Web server CPU (`server-cpu.mjs`, #38)

`server-cpu.mjs` runs `web/server.mjs` under `/usr/bin/time -l` (user + sys include its reaped
children — every `overmind list` and what that runs), GETs `/api/overmind` every 5 s like the UI,
stops it with SIGTERM and prints one JSON line: node+children CPU, `overmind list` runs (counted
by an `OVERMIND_BIN` wrapper; `/api/health.discovery.listRuns` too), CPU s/min, % of a core, busy
rows at start/end. No npm dependencies.

```sh
node scripts/perf/server-cpu.mjs --scenario fleet --watch 0 --seconds 300 --json   # before (kill-switch)
node scripts/perf/server-cpu.mjs --scenario fleet --watch 1 --seconds 300 --json   # after
node scripts/perf/server-cpu.mjs --scenario burst --watch 1 --seconds 300 --json
node scripts/perf/server-cpu.mjs --scenario latency --watch 1 --seconds 120 --json [--burst-latency]
```

- `fleet`: this machine's real sessions and config, read-only — autoname, grouping, briefs, inbox,
  slack and stacks sync off, bound to 127.0.0.1 on `--port` (default 7897, never 7878/7999); the
  server's own state goes to a temp `XDG_STATE_HOME` while the CLI gets the real one, so `list`
  reads and records `snapshot.json` as in production. Peers in the config are polled as usual.
- `burst`: a temp `HOME` with 3 fake sessions and a fake `overmind` printing their rows;
  transcripts appended 10 lines/s each, a registry rewrite every 20 s. Compare list runs per mode;
  CPU ≈ runs × the per-list cost on the real fleet.
- `latency`: the same temp `HOME`, a registry rewrite every 10 s; reports write → list start
  (`/api/health` polled every 100 ms). `--burst-latency` keeps the appenders running.
- Run modes interleaved (0, 1, 0, 1): the fleet's busy rows change under you.
