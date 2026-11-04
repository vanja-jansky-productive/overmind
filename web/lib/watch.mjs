// Discovery change signals: file watches on what `overmind list` reads, so the server runs the
// CLI when something changed instead of every few seconds (lib/overmind.mjs decides when).
//
// Every event is classified, coalesced per class for `coalesceMs`, then reported once:
//   fast  the Claude registry (`~/.claude/sessions/<pid>.json`: a row appears or goes, busy /
//         idle / waiting), the names cache (`~/.claude/overmind-names.json`, only when its
//         content changed), `done.json` and the stacks dir
//   slow  transcripts of live sessions (`~/.claude/projects/<enc>/<sid>.jsonl` and `<sid>/…`),
//         Codex rollouts and `session_index.jsonl`, pi sessions
// What has no file signal (tmux/iTerm tab names, branches, a crashed process, a Codex start
// before its first prompt) is left to the caller's age bound.
//
// A wrong filter costs one extra list, never a missed row: anything unrecognised passes.
// What `overmind list` writes itself (`snapshot.json*`, the names file rewritten unchanged)
// never passes, or every list would schedule the next one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { overmindStateDir, expandHome } from './config.mjs';

// Mirrors `is_headless` (crates/overmind/src/core/discovery.rs): `claude -p` children register
// too (autoname, briefs, grouping, inbox) and are never rows.
const HEADLESS_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py', 'local-agent', 'github-action']);
const isHeadless = (reg) =>
  (typeof reg?.kind === 'string' && reg.kind !== 'interactive') ||
  (typeof reg?.entrypoint === 'string' && (HEADLESS_ENTRYPOINTS.has(reg.entrypoint) || reg.entrypoint.startsWith('sdk-')));

const REGISTRY_RE = /^[^.]+\.json$/; // `<pid>.json`, not `<pid>.<hash>.key` or a `.tmp`

/**
 * The directories to watch, as the CLI resolves them: `~/.claude` (HOME, not CLAUDE_CONFIG_DIR —
 * `claude_home()`), `$CODEX_HOME`, `$PI_CODING_AGENT_DIR`, the state dir (`done.json`,
 * `$OVERMIND_DONE_STATE`), `$OVERMIND_STACKS_DIR`. `required`: without it there is no signal
 * for new rows, so the watcher reports `degraded` (and the caller falls back to its TTL).
 */
export function discoveryRoots({ env = process.env, home = os.homedir() } = {}) {
  const claude = path.join(home, '.claude');
  const codex = env.CODEX_HOME ? path.resolve(expandHome(env.CODEX_HOME, home)) : path.join(home, '.codex');
  const pi = env.PI_CODING_AGENT_DIR ? path.resolve(expandHome(env.PI_CODING_AGENT_DIR, home)) : path.join(home, '.pi', 'agent');
  const state = overmindStateDir(env, home);
  const done = env.OVERMIND_DONE_STATE ? path.resolve(expandHome(env.OVERMIND_DONE_STATE, home)) : path.join(state, 'done.json');
  const stacks = env.OVERMIND_STACKS_DIR ? path.resolve(expandHome(env.OVERMIND_STACKS_DIR, home)) : path.join(state, 'stacks');
  return [
    { id: 'sessions', dir: path.join(claude, 'sessions'), kind: 'registry', required: true },
    { id: 'claude', dir: claude, kind: 'file', file: 'overmind-names.json', compare: true },
    { id: 'projects', dir: path.join(claude, 'projects'), kind: 'transcripts', recursive: true, harness: 'claude' },
    { id: 'done', dir: path.dirname(done), kind: 'file', file: path.basename(done) },
    { id: 'stacks', dir: stacks, kind: 'dir' },
    { id: 'codex', dir: path.join(codex, 'sessions'), kind: 'transcripts', recursive: true, harness: 'codex' },
    { id: 'codex-index', dir: codex, kind: 'file', file: 'session_index.jsonl', cls: 'slow' },
    { id: 'pi', dir: path.join(pi, 'sessions'), kind: 'transcripts', recursive: true, harness: 'pi' },
  ];
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
  exists = (dir) => fs.existsSync(dir),
  coalesceMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
  const armed = new Map(); // root id -> FSWatcher
  const failed = new Map(); // root id -> error message (a watcher that errored, until rearm)
  const headless = new Set(); // registry basenames of headless runs: their delete is ignored too
  const contents = new Map(); // root id -> last content of a compared file
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

  /** Is this transcript path one of a live session's? Unknown → pass (a list too many, never too few). */
  function liveTranscript(root, rel) {
    const rows = live();
    if (!Array.isArray(rows)) return true;
    const parts = rel.split(/[\\/]/);
    if (root.harness === 'claude') {
      // <enc>/<sid>.jsonl, <enc>/<sid>/subagents/…, <enc>/<sid>/tool-results/…
      const sid = parts[1]?.replace(/\.jsonl$/, '');
      return Boolean(sid) && rows.some((r) => r?.session_id === sid);
    }
    // Codex `…/rollout-<stamp>-<id>.jsonl`, pi `--<cwd>--/<stamp>_<id>.jsonl`. A session of this
    // harness with no transcript yet (`pid-<n>`) will write a new one: let those through.
    const mine = rows.filter((r) => r?.harness === root.harness);
    if (mine.some((r) => typeof r.session_id !== 'string' || r.session_id.startsWith('pid-'))) return true;
    const base = parts[parts.length - 1].replace(/\.jsonl$/, '');
    return mine.some((r) => base.endsWith(r.session_id));
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
        return liveTranscript(root, rel) ? 'slow' : null;
      default:
        return null;
    }
  }

  function arm(root) {
    if (armed.has(root.id)) return true;
    if (!exists(root.dir)) {
      failed.delete(root.id); // gone: nothing to watch (a required root counts as missing in status())
      return false;
    }
    try {
      if (root.compare) contents.set(root.id, read(path.join(root.dir, root.file)));
      const w = watch(root.dir, { recursive: Boolean(root.recursive), persistent: false }, (_type, filename) => {
        const cls = classify(root, filename);
        if (cls) emit(cls);
      });
      w.on?.('error', (err) => {
        log(`[discovery] watch ${root.id} failed: ${err?.message ?? err} — falling back to the list TTL`);
        failed.set(root.id, String(err?.message ?? err));
        try {
          w.close();
        } catch {}
        armed.delete(root.id);
      });
      armed.set(root.id, w);
      failed.delete(root.id);
      return true;
    } catch (err) {
      if (err?.code !== 'ENOENT') failed.set(root.id, String(err?.message ?? err));
      return false;
    }
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
    failed.clear();
    for (const cls of Object.keys(pending)) {
      clearTimer(pending[cls]);
      pending[cls] = null;
    }
  }

  /**
   * `mode`: `watch` — armed and healthy (the caller may trust silence); `degraded` — a watcher
   * errored or a required root is missing (the caller uses its TTL); `idle` — not started.
   */
  function status() {
    let mode = 'idle';
    if (started) {
      const requiredMissing = roots.some((r) => r.required && !armed.has(r.id));
      mode = failed.size || requiredMissing ? 'degraded' : 'watch';
    }
    return {
      mode,
      events,
      roots: roots.map((r) => ({ id: r.id, armed: armed.has(r.id), ...(failed.has(r.id) ? { error: failed.get(r.id) } : {}) })),
    };
  }

  return { start, stop, rearm, status };
}
