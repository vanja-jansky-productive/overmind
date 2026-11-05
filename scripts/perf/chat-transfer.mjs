// Chat poll transfer — the #37 harness: what an open session's chat costs on the wire.
//
//   node scripts/perf/chat-transfer.mjs [--mode full|delta] [--scenario idle|busy] [--seconds 60]
//                                       [--interval 3] [--port 7896] [--server web/server.mjs]
//                                       [--via-peer] [--verify] [--json]
//
// Builds a temp HOME with one fake Claude session (a fake `overmind` printing its row) and a
// real-sized synthetic transcript (300 turns with tool calls and results, 3.46 MB; the last 60
// messages ≈ 35 KB of JSON, near the ~30 KB #35 measured), starts `web/server.mjs` on 127.0.0.1 (never
// 7878) under `/usr/bin/time -l`, and polls `…/messages?limit=60` every `--interval` s like the
// chat pane:
// - `--mode full`  no cursor (today's UI, or any UI against an older server): the whole window;
// - `--mode delta` `after=<the last cursor>` (#37): a "same" answer, a delta, or a full one.
// Scenarios: `idle` (nothing writes) and `busy` (a tool call + result every 1 s, an assistant
// reply streamed in three blocks every 10 s, a user prompt every 30 s).
// `--via-peer` runs a second server (`laptop`) and polls the session through its proxy.
// `--verify` also fetches the full window after each poll (not counted) and checks the merged
// list equals it. `--server` runs another checkout's server (a before run on `main`).
//
// Prints one JSON line: requests, body bytes (total, per minute, max), approx. header bytes, the
// answers by kind (legacy / full / delta / same), the session server's CPU (node + children) and,
// with --verify, the polls verified, raced (skipped) and mismatched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { values: opts } = parseArgs({
  options: {
    mode: { type: 'string', default: 'delta' },
    scenario: { type: 'string', default: 'idle' },
    seconds: { type: 'string', default: '60' },
    interval: { type: 'string', default: '3' },
    port: { type: 'string', default: '7896' },
    server: { type: 'string', default: path.join(ROOT, 'web/server.mjs') },
    turns: { type: 'string', default: '300' },
    'via-peer': { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});
const port = Number(opts.port);
const peerPort = port + 1;
for (const p of [port, peerPort]) if (p === 7878 || p === 7999) throw new Error('pick a port the real servers do not use');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'overmind-chat-transfer-'));
const SID = 'c7000000-0000-4000-8000-000000000037';
const LIMIT = 60;

// ------------------------------------------------------------------ the fixture

const iso = (t) => new Date(t).toISOString();
const words = (n, seed) => Array.from({ length: n }, (_, i) => ['the', 'invoice', 'total', 'rounds', 'per', 'line', 'in', 'minor', 'units', 'so', 'cents', 'add', 'up'][(i * 7 + seed) % 13]).join(' ');
const userLine = (text, t) => JSON.stringify({ type: 'user', uuid: `u-${t}`, timestamp: iso(t), message: { role: 'user', content: text } });
const assistantLine = (id, content, stop, t) => JSON.stringify({ type: 'assistant', uuid: `a-${t}-${Math.random().toString(16).slice(2, 8)}`, timestamp: iso(t), message: { id, role: 'assistant', content, stop_reason: stop } });
const toolUse = (id, t) => assistantLine(`tu-${id}`, [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test -- invoice' } }], 'tool_use', t);
const toolResult = (id, t, size = 4000) => JSON.stringify({ type: 'user', uuid: `r-${t}-${id}`, timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: words(Math.round(size / 5), t % 13) }] } });

/** One turn: a prompt, two narrations each before a tool call (+ a ~4 KB result), a ~1.5 KB reply. */
function turn(k, t) {
  const lines = [userLine(`Step ${k}: ${words(30, k)}`, t)];
  for (let n = 0; n < 2; n++) {
    lines.push(assistantLine(`n-${k}-${n}`, [{ type: 'text', text: `Checking ${words(45, k + n)}.` }], 'tool_use', t + 1 + n));
    lines.push(toolUse(`t-${k}-${n}`, t + 1 + n));
    lines.push(toolResult(`t-${k}-${n}`, t + 2 + n));
  }
  lines.push(assistantLine(`f-${k}`, [{ type: 'text', text: `Done with step ${k}. ${words(250, k)}` }], 'end_turn', t + 5));
  return lines;
}

function fixtureHome() {
  const home = path.join(tmp, 'home');
  const sessions = path.join(home, '.claude', 'sessions');
  const proj = path.join(home, '.claude', 'projects', '-x');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${SID}.jsonl`);
  const t0 = Date.parse('2026-11-05T08:00:00Z');
  const out = [];
  for (let k = 0; k < Number(opts.turns); k++) out.push(...turn(k, t0 + k * 60_000));
  fs.writeFileSync(file, `${out.join('\n')}\n`);
  fs.writeFileSync(path.join(sessions, '93700.json'), JSON.stringify({ pid: 93700, sessionId: SID, kind: 'interactive', entrypoint: 'cli', status: 'idle', updatedAt: Date.now() }));
  const rows = [{ pid: 93700, session_id: SID, harness: 'claude', status: 'idle', name: 'perf', cwd: '/x', backend: 'tmux', handle: '%1' }];
  const rowsFile = path.join(tmp, 'rows.json');
  fs.writeFileSync(rowsFile, JSON.stringify(rows));
  return { home, file, rowsFile };
}

/** OVERMIND_BIN: `list` prints the rows; anything else is refused (the harness never acts on sessions). */
function fakeOvermind(rowsFile, name) {
  const bin = path.join(tmp, `overmind-${name}`);
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = list ]; then cat '${rowsFile}'; exit 0; fi\necho "chat-transfer harness: only list" >&2\nexit 1\n`, { mode: 0o755 });
  return bin;
}

// ------------------------------------------------------------------ servers

function startServer({ name, port: p, home, bin, config, timed }) {
  const env = {
    ...process.env,
    HOME: home,
    OVERMIND_CONFIG: config,
    OVERMIND_BIN: bin,
    XDG_STATE_HOME: path.join(tmp, `state-${name}`),
    OVERMIND_WEB_PORT: String(p),
    OVERMIND_WEB_BIND: '127.0.0.1',
    OVERMIND_WEB_AUTONAME: '0',
    OVERMIND_WEB_GROUPING: '0',
    OVERMIND_WEB_BRIEFS: '0',
    OVERMIND_WEB_INBOX: '0',
    OVERMIND_WEB_SLACK: '0',
    OVERMIND_WEB_STACKS: '0',
  };
  delete env.CODEX_HOME;
  delete env.PI_CODING_AGENT_DIR;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.OVERMIND_HOST;
  const timeOut = path.join(tmp, `time-${name}.txt`);
  const argv = timed ? ['/usr/bin/time', ['-l', '-o', timeOut, process.execPath, opts.server]] : [process.execPath, [opts.server]];
  const child = spawn(argv[0], argv[1], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const nodePid = () => (timed ? Number(execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n')[0]) : child.pid);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.on('exit', r));
    try {
      process.kill(nodePid(), 'SIGTERM');
    } catch {}
    await exited;
  };
  const cpu = () => {
    if (!timed) return null;
    const t = fs.readFileSync(timeOut, 'utf8');
    const num = (re) => Number(re.exec(t)?.[1] ?? NaN);
    return num(/([\d.]+)\s+user/) + num(/([\d.]+)\s+sys/);
  };
  const ready = async () => {
    for (let i = 0; i < 100 && !log.includes(`listening on http://127.0.0.1:${p}`); i++) await sleep(100);
    if (!log.includes(`listening on http://127.0.0.1:${p}`)) throw new Error(`${name} did not start on ${p}:\n${log}`);
  };
  return { child, stop, cpu, ready, log: () => log };
}

function writeConfig(name, hosts) {
  const file = path.join(tmp, `config-${name}.json`);
  const web = { uploads: { dir: path.join(tmp, 'uploads') }, memos: { dir: path.join(tmp, 'memos'), audioDir: path.join(tmp, 'memo-audio') } };
  fs.writeFileSync(file, JSON.stringify({ self: name, hosts, web }, null, 2));
  return file;
}

// ------------------------------------------------------------------ the busy session

function busyWriter(file) {
  let k = 100000;
  let tick = 0;
  let reply = null;
  const add = (...lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`);
  return setInterval(() => {
    tick += 1;
    const t = Date.now();
    if (tick % 30 === 0) add(userLine(`Next: ${words(30, tick)}`, t));
    if (tick % 10 === 0) reply = `r-${tick}`;
    // A reply streams in three blocks (one JSONL line each, glued by the parser), 1 s apart.
    if (reply && tick % 10 < 3) add(assistantLine(reply, [{ type: 'text', text: `${words(80, tick)}.` }], tick % 10 === 2 ? 'end_turn' : 'tool_use', t));
    const id = `bt-${k++}`;
    add(toolUse(id, t), toolResult(id, t, 2000));
  }, 1000);
}

// ------------------------------------------------------------------ the poller

/** Approx. wire bytes of a response's status line + headers (what #40's push would not repeat). */
const headerBytes = (res) => 17 + [...res.headers].reduce((n, [k, v]) => n + k.length + v.length + 4, 0) + 2;
const REQUEST_HEADER_BYTES = 180; // GET line + Host / Accept / User-Agent / Connection, roughly

function merge(held, body) {
  if (typeof body.cursor !== 'string' || body.full !== false || !held) return { list: body.messages.slice(), total: body.total };
  const base = held.total - held.list.length;
  return { list: held.list.slice(0, Math.max(0, body.from - base)).concat(body.messages).slice(-LIMIT), total: body.total };
}

async function main() {
  const fx = fixtureHome();
  const bin = fakeOvermind(fx.rowsFile, 'workstation');
  const base = `http://127.0.0.1:${port}`;
  const peerBase = `http://127.0.0.1:${peerPort}`;
  const hosts = opts['via-peer'] ? { workstation: { web: base }, laptop: { web: peerBase } } : {};
  const session = startServer({ name: 'workstation', port, home: fx.home, bin, config: writeConfig('workstation', hosts), timed: true });
  const servers = [session];
  let entry = base;
  if (opts['via-peer']) {
    const emptyHome = path.join(tmp, 'home-laptop');
    fs.mkdirSync(path.join(emptyHome, '.claude', 'projects'), { recursive: true });
    const emptyRows = path.join(tmp, 'rows-laptop.json');
    fs.writeFileSync(emptyRows, '[]');
    servers.push(startServer({ name: 'laptop', port: peerPort, home: emptyHome, bin: fakeOvermind(emptyRows, 'laptop'), config: writeConfig('laptop', hosts), timed: false }));
    entry = peerBase;
  }
  try {
    await Promise.all(servers.map((s) => s.ready()));
    await measure({ servers, session, fx, entry });
  } finally {
    for (const s of servers) await s.stop();
  }
}

async function measure({ servers, session, fx, entry }) {

  const url = (after) => `${entry}/api/hosts/workstation/sessions/${SID}/messages?limit=${LIMIT}${after == null ? '' : `&after=${encodeURIComponent(after)}`}`;
  const stats = { requests: 0, bodyBytes: 0, headerBytes: 0, maxBody: 0, kinds: { legacy: 0, full: 0, delta: 0, same: 0 }, mismatches: 0, verified: 0, raced: 0, bodies: [] };
  let cursor = '';
  let held = null;
  const poll = async () => {
    const res = await fetch(url(opts.mode === 'delta' ? cursor : null));
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const bytes = Number(res.headers.get('content-length')) || Buffer.byteLength(text);
    const body = JSON.parse(text);
    stats.requests += 1;
    stats.bodyBytes += bytes;
    stats.headerBytes += headerBytes(res) + REQUEST_HEADER_BYTES;
    stats.maxBody = Math.max(stats.maxBody, bytes);
    const kind = typeof body.cursor !== 'string' || opts.mode === 'full' ? (body.cursor ? 'full' : 'legacy') : body.full ? 'full' : body.messages.length ? 'delta' : 'same';
    stats.kinds[kind] += 1;
    stats.bodies.push(bytes);
    cursor = typeof body.cursor === 'string' ? body.cursor : '';
    held = merge(held, body);
    if (opts.verify) {
      // Only against the same server state: the writer may append between the two requests (a
      // new cursor) — compared anyway, that differs by what was appended (`raced`, not checked).
      const ref = await (await fetch(url(null))).json();
      if (ref.cursor === body.cursor) {
        const want = ref.messages.filter((m) => !String(m.id ?? '').startsWith('screen:'));
        stats.verified += 1;
        if (JSON.stringify(want) !== JSON.stringify(held.list)) stats.mismatches += 1;
      } else stats.raced += 1;
    }
  };

  await poll(); // the open: one full answer, then the steady state is what is measured
  const open = { bytes: stats.bodyBytes, kind: Object.keys(stats.kinds).find((k) => stats.kinds[k]) };
  Object.assign(stats, { requests: 0, bodyBytes: 0, headerBytes: 0, maxBody: 0, kinds: { legacy: 0, full: 0, delta: 0, same: 0 }, mismatches: 0, verified: 0, raced: 0, bodies: [] });
  const writer = opts.scenario === 'busy' ? busyWriter(fx.file) : null;
  const t0 = Date.now();
  const end = t0 + Number(opts.seconds) * 1000;
  while (Date.now() < end) {
    const next = Date.now() + Number(opts.interval) * 1000;
    await poll();
    await sleep(Math.max(0, next - Date.now()));
  }
  if (writer) clearInterval(writer);
  const elapsed = (Date.now() - t0) / 1000;
  for (const s of servers) await s.stop();
  const cpu = session.cpu(); // written by /usr/bin/time once node exits
  const perMin = (n) => Math.round((n / elapsed) * 60);
  const result = {
    server: path.relative(process.cwd(), opts.server) || opts.server,
    mode: opts.mode,
    scenario: opts.scenario,
    viaPeer: opts['via-peer'],
    seconds: Math.round(elapsed),
    transcriptBytes: fs.statSync(fx.file).size,
    open,
    requests: stats.requests,
    bodyBytes: stats.bodyBytes,
    bodyBytesPerMin: perMin(stats.bodyBytes),
    maxBody: stats.maxBody,
    medianBody: stats.bodies.sort((x, y) => x - y)[Math.floor(stats.bodies.length / 2)] ?? 0,
    headerBytesPerMin: perMin(stats.headerBytes),
    kinds: stats.kinds,
    serverCpuS: cpu == null ? null : Number(cpu.toFixed(2)),
    ...(opts.verify ? { verified: stats.verified, raced: stats.raced, mismatches: stats.mismatches } : {}),
  };
  console.log(opts.json ? JSON.stringify(result) : result);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
