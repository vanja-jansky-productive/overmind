// Web server CPU and `overmind list` runs while a UI watches — the #38 harness.
//
//   node scripts/perf/server-cpu.mjs --scenario fleet|burst|latency|idle [--watch 0|1] [--seconds 300]
//                                    [--interval 5] [--port 7897] [--list-delay 0.5] [--json]
//
// Starts `web/server.mjs` under `/usr/bin/time -l` (its user+sys include reaped children: every
// `overmind list` and what that runs), GETs /api/overmind every `--interval` s like the UI, stops it
// with SIGTERM after `--seconds`, and reports node+children CPU, list runs (an OVERMIND_BIN wrapper
// counts them; /api/health.discovery.listRuns too), CPU s/min and % of a core. `--watch 0` is the
// kill-switch (OVERMIND_WEB_WATCH=0, the 2 s TTL / list every tick of before #38).
//
// Scenarios:
// - fleet    this machine's real sessions, read-only for any config:
//            - the server gets a scrubbed copy of the config (OVERMIND_CONFIG): only
//              `web.discovery` is kept — no hosts/peers, restore.onBoot, operator, jobs/bots,
//              slack, inbox, grouping, briefs — and uploads / memos point into the temp dir;
//            - autoname / grouping / briefs / inbox / slack / stacks sync are off by env too;
//            - the server's own state (queue, operator workspace, restore marker) goes to a temp
//              XDG_STATE_HOME;
//            - the OVERMIND_BIN wrapper runs the real CLI for `list` only and refuses every
//              other subcommand (logged; reported as `refused`). `list` reads the real state dir
//              and config, and records into a temp copy of the real snapshot (OVERMIND_SNAPSHOT):
//              same work as production, but the harness never writes real state.
//            Bound to 127.0.0.1.
// - burst    a temp HOME with 3 fake sessions (fake `overmind` printing their rows), transcripts
//            appended 10 lines/s each and a registry rewrite every 20 s: list runs per mode.
//            `--list-delay 0.5` makes each fake list take 0.5 s, so events land mid-list as on a
//            real fleet (a list that stays dirty must still wait out its gap).
// - idle     the same temp HOME, nothing writes: what a host with no busy session costs (lists on
//            the age bound only; CPU ≈ node + the fake CLI, scale lists by the fleet's per-list cost).
// - latency  the same temp HOME, quiet: a registry rewrite every 10 s; reports write → list start
//            (polls /api/health every 100 ms). With --burst-latency the appenders run too.
//
// Run modes interleaved (0, 1, 0, 1) — the fleet changes under you.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { values: opts } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'fleet' },
    watch: { type: 'string', default: '1' },
    seconds: { type: 'string', default: '300' },
    interval: { type: 'string', default: '5' },
    port: { type: 'string', default: '7897' },
    'burst-latency': { type: 'boolean', default: false },
    'list-delay': { type: 'string', default: '0' },
    json: { type: 'boolean', default: false },
  },
});
const port = Number(opts.port);
if (port === 7878 || port === 7999) throw new Error('pick a port the real servers do not use');
const seconds = Number(opts.seconds);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'overmind-server-cpu-'));
const listLog = path.join(tmp, 'lists.log');

function realOvermind() {
  return execFileSync('/bin/sh', ['-lc', 'command -v overmind'], { encoding: 'utf8' }).trim();
}

const refusedLog = path.join(tmp, 'refused.log');

/** A single-quoted sh word, safe for any path (a `'` inside becomes `'\''`). */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The user's real config file (read by the wrapped `list` only — never written). */
const realConfigPath = () => process.env.OVERMIND_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'overmind', 'config.json');

/**
 * OVERMIND_BIN: count `list` runs, then run the real CLI (or print `rows`). Anything else is
 * refused and logged: the harness never lets the server act on real sessions (restore, send, kill,
 * name, stack sync, …), whatever the config says.
 *
 * The real `list` is not read-only: it records into the snapshot (`snapshot::record_quietly`). It
 * runs with the real state dir (reads done.json, titles, stacks as in production), the real config
 * (host name, `restore.keepClosedDays`, naming — read only), no `OVERMIND_HOST`, and
 * `OVERMIND_SNAPSHOT` pointing at a temp copy of the real snapshot: it records exactly as in
 * production (same cost), into a file the harness owns.
 */
function wrapper({ real, rows, stateHome, config, snapshot, delayS = 0 }) {
  const file = path.join(tmp, 'overmind');
  const sleep = delayS > 0 ? `sleep ${delayS}; ` : '';
  const realEnv = () => [
    stateHome ? `export XDG_STATE_HOME=${sq(stateHome)}` : 'unset XDG_STATE_HOME',
    `export OVERMIND_CONFIG=${sq(config)}`,
    `export OVERMIND_SNAPSHOT=${sq(snapshot)}`,
    'unset OVERMIND_HOST',
  ].join('; ');
  const list = rows ? `${sleep}cat ${sq(rows)}; exit 0` : `${realEnv()}; exec ${sq(real)} "$@"`;
  const body = [
    `if [ "$1" = list ]; then echo x >> ${sq(listLog)}; ${list}; fi`,
    `echo "$*" >> ${sq(refusedLog)}`,
    `echo "server-cpu harness: only 'overmind list' runs here (refused: $1)" >&2`,
    'exit 1',
  ].join('\n');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** The real config minus everything that acts at boot or on a timer: only `web.discovery` stays. */
function scrubbedConfig() {
  const real = (() => {
    try {
      return JSON.parse(fs.readFileSync(realConfigPath(), 'utf8'));
    } catch {
      return {};
    }
  })();
  const file = path.join(tmp, 'config.json');
  const web = {
    uploads: { dir: path.join(tmp, 'uploads') },
    memos: { dir: path.join(tmp, 'memos'), audioDir: path.join(tmp, 'memo-audio') },
    ...(real.web?.discovery ? { discovery: real.web.discovery } : {}),
  };
  fs.writeFileSync(file, JSON.stringify({ web }, null, 2));
  return file;
}

/** A temp HOME with `n` fake Claude sessions: registry files, transcripts, and their rows. */
function fixtureHome(n = 3) {
  const home = path.join(tmp, 'home');
  const sessions = path.join(home, '.claude', 'sessions');
  const proj = path.join(home, '.claude', 'projects', '-x');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const sid = `b${i}-0000-4000-8000-000000000000`;
    fs.writeFileSync(path.join(sessions, `${90000 + i}.json`), JSON.stringify({ pid: 90000 + i, sessionId: sid, kind: 'interactive', entrypoint: 'cli', status: 'busy', updatedAt: Date.now() }));
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), '');
    rows.push({ pid: 90000 + i, session_id: sid, harness: 'claude', status: 'busy', cwd: '/x', backend: 'tmux', handle: `%${i}` });
  }
  const rowsFile = path.join(tmp, 'rows.json');
  fs.writeFileSync(rowsFile, JSON.stringify(rows));
  return { home, sessions, proj, rows, rowsFile };
}

const lists = () => (fs.existsSync(listLog) ? fs.readFileSync(listLog, 'utf8').split('\n').filter(Boolean).length : 0);
const getJson = async (p) => (await fetch(base + p)).json();

async function main() {
  const env = {
    ...process.env,
    OVERMIND_WEB_PORT: String(port),
    OVERMIND_WEB_BIND: '127.0.0.1',
    OVERMIND_WEB_WATCH: opts.watch,
    OVERMIND_WEB_AUTONAME: '0',
    OVERMIND_WEB_GROUPING: '0',
    OVERMIND_WEB_BRIEFS: '0',
    OVERMIND_WEB_INBOX: '0',
    OVERMIND_WEB_SLACK: '0',
    OVERMIND_WEB_STACKS: '0',
  };
  let fixture = null;
  let snapshots = null; // fleet: { real, temp } paths, to report who wrote what
  const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : null);
  if (opts.scenario === 'fleet') {
    const realState = process.env.XDG_STATE_HOME || '';
    const stateDir = path.join(realState || path.join(os.homedir(), '.local', 'state'), 'overmind');
    // `list` records into a temp copy of the real snapshot, never the real one (see wrapper()).
    const realSnapshot = process.env.OVERMIND_SNAPSHOT || path.join(stateDir, 'snapshot.json');
    const snapshot = path.join(tmp, 'snapshot.json');
    if (fs.existsSync(realSnapshot)) fs.copyFileSync(realSnapshot, snapshot);
    snapshots = { real: realSnapshot, temp: snapshot, realAt: mtime(realSnapshot), tempAt: mtime(snapshot) };
    env.OVERMIND_BIN = wrapper({ real: realOvermind(), stateHome: realState, config: realConfigPath(), snapshot });
    delete env.OVERMIND_SNAPSHOT;
    delete env.OVERMIND_HOST;
    env.OVERMIND_CONFIG = scrubbedConfig();
    env.XDG_STATE_HOME = path.join(tmp, 'state');
    // …but watch the CLI's real done.json / stacks, as the server would.
    env.OVERMIND_DONE_STATE ||= path.join(stateDir, 'done.json');
    env.OVERMIND_STACKS_DIR ||= path.join(stateDir, 'stacks');
  } else {
    fixture = fixtureHome();
    env.HOME = fixture.home;
    env.OVERMIND_CONFIG = path.join(tmp, 'no-config.json');
    env.XDG_STATE_HOME = path.join(tmp, 'state');
    env.OVERMIND_BIN = wrapper({ rows: fixture.rowsFile, delayS: Number(opts['list-delay']) });
    delete env.CODEX_HOME;
    delete env.PI_CODING_AGENT_DIR;
  }

  const timeOut = path.join(tmp, 'time.txt');
  const child = spawn('/usr/bin/time', ['-l', '-o', timeOut, process.execPath, path.join(ROOT, 'web/server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  // SIGTERM goes to node (time's child): time then writes its report and exits.
  const nodePid = () => Number(execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n')[0]);
  const stopServer = () => {
    try {
      process.kill(nodePid(), 'SIGTERM');
    } catch {}
  };
  process.on('exit', stopServer);
  for (let i = 0; i < 100 && !serverLog.includes('listening on'); i++) await sleep(100);
  if (!serverLog.includes(`listening on http://127.0.0.1:${port}`)) {
    stopServer();
    throw new Error(`server did not start on ${port}:\n${serverLog}`);
  }

  const busy = (body) => body.hosts?.flatMap((h) => h.sessions ?? []).filter((s) => s.status === 'busy').length ?? null;
  const first = await getJson('/api/overmind');
  const busyStart = busy(first);
  const t0 = Date.now();
  const timers = [];
  let last = first;
  timers.push(setInterval(async () => (last = await getJson('/api/overmind').catch(() => last)), Number(opts.interval) * 1000));

  // Burst / latency drivers.
  const latencies = [];
  if (fixture && opts.scenario !== 'idle') {
    if (opts.scenario === 'burst' || opts['burst-latency']) {
      timers.push(setInterval(() => {
        for (const r of fixture.rows) fs.appendFileSync(path.join(fixture.proj, `${r.session_id}.jsonl`), `{"type":"assistant","t":${Date.now()}}\n`);
      }, 100));
    }
    const rewriteEvery = opts.scenario === 'latency' ? 10_000 : 20_000;
    let k = 0;
    timers.push(setInterval(async () => {
      const r = fixture.rows[k++ % fixture.rows.length];
      const wroteAt = Date.now();
      fs.writeFileSync(path.join(fixture.sessions, `${r.pid}.json`), JSON.stringify({ pid: r.pid, sessionId: r.session_id, kind: 'interactive', entrypoint: 'cli', status: k % 2 ? 'idle' : 'busy', updatedAt: wroteAt }));
      if (opts.scenario !== 'latency') return;
      for (let i = 0; i < 80; i++) {
        await sleep(100);
        const h = await getJson('/api/health').catch(() => null);
        const at = h?.discovery?.lastListAt;
        if (at != null && at >= wroteAt) {
          latencies.push(at - wroteAt);
          return;
        }
      }
      latencies.push(null);
    }, rewriteEvery));
  }

  await sleep(seconds * 1000);
  for (const t of timers) clearInterval(t);
  const health = await getJson('/api/health');
  const busyEnd = busy(last);
  const elapsed = (Date.now() - t0) / 1000;
  const exited = new Promise((r) => child.on('exit', r));
  stopServer();
  await exited;
  const time = fs.readFileSync(timeOut, 'utf8');
  const num = (re) => Number(re.exec(time)?.[1] ?? NaN);
  const cpu = num(/([\d.]+)\s+user/) + num(/([\d.]+)\s+sys/);
  const result = {
    scenario: opts.scenario,
    watch: opts.watch === '1',
    seconds: Math.round(elapsed),
    lists: lists(),
    listRuns: health.discovery?.listRuns ?? null,
    mode: health.discovery?.mode ?? null,
    cpuS: Number(cpu.toFixed(2)),
    cpuSPerMin: Number(((cpu / elapsed) * 60).toFixed(2)),
    corePct: Number(((cpu / elapsed) * 100).toFixed(2)),
    busyStart,
    busyEnd,
    // The real snapshot can still change: the production server (another writer) records too.
    ...(snapshots ? { snapshot: { tempWritten: mtime(snapshots.temp) !== snapshots.tempAt, realChanged: mtime(snapshots.real) !== snapshots.realAt } } : {}),
    refused: fs.existsSync(refusedLog) ? fs.readFileSync(refusedLog, 'utf8').split('\n').filter(Boolean) : [],
    ...(latencies.length ? { latencyMs: latencies, latencyMaxMs: Math.max(...latencies.filter((x) => x != null)), latencyMissed: latencies.filter((x) => x == null).length } : {}),
  };
  if (!result.lists && !result.listRuns) process.stderr.write(serverLog);
  console.log(opts.json ? JSON.stringify(result) : result);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
