// The tool processes a Codex session started, so closing its row can stop them too (#34 phase 5).
//
// Codex 0.166 runs a shell command as `<shell> -c <script>` (`-lc` for a login shell), a direct
// child of a codex process: the TUI itself in embedded mode, or the app-server daemon in daemon
// mode — which runs as a child of the TUI that started it and serves every other pane on the host
// too. A command still running when `exec_command` yields keeps running after its turn ends (the
// turn can be over, the row `idle`), and neither an Esc (`turn_aborted`) nor the TUI's SIGTERM
// stops it (docs/codex-findings.md §3, §6). Codex records no pid. So a tool process is
// recognised, never guessed, by all of:
//   - it is in the closed pane's process tree (a descendant of the row's codex pid) — nothing
//     outside it is ever signalled;
//   - its parent is a codex process in that tree (the TUI, or a daemon it started);
//   - it runs `<shell> -c|-lc <script>` with `<script>` a command the row's rollout (its tail)
//     asked to run (`exec_command({cmd:…})` in an `exec` script, an `exec_command` / `shell`
//     function call, a `CommandExecution` item), and it started no earlier than that call (2 s
//     slack);
//   - its cwd is the row's cwd or below it (a daemon this pane started may run another pane's
//     identical command in another checkout).
// What it started is killed with it: its process group when it leads one, else its descendants.
// A daemon another pane started is outside this pane's tree: its tool processes are left alone.

import fs from 'node:fs';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const START_SLACK_MS = 2000;

const base = (p) => String(p).split('/').pop();

/** `ps` prints control characters as octal escapes (`\012` for a newline): undo that. */
export function decodePsArgs(s) {
  return String(s).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/** `[[dd-]hh:]mm:ss` → seconds; NaN when it is not that. */
export function etimeSeconds(s) {
  const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return NaN;
  const [, d = 0, h = 0, mi, se] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(se);
}

/** `ps -ax -ww -o pid=,ppid=,pgid=,etime=,args=` → `{ pid, ppid, pgid, startMs, args }`. */
export function parsePs(stdout, nowMs) {
  const rows = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const secs = etimeSeconds(m[4]);
    if (!Number.isFinite(secs)) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), startMs: nowMs - secs * 1000, args: decodePsArgs(m[5]) });
  }
  return rows;
}

/** The first `cmd` string literal of a JS object in `seg` (`"…"`, `'…'` or a backtick). */
function cmdLiteral(seg) {
  const m = seg.match(/(?:^|[{,\s"'])cmd["']?\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/s);
  if (!m) return null;
  return m[2].replace(/\\(.)/gs, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
}

/**
 * The shell scripts a Codex rollout (`text`, its tail) asked to run, each with when it asked
 * (ms, the line's timestamp): `[{ cmd, atMs }]`, oldest first. A line without a timestamp is
 * skipped — its process could not be told from an older one.
 */
export function rolloutCommands(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!/_call"|CommandExecution/.test(line)) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const p = v?.payload;
    const atMs = Date.parse(v?.timestamp);
    if (!p || typeof p !== 'object' || !Number.isFinite(atMs)) continue;
    const add = (cmd) => typeof cmd === 'string' && cmd && out.push({ cmd, atMs });
    if (p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
      for (const seg of p.input.split('exec_command(').slice(1)) add(cmdLiteral(seg));
    } else if (p.type === 'function_call' && typeof p.arguments === 'string') {
      try {
        const a = JSON.parse(p.arguments);
        add(typeof a?.cmd === 'string' ? a.cmd : Array.isArray(a?.command) ? a.command.at(-1) : null);
      } catch {
        /* not JSON: nothing to match */
      }
    } else if (p.item?.type === 'CommandExecution') {
      const c = p.item.command;
      add(Array.isArray(c) ? c.at(-1) : c);
    }
  }
  return out;
}

/** `<shell> -c <script>` / `<shell> -lc <script>` → the script; null for anything else. */
export function shellScript(args) {
  const m = String(args).match(/^(\S+) -l?c (.*)$/s);
  return m && SHELLS.has(base(m[1]).replace(/^-/, '')) ? m[2] : null;
}

const isCodex = (row) => /^codex(?:-|$)/.test(base(String(row.args).split(' ')[0]));

/**
 * The tool processes to stop for the row whose codex process is `root`: see the header. `rows`
 * from parsePs; `calls` from rolloutCommands; `cwdOf`: pid → cwd (null when unknown — then the
 * process is left alone).
 * @returns {{ leaders: number[], pids: number[] }} the matched tool processes, and every pid to
 *   signal (each one, its descendants, its group when it leads one).
 */
export function toolTargets({ rows, root, calls, cwd, cwdOf = () => null }) {
  const none = { leaders: [], pids: [] };
  if (!Number.isInteger(root) || root <= 1 || !calls?.length || !cwd) return none;
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const below = (pid) => {
    const out = [];
    const stack = [...(kids.get(pid) ?? [])];
    while (stack.length) {
      const r = stack.pop();
      out.push(r);
      stack.push(...(kids.get(r.pid) ?? []));
    }
    return out;
  };
  const tree = below(root);
  const codexPids = new Set([root, ...tree.filter(isCodex).map((r) => r.pid)]);
  // The earliest a process running each script may have started: its first call's time.
  const since = new Map();
  for (const c of calls) if (!since.has(c.cmd) || c.atMs < since.get(c.cmd)) since.set(c.cmd, c.atMs);
  const dir = String(cwd).replace(/\/+$/, '');
  const leaders = tree.filter((r) => {
    if (!codexPids.has(r.ppid) || isCodex(r)) return false;
    const script = shellScript(r.args);
    if (script == null || !since.has(script)) return false;
    // Not before the call that asked for it: an older identical command is another one's.
    if (r.startMs < since.get(script) - START_SLACK_MS) return false;
    const at = cwdOf(r.pid);
    return typeof at === 'string' && (at === dir || at.startsWith(`${dir}/`));
  });
  const pids = new Set();
  for (const l of leaders) {
    pids.add(l.pid);
    for (const d of below(l.pid)) pids.add(d.pid);
  }
  return { leaders: leaders.map((l) => l.pid).sort((a, b) => a - b), pids: [...pids].sort((a, b) => a - b) };
}

/** `lsof -Fpn` output → pid → cwd. */
export function parseLsofCwd(stdout) {
  const out = new Map();
  let pid = null;
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid != null) out.set(pid, line.slice(1));
  }
  return out;
}

function realDir(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @param deps
 *   run       execFile wrapper (lib/run.mjs)
 *   readTail  (file, bytes) => string|null — a rollout's tail
 *   now       () => ms
 */
export function createCodexTools({ run, readTail, now = Date.now, ps = 'ps', lsof = 'lsof', tailBytes = 2 * 1024 * 1024 }) {
  async function table() {
    const { stdout } = await run(ps, ['-ax', '-ww', '-o', 'pid=,ppid=,pgid=,etime=,args='], { timeout: 5000 });
    return parsePs(stdout, now());
  }

  /** The row's tool processes: `{ leaders, pids, groups, rows }` (empty when none, or on any error). */
  async function find(session) {
    const empty = { leaders: [], pids: [], groups: [], rows: [] };
    if (session?.harness !== 'codex' || !session.transcript || !session.cwd) return empty;
    try {
      const calls = rolloutCommands(readTail(session.transcript, tailBytes));
      if (!calls.length) return empty;
      const rows = await table();
      const root = Number(session.pid);
      // Only the candidates' cwds are looked up: one lsof for the few shells that matched the rest.
      const pre = toolTargets({ rows, root, calls, cwd: '/', cwdOf: () => '/' });
      if (!pre.leaders.length) return empty;
      const { stdout } = await run(lsof, ['-a', '-d', 'cwd', '-Fpn', '-p', pre.leaders.join(',')], { timeout: 5000 }).catch((e) => ({ stdout: e?.stdout ?? '' })); // exit 1 when one pid is gone
      const cwds = parseLsofCwd(stdout);
      const t = toolTargets({ rows, root, calls, cwd: realDir(session.cwd), cwdOf: (pid) => cwds.get(pid) ?? null });
      const byPid = new Map(rows.map((r) => [r.pid, r]));
      const groups = t.leaders.filter((pid) => byPid.get(pid)?.pgid === pid && byPid.get(root)?.pgid !== pid);
      return { ...t, groups, rows: t.pids.map((pid) => byPid.get(pid)) };
    } catch {
      return empty;
    }
  }

  /** Which of `found.rows` still run (same pid, args and start, ±1.5 s): never signal a reused pid. */
  async function alive(found) {
    if (!found.rows.length) return [];
    const rows = await table().catch(() => []);
    const now = new Map(rows.map((r) => [r.pid, r]));
    return found.rows.filter((r) => {
      const n = now.get(r.pid);
      return n && n.args === r.args && Math.abs(n.startMs - r.startMs) <= 1500;
    });
  }

  return { find, alive };
}
