import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createDiscoveryWatcher, discoveryRoots } from '../lib/watch.mjs';

const HOME = '/home/tester';

function fakeFs() {
  const files = new Map(); // abs path -> content
  const dirs = new Set();
  const watchers = []; // { dir, recursive, cb, closed, handlers }
  return {
    files,
    dirs,
    watchers,
    open: () => watchers.filter((w) => !w.closed),
    readFile: (f) => {
      if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(f);
    },
    exists: (d) => dirs.has(d),
    watch: (dir, opts, cb) => {
      const w = { dir, recursive: opts.recursive, cb, closed: false, handlers: {} };
      w.on = (ev, fn) => (w.handlers[ev] = fn);
      w.close = () => (w.closed = true);
      watchers.push(w);
      return w;
    },
    /** Deliver an event to the open watcher on `dir`. */
    fire(dir, filename, type = 'rename') {
      const w = watchers.find((x) => x.dir === dir && !x.closed);
      assert.ok(w, `a watcher on ${dir}`);
      w.cb(type, filename);
    },
  };
}

function fakeClock() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => t && (t.cleared = true),
    flush: () => {
      const due = timers.filter((t) => !t.cleared);
      timers.length = 0;
      for (const t of due) t.fn();
    },
  };
}

const roots = discoveryRoots({ env: {}, home: HOME });
const dir = (id) => roots.find((r) => r.id === id).dir;

function setup({ live = [{ session_id: 'sid-live', harness: 'claude' }], missing = [] } = {}) {
  const fs = fakeFs();
  for (const r of roots) if (!missing.includes(r.id)) fs.dirs.add(r.dir);
  const clock = fakeClock();
  const changes = [];
  const w = createDiscoveryWatcher({
    roots,
    live: () => live,
    onChange: (cls) => changes.push(cls),
    watch: fs.watch,
    readFile: fs.readFile,
    exists: fs.exists,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { fs, clock, changes, w };
}

test('discoveryRoots follows the CLI: HOME, CODEX_HOME, PI_CODING_AGENT_DIR, XDG_STATE_HOME, OVERMIND_*', () => {
  const r = Object.fromEntries(discoveryRoots({ env: {}, home: HOME }).map((x) => [x.id, x.dir]));
  assert.equal(r.sessions, path.join(HOME, '.claude/sessions'));
  assert.equal(r.projects, path.join(HOME, '.claude/projects'));
  assert.equal(r.codex, path.join(HOME, '.codex/sessions'));
  assert.equal(r.pi, path.join(HOME, '.pi/agent/sessions'));
  assert.equal(r.done, path.join(HOME, '.local/state/overmind'));
  assert.equal(r.stacks, path.join(HOME, '.local/state/overmind/stacks'));
  assert.equal(r['codex-hooks'], path.join(HOME, '.local/state/overmind/codex-hooks'));
  assert.equal(discoveryRoots({ env: { XDG_STATE_HOME: '/s' }, home: HOME }).find((x) => x.id === 'codex-hooks').dir, '/s/overmind/codex-hooks');
  const e = Object.fromEntries(
    discoveryRoots({ env: { CODEX_HOME: '/c', PI_CODING_AGENT_DIR: '~/pi', XDG_STATE_HOME: '/s', OVERMIND_STACKS_DIR: '/st', OVERMIND_DONE_STATE: '/d/marks.json', OVERMIND_CODEX_HOOKS_DIR: '/h' }, home: HOME }).map((x) => [x.id, x]),
  );
  assert.equal(e.codex.dir, '/c/sessions');
  assert.equal(e['codex-index'].dir, '/c');
  assert.equal(e.pi.dir, path.join(HOME, 'pi/sessions'));
  assert.equal(e.stacks.dir, '/st');
  assert.equal(e.done.dir, '/d');
  assert.equal(e.done.file, 'marks.json');
  assert.equal(e['codex-hooks'].dir, '/h');
});

test('arms the roots that exist (recursive only for transcripts), skips missing ones, rearm() picks them up later', () => {
  const { fs, w } = setup({ missing: ['codex', 'codex-index', 'pi', 'stacks', 'codex-hooks'] });
  w.start();
  assert.deepEqual(fs.open().map((x) => x.dir).sort(), [dir('sessions'), dir('claude'), dir('projects'), dir('done')].sort());
  assert.equal(fs.open().find((x) => x.dir === dir('projects')).recursive, true);
  assert.equal(fs.open().find((x) => x.dir === dir('sessions')).recursive, false);
  assert.equal(w.status().mode, 'watch', 'optional roots missing is still healthy');
  fs.dirs.add(dir('codex'));
  w.rearm();
  assert.ok(fs.open().some((x) => x.dir === dir('codex')));
  w.start();
  assert.equal(fs.open().length, 5, 'start() is idempotent');
});

test('no registry dir → degraded until it exists', () => {
  const { fs, w } = setup({ missing: ['sessions'] });
  assert.equal(w.status().mode, 'idle');
  w.start();
  assert.equal(w.status().mode, 'degraded');
  fs.dirs.add(dir('sessions'));
  w.rearm();
  assert.equal(w.status().mode, 'watch');
});

test('registry: <pid>.json changes are fast, coalesced per window; keys, tmp files and headless runs are ignored', () => {
  const { fs, clock, changes, w } = setup();
  w.start();
  const s = dir('sessions');
  fs.files.set(path.join(s, '11.json'), JSON.stringify({ pid: 11, kind: 'interactive', entrypoint: 'cli' }));
  fs.fire(s, '11.json');
  fs.fire(s, '11.json', 'change');
  fs.fire(s, '11.abc123.key');
  fs.fire(s, '11.json.tmp');
  clock.flush();
  assert.deepEqual(changes, ['fast'], 'one signal for the window');

  // A `claude -p` child registers and goes away: no signal for either.
  fs.files.set(path.join(s, '22.json'), JSON.stringify({ pid: 22, kind: 'interactive', entrypoint: 'sdk-cli' }));
  fs.fire(s, '22.json');
  fs.files.delete(path.join(s, '22.json'));
  fs.fire(s, '22.json');
  fs.files.set(path.join(s, '23.json'), JSON.stringify({ pid: 23, kind: 'print' }));
  fs.fire(s, '23.json');
  clock.flush();
  assert.deepEqual(changes, ['fast']);

  // An interactive session exits (its file is deleted): fast.
  fs.files.delete(path.join(s, '11.json'));
  fs.fire(s, '11.json');
  clock.flush();
  assert.deepEqual(changes, ['fast', 'fast']);
});

test('registry: a pid recorded as headless that reads interactive later signals its exit (missed delete, reused pid)', () => {
  const { fs, clock, changes, w } = setup();
  w.start();
  const s = dir('sessions');
  const f = path.join(s, '33.json');
  fs.files.set(f, JSON.stringify({ pid: 33, kind: 'interactive', entrypoint: 'sdk-cli' }));
  fs.fire(s, '33.json'); // headless; its delete is then missed
  fs.files.set(f, JSON.stringify({ pid: 33, kind: 'interactive', entrypoint: 'cli' }));
  fs.fire(s, '33.json'); // the pid is reused by a real session
  clock.flush();
  assert.deepEqual(changes, ['fast']);
  fs.files.delete(f);
  fs.fire(s, '33.json');
  clock.flush();
  assert.deepEqual(changes, ['fast', 'fast'], 'its clean exit is news');
});

test('state dir: done.json only — snapshot.json, its lock and temp files never signal', () => {
  const { fs, clock, changes, w } = setup();
  w.start();
  const st = dir('done');
  for (const f of ['snapshot.json', 'snapshot.json.lock', 'snapshot.json.123.abcd.tmp', 'inbox.json', 'stacks']) fs.fire(st, f);
  clock.flush();
  assert.deepEqual(changes, []);
  fs.fire(st, 'done.json');
  clock.flush();
  assert.deepEqual(changes, ['fast']);
  fs.fire(dir('stacks'), 's-1.json');
  fs.fire(dir('stacks'), 's-1.json.tmp');
  clock.flush();
  assert.deepEqual(changes, ['fast', 'fast']);
});

test('codex-hooks sidecars: the hook\'s temp write is dropped, its rename is one fast change; a dir made after start is armed by rearm()', () => {
  const { fs, clock, changes, w } = setup({ missing: ['codex-hooks'] });
  w.start();
  const h = dir('codex-hooks');
  assert.ok(!fs.open().some((x) => x.dir === h), 'missing before `codex hooks install` makes it');
  fs.dirs.add(h);
  w.rearm();
  const id = '01a1a87a-0000-7000-8000-000000000000';
  fs.fire(h, `${id}.json.tmp`);
  fs.fire(h, '.DS_Store');
  clock.flush();
  assert.deepEqual(changes, [], 'temp and dot files never signal');
  fs.fire(h, `${id}.json.tmp`);
  fs.fire(h, `${id}.json`);
  clock.flush();
  assert.deepEqual(changes, ['fast'], 'one write (temp + rename) → one fast list');
  fs.fire(h, `${id}.json`); // pruned after 1 h, or cleared
  clock.flush();
  assert.deepEqual(changes, ['fast', 'fast']);
});

test('names file: only a content change signals (list rewrites it unchanged)', () => {
  const { fs, clock, changes, w } = setup();
  const f = path.join(dir('claude'), 'overmind-names.json');
  fs.files.set(f, '{"a":"one"}');
  w.start();
  fs.fire(dir('claude'), 'overmind-names.json', 'change');
  fs.fire(dir('claude'), 'history.jsonl', 'change');
  clock.flush();
  assert.deepEqual(changes, []);
  fs.files.set(f, '{"a":"two"}');
  fs.fire(dir('claude'), 'overmind-names.json', 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast']);
});

test('transcripts: a live session’s files (incl. subagents/, tool-results/) are slow; others are dropped', () => {
  const { fs, clock, changes, w } = setup();
  w.start();
  const p = dir('projects');
  fs.fire(p, '-home-tester-x/sid-other.jsonl', 'change');
  fs.fire(p, '-home-tester-x/sid-other/subagents/a.jsonl', 'change');
  clock.flush();
  assert.deepEqual(changes, []);
  fs.fire(p, '-home-tester-x/sid-live.jsonl', 'change');
  clock.flush();
  fs.fire(p, '-home-tester-x/sid-live/tool-results/t1.txt');
  fs.fire(p, '-home-tester-x/sid-live/subagents/agent-1.jsonl', 'change');
  clock.flush();
  assert.deepEqual(changes, ['slow', 'slow']);
});

test('Codex / pi: the live session’s rollout passes; any rollout passes while one has no transcript yet', () => {
  const live = [{ session_id: '01a1-uuid', harness: 'codex' }, { session_id: 'p1', harness: 'pi' }];
  const { fs, clock, changes, w } = setup({ live });
  w.start();
  fs.fire(dir('codex'), '2026/11/04/rollout-2026-11-04T10-00-00-other.jsonl', 'change');
  fs.fire(dir('pi'), '--home-tester-x--/2026-11-04T10-00-00-000Z_p2.jsonl', 'change');
  clock.flush();
  assert.deepEqual(changes, []);
  fs.fire(dir('codex'), '2026/11/04/rollout-2026-11-04T10-00-00-01a1-uuid.jsonl', 'change');
  clock.flush();
  fs.fire(dir('pi'), '--home-tester-x--/2026-11-04T10-00-00-000Z_p1.jsonl', 'change');
  clock.flush();
  fs.fire(dir('codex-index'), 'session_index.jsonl', 'change');
  fs.fire(dir('codex-index'), 'auth.json', 'change');
  clock.flush();
  assert.deepEqual(changes, ['slow', 'slow', 'slow']);

  live.push({ session_id: 'pid-42', harness: 'codex', pid: 42 });
  fs.fire(dir('codex'), '2026/11/04/rollout-2026-11-04T10-01-00-new.jsonl', 'change');
  clock.flush();
  assert.deepEqual(changes, ['slow', 'slow', 'slow', 'slow'], 'a fresh Codex session’s first rollout');
});

test('before the first list every transcript passes (unknown is never dropped)', () => {
  const { fs, clock, changes, w } = setup({ live: null });
  w.start();
  fs.fire(dir('projects'), '-x/anything.jsonl', 'change');
  clock.flush();
  assert.deepEqual(changes, ['slow']);
});

test('fast and slow coalesce separately', () => {
  const { fs, clock, changes, w } = setup();
  w.start();
  fs.files.set(path.join(dir('sessions'), '1.json'), '{"kind":"interactive"}');
  fs.fire(dir('sessions'), '1.json');
  fs.fire(dir('projects'), '-x/sid-live.jsonl');
  fs.fire(dir('sessions'), '1.json');
  fs.fire(dir('projects'), '-x/sid-live.jsonl');
  clock.flush();
  assert.deepEqual(changes.sort(), ['fast', 'slow']);
  assert.equal(w.status().events, 4);
});

test('a watcher error → that watcher closed, degraded; rearm() restores watch', () => {
  const { fs, w } = setup();
  w.start();
  const pw = fs.open().find((x) => x.dir === dir('projects'));
  pw.handlers.error(new Error('EMFILE'));
  assert.equal(pw.closed, true);
  const st = w.status();
  assert.equal(st.mode, 'degraded');
  assert.equal(st.roots.find((r) => r.id === 'projects').error, 'EMFILE');
  w.rearm();
  assert.equal(w.status().mode, 'watch');
  assert.ok(fs.open().some((x) => x.dir === dir('projects')));
});

test('the watched root itself removed (rm -rf ~/.claude/sessions) → fast, degraded, re-armed when it is back (test NIT-1)', () => {
  const { fs, clock, changes, w } = setup();
  w.start();
  assert.equal(w.status().mode, 'watch');
  const before = fs.open().find((x) => x.dir === dir('sessions'));
  fs.dirs.delete(dir('sessions'));
  fs.fire(dir('sessions'), 'sessions'); // FSEvents: one event named after the root, no per-file ones
  assert.equal(before.closed, true);
  clock.flush();
  assert.deepEqual(changes, ['fast']);
  const st = w.status();
  assert.equal(st.mode, 'degraded', 'a required root that is gone is not trusted');
  assert.equal(st.roots.find((r) => r.id === 'sessions').armed, false);
  w.rearm(); // still gone: stays degraded, no watcher on a missing dir
  assert.equal(w.status().mode, 'degraded');
  fs.dirs.add(dir('sessions'));
  w.rearm(); // the next run after it reappears
  assert.equal(w.status().mode, 'watch');
  assert.equal(fs.open().filter((x) => x.dir === dir('sessions')).length, 1);
});

test('the root replaced under the watcher (removed and recreated) → fast, a fresh watch on the new dir', () => {
  const { fs, clock, changes, w } = setup();
  w.start();
  const before = fs.open().find((x) => x.dir === dir('sessions'));
  fs.fire(dir('sessions'), 'sessions'); // the dir exists again by the time the event lands
  assert.equal(before.closed, true);
  const now = fs.open().filter((x) => x.dir === dir('sessions'));
  assert.equal(now.length, 1);
  assert.notEqual(now[0], before);
  clock.flush();
  assert.deepEqual(changes, ['fast']);
  assert.equal(w.status().mode, 'watch');
});

test('stop() closes everything; warm → idle → warm cycles keep the watcher count constant', () => {
  const { fs, w } = setup();
  for (let i = 0; i < 3; i++) {
    w.start();
    assert.equal(fs.open().length, roots.length);
    w.stop();
    assert.equal(fs.open().length, 0);
    assert.equal(w.status().mode, 'idle');
  }
  w.rearm();
  assert.equal(fs.open().length, 0, 'rearm() does not start a stopped watcher');
});
