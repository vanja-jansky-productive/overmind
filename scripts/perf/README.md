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
