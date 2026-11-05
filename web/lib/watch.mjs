// Discovery change signals: file watches on what `overmind list` reads, so the server runs the
// CLI when something changed instead of every few seconds (lib/overmind.mjs decides when).
//
// Every event is classified, coalesced per class for `coalesceMs`, then reported once:
//   fast  the Claude registry (`~/.claude/sessions/<pid>.json`: a row appears or goes, busy /
//         idle / waiting), the names cache (`~/.claude/overmind-names.json`, only when its
//         content changed), `done.json`, the stacks dir and the Codex approval-hook sidecars
//         (`<state>/codex-hooks/<thread>.json`: a Codex row starts or stops waiting)
//         A Codex / pi rollout is fast when its tail shows a turn boundary the last list does
//         not (busy ↔ idle: `task_started` / `task_complete` / `turn_aborted`, pi's last
//         message), and so is a rollout no listed row owns, the first time it is seen (a
//         session started outside the web UI: its row appears)
//   slow  transcripts of live sessions (`~/.claude/projects/<enc>/<sid>.jsonl` and `<sid>/…`),
//         Codex rollouts and `session_index.jsonl`, pi sessions; an unknown rollout once more,
//         on a later list (a row that list was too early for), then never again while no row
//         owns it — so a headless `pi -p` costs at most two lists however long it streams
//   none  a rollout whose `session_meta` (its first line, read once) says `codex exec` /
//         `codex review` (`source: "exec"`, `originator: "codex_exec"`) or a sub-agent
//         (`thread_source: "subagent"`, `source.subagent`, as core/harness.rs drops them)
// What has no file signal (tmux/iTerm tab names, branches, a crashed process, a Codex or pi
// exit, a Codex start before its first prompt) is left to the caller's age bound.
//
// A wrong filter costs one extra list, never a missed row: anything unrecognised passes.
// What `overmind list` writes itself (`snapshot.json*`, the names file rewritten unchanged)
// never passes, or every list would schedule the next one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { overmindStateDir, expandHome } from './config.mjs';

// Mirrors `is_headless` (crates/overmind/src/core/discovery.rs; tests/watch-headless-parity.test.mjs
// pins the two): `claude -p` children register too (autoname, briefs, grouping, inbox) and are never rows.
export const HEADLESS_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py', 'local-agent', 'github-action']);
export const isHeadless = (reg) =>
  (typeof reg?.kind === 'string' && reg.kind !== 'interactive') ||
  (typeof reg?.entrypoint === 'string' && (HEADLESS_ENTRYPOINTS.has(reg.entrypoint) || reg.entrypoint.startsWith('sdk-')));

const REGISTRY_RE = /^[^.]+\.json$/; // `<pid>.json`, not `<pid>.<hash>.key` or a `.tmp`

/**
 * The directories to watch, as the CLI resolves them: `~/.claude` (HOME, not CLAUDE_CONFIG_DIR —
 * `claude_home()`), `$CODEX_HOME`, `$PI_CODING_AGENT_DIR`, the state dir (`done.json`,
 * `$OVERMIND_DONE_STATE`), `$OVERMIND_STACKS_DIR`, `$OVERMIND_CODEX_HOOKS_DIR` (`sidecar_dir()` in
 * core/codex_hooks.rs: absolute or `~/…`, a relative value ignored). `signals`: a root that announces new
 * rows (Claude's registry, Codex's and pi's sessions). With none of them armed there is no signal for new
 * rows, so the watcher reports `degraded` (and the caller falls back to its TTL); any one is enough — a
 * host that never ran Claude has no registry.
 */
export function discoveryRoots({ env = process.env, home = os.homedir() } = {}) {
  const claude = path.join(home, '.claude');
  const codex = env.CODEX_HOME ? path.resolve(expandHome(env.CODEX_HOME, home)) : path.join(home, '.codex');
  const pi = env.PI_CODING_AGENT_DIR ? path.resolve(expandHome(env.PI_CODING_AGENT_DIR, home)) : path.join(home, '.pi', 'agent');
  const state = overmindStateDir(env, home);
  const done = env.OVERMIND_DONE_STATE ? path.resolve(expandHome(env.OVERMIND_DONE_STATE, home)) : path.join(state, 'done.json');
  const stacks = env.OVERMIND_STACKS_DIR ? path.resolve(expandHome(env.OVERMIND_STACKS_DIR, home)) : path.join(state, 'stacks');
  // Absolute or `~/…`; a relative value is ignored, as `hooks_dir_override` does (core/codex_hooks.rs).
  const hooksOverride = env.OVERMIND_CODEX_HOOKS_DIR ? expandHome(env.OVERMIND_CODEX_HOOKS_DIR, home) : null;
  const codexHooks = hooksOverride && path.isAbsolute(hooksOverride) ? hooksOverride : path.join(state, 'codex-hooks');
  return [
    { id: 'sessions', dir: path.join(claude, 'sessions'), kind: 'registry', signals: true },
    { id: 'claude', dir: claude, kind: 'file', file: 'overmind-names.json', compare: true },
    { id: 'projects', dir: path.join(claude, 'projects'), kind: 'transcripts', recursive: true, harness: 'claude' },
    { id: 'done', dir: path.dirname(done), kind: 'file', file: path.basename(done) },
    { id: 'stacks', dir: stacks, kind: 'dir' },
    { id: 'codex', dir: path.join(codex, 'sessions'), kind: 'transcripts', recursive: true, harness: 'codex', signals: true },
    { id: 'codex-index', dir: codex, kind: 'file', file: 'session_index.jsonl', cls: 'slow' },
    // `<id>.json.tmp` then a rename (`write_sidecar`): `dir` drops the temp, so one write is one signal.
    { id: 'codex-hooks', dir: codexHooks, kind: 'dir', cls: 'fast' },
    { id: 'pi', dir: path.join(pi, 'sessions'), kind: 'transcripts', recursive: true, harness: 'pi', signals: true },
  ];
}

/** How much of a rollout's end `turnState` reads: a turn boundary is a short line. */
const TAIL_BYTES = 16 * 1024;

/** How much of a rollout's head `rolloutIsHeadless` reads: `session_meta` carries the system prompt. */
const HEAD_BYTES = 1024 * 1024;

/** A file's first line (no newline), or null when unreadable, not whole yet or longer than `max`. */
export function readFileHead(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < max) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, max - total), total);
      if (n === 0) return null;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, nl)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Whether a rollout's first line marks a run that is never a row: `codex exec` / `codex review`
 * (`source: "exec"`, `originator: "codex_exec"`) or a sub-agent (`thread_source: "subagent"`,
 * `source.subagent` — the markers `transcript_ref` in core/harness.rs drops). pi's head has no
 * such marker (false). null: no whole first line to read yet.
 */
export function rolloutIsHeadless(harness, head) {
  if (typeof head !== 'string') return null;
  let v;
  try {
    v = JSON.parse(head);
  } catch {
    return null;
  }
  if (harness !== 'codex' || v?.type !== 'session_meta') return false;
  const p = v.payload ?? {};
  return p.source === 'exec' || p.originator === 'codex_exec' || p.thread_source === 'subagent' || (p.source != null && typeof p.source === 'object' && 'subagent' in p.source);
}

/** The last `bytes` of a file as text (null when unreadable). */
export function readFileTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The turn state a rollout's tail ends in, as `overmind list` reads it (core/harness.rs
 * `codex_state` / `pi_state`): 'busy' | 'idle', or null when the tail has no boundary. A
 * pending approval counts as busy (the list shows it as `waiting`, read off the screen).
 */
export function turnState(harness, text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (harness === 'codex' ? !/task_started|task_complete|turn_aborted|approval_request|request_user_input/.test(line) : !line.includes('"message"')) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue; // the first (cut) or the last (half-written) line
    }
    if (harness === 'codex') {
      if (v?.type !== 'event_msg') continue;
      const t = v.payload?.type;
      if (t === 'task_complete' || t === 'turn_aborted') return 'idle';
      if (t === 'task_started' || t === 'request_user_input' || (typeof t === 'string' && t.endsWith('approval_request'))) return 'busy';
    } else if (v?.type === 'message') {
      const m = v.message ?? {};
      if (['user', 'toolResult', 'bashExecution'].includes(m.role)) return 'busy';
      if (m.role === 'assistant') return m.stopReason === 'toolUse' ? 'busy' : 'idle';
    }
  }
  return null;
}

/**
 * @param roots      discoveryRoots()
 * @param live       () => the last list's rows (or null before the first): transcripts of other
 *                   sessions are ignored
 * @param onChange   (cls: 'fast'|'slow') => void, at most once per class per `coalesceMs`
 * @returns {{ start, stop, rearm, status }}
 */
export function createDiscoveryWatcher({
  roots,
  live = () => null,
  onChange,
  watch = fs.watch,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  readTail = readFileTail,
  readHead = readFileHead,
  exists = (dir) => fs.existsSync(dir),
  coalesceMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
  const armed = new Map(); // root id -> FSWatcher
  const parents = new Map(); // root id -> FSWatcher on the parent of a missing root, until it exists
  const failed = new Map(); // root id -> error message (a watcher that errored, until rearm)
  const headless = new Set(); // registry basenames of headless runs: their delete is ignored too
  const contents = new Map(); // root id -> last content of a compared file
  // Rollouts no listed row owns: id -> { passes, list (the seq of the last pass's list), headless }.
  // A row owning the id forgets it, so a rollout that is unknown again (a resume) is fast again.
  // A list is known by a number, not its rows array: up to 1000 entries must not pin old lists.
  const unknown = new Map();
  const listSeq = new WeakMap(); // rows array -> its seq
  let lastSeq = 0;
  const seqOf = (rows) => {
    let n = listSeq.get(rows);
    if (n === undefined) listSeq.set(rows, (n = ++lastSeq));
    return n;
  };
  const pending = { fast: null, slow: null };
  let started = false;
  let events = 0;

  const read = (file) => {
    try {
      return readFile(file);
    } catch {
      return null;
    }
  };

  function emit(cls) {
    events += 1;
    if (pending[cls]) return;
    pending[cls] = setTimer(() => {
      pending[cls] = null;
      onChange(cls);
    }, coalesceMs);
    pending[cls]?.unref?.();
  }

  /**
   * The class of a transcript event, or null to drop it. Claude: a live session's files are slow,
   * others dropped. Codex / pi (`…/rollout-<stamp>-<id>.jsonl`, `--<cwd>--/<stamp>_<id>.jsonl`):
   * a listed row's rollout is fast when its tail shows another turn state than the row (busy ↔
   * idle), else slow; an unknown one is dropped when its head says `codex exec` or a sub-agent,
   * else fast the first time (a session started in a terminal: its row appears after its first
   * prompt), slow once more on a later list, then dropped while no row owns it. Before the first
   * list, anything passes (a list too many, never too few).
   */
  function transcriptClass(root, rel) {
    const rows = live();
    if (!Array.isArray(rows)) return 'slow';
    const parts = rel.split(/[\\/]/);
    if (root.harness === 'claude') {
      // <enc>/<sid>.jsonl, <enc>/<sid>/subagents/…, <enc>/<sid>/tool-results/…
      const sid = parts[1]?.replace(/\.jsonl$/, '');
      return Boolean(sid) && rows.some((r) => r?.session_id === sid) ? 'slow' : null;
    }
    const base = parts[parts.length - 1];
    if (!base.endsWith('.jsonl')) return null;
    const id = base.replace(/\.jsonl$/, '');
    const row = rows.find((r) => r?.harness === root.harness && typeof r.session_id === 'string' && !r.session_id.startsWith('pid-') && id.endsWith(r.session_id));
    if (row) {
      unknown.delete(id);
      const turn = turnState(root.harness, readTail(path.join(root.dir, rel), TAIL_BYTES));
      return turn && turn !== (row.status === 'idle' ? 'idle' : 'busy') ? 'fast' : 'slow';
    }
    let u = unknown.get(id);
    if (!u) {
      if (unknown.size >= 1000) unknown.clear(); // a long-lived server: forget, at worst two lists each
      u = { passes: 0, list: 0, headless: null };
      unknown.set(id, u);
    }
    const seq = seqOf(rows);
    // Decided, or this list already passed it: no head read (a head that never parses would
    // otherwise be read, up to 1 MB, on every event).
    if (u.headless || u.passes >= 2 || u.list === seq) return null;
    if (u.headless === null) u.headless = rolloutIsHeadless(root.harness, readHead(path.join(root.dir, rel), HEAD_BYTES));
    if (u.headless) return null;
    u.passes += 1;
    u.list = seq;
    return u.passes === 1 ? 'fast' : 'slow';
  }

  function classify(root, filename) {
    if (filename == null) return root.cls ?? (root.kind === 'transcripts' ? 'slow' : 'fast');
    const rel = String(filename);
    const base = path.basename(rel);
    switch (root.kind) {
      case 'registry': {
        if (!REGISTRY_RE.test(base)) return null;
        const text = read(path.join(root.dir, base));
        if (text == null) {
          // Deleted (a clean exit): a headless run's delete is no news.
          if (headless.delete(base)) return null;
          return 'fast';
        }
        let reg = null;
        try {
          reg = JSON.parse(text);
        } catch {
          return 'fast'; // half-written: look anyway
        }
        if (isHeadless(reg)) {
          headless.add(base);
          return null;
        }
        headless.delete(base); // a reused pid (a missed headless delete) must not hide this row's exit
        return 'fast';
      }
      case 'file': {
        if (base !== root.file) return null;
        if (root.compare) {
          const text = read(path.join(root.dir, base));
          if (text === contents.get(root.id)) return null; // rewritten unchanged (by `list` itself)
          contents.set(root.id, text);
        }
        return root.cls ?? 'fast';
      }
      case 'dir':
        return /\.(tmp|lock)$/.test(base) || base.startsWith('.') ? null : 'fast';
      case 'transcripts':
        return transcriptClass(root, rel);
      default:
        return null;
    }
  }

  function arm(root) {
    if (armed.has(root.id)) return true;
    if (!exists(root.dir)) {
      failed.delete(root.id); // gone: nothing to watch (status() counts it as not armed)
      if (started) awaitRoot(root);
      return false;
    }
    try {
      if (root.compare) contents.set(root.id, read(path.join(root.dir, root.file)));
      const w = watch(root.dir, { recursive: Boolean(root.recursive), persistent: false }, (_type, filename) => {
        if (filename != null && String(filename) === path.basename(root.dir)) return rootChanged(root, w);
        const cls = classify(root, filename);
        if (cls) emit(cls);
      });
      w.on?.('error', (err) => {
        if (armed.get(root.id) !== w) return; // a replaced watcher's late error: not this slot's
        log(`[discovery] watch ${root.id} failed: ${err?.message ?? err} — falling back to the list TTL`);
        failed.set(root.id, String(err?.message ?? err));
        try {
          w.close();
        } catch {}
        armed.delete(root.id);
      });
      armed.set(root.id, w);
      failed.delete(root.id);
      closeParent(root.id);
      return true;
    } catch (err) {
      if (err?.code !== 'ENOENT') failed.set(root.id, String(err?.message ?? err));
      return false;
    }
  }

  /**
   * A root that does not exist yet (the first `~/.codex/sessions`, `codex-hooks` right after
   * `codex hooks install`, a registry dir removed): watch its parent, when that exists, for the
   * root's creation — arm it then, and signal fast (it may already hold a row's file). Without
   * a parent the next run's `rearm()` picks it up.
   */
  function awaitRoot(root) {
    const parent = path.dirname(root.dir);
    if (parents.has(root.id) || parent === root.dir || !exists(parent)) return;
    try {
      const pw = watch(parent, { recursive: false, persistent: false }, (_type, filename) => {
        if (parents.get(root.id) !== pw) return;
        if (filename != null && String(filename) !== path.basename(root.dir)) return;
        if (!exists(root.dir)) return;
        if (arm(root)) emit('fast');
      });
      pw.on?.('error', () => {
        if (parents.get(root.id) === pw) closeParent(root.id);
      });
      parents.set(root.id, pw);
    } catch {}
  }

  function closeParent(id) {
    const pw = parents.get(id);
    if (!pw) return;
    parents.delete(id);
    try {
      pw.close();
    } catch {}
  }

  /**
   * An event named after the watched dir itself: the root was removed, renamed or replaced
   * (`rm -rf ~/.claude/sessions` reports only this — no per-file events). Its watcher is closed
   * either way and the root re-armed if it is back (a fresh watch on the new dir); while it is
   * missing it is not armed (`degraded` when no other session root is) and the next run's `rearm()`
   * picks it up again.
   * Fast: the rows it held may have gone.
   */
  function rootChanged(root, w) {
    if (armed.get(root.id) !== w) return;
    try {
      w.close();
    } catch {}
    armed.delete(root.id);
    if (!arm(root)) log(`[discovery] watch root ${root.id} is gone — falling back to the list TTL until it is back`);
    emit('fast');
  }

  /** Arm every root that exists. Idempotent. */
  function start() {
    started = true;
    for (const root of roots) arm(root);
  }

  /** Arm what is missing (a root created since, or one whose watcher errored). Cheap when all are armed. */
  function rearm() {
    if (!started) return;
    for (const root of roots) if (!armed.has(root.id)) arm(root);
  }

  function stop() {
    started = false;
    for (const w of armed.values()) {
      try {
        w.close();
      } catch {}
    }
    armed.clear();
    for (const id of [...parents.keys()]) closeParent(id);
    failed.clear();
    headless.clear(); // deletes missed while stopped would otherwise hide a reused pid's exit
    unknown.clear();
    for (const cls of Object.keys(pending)) {
      clearTimer(pending[cls]);
      pending[cls] = null;
    }
  }

  /**
   * `mode`: `watch` — armed and healthy (the caller may trust silence); `degraded` — a watcher
   * errored or no session root (`signals`) is armed (the caller uses its TTL); `idle` — not started.
   */
  function status() {
    let mode = 'idle';
    if (started) {
      const noSignal = !roots.some((r) => r.signals && armed.has(r.id));
      mode = failed.size || noSignal ? 'degraded' : 'watch';
    }
    return {
      mode,
      events,
      roots: roots.map((r) => ({ id: r.id, armed: armed.has(r.id), ...(failed.has(r.id) ? { error: failed.get(r.id) } : {}) })),
    };
  }

  return { start, stop, rearm, status };
}
