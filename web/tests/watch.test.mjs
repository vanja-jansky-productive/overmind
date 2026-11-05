import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createDiscoveryWatcher, discoveryRoots, readFileTail, turnState } from '../lib/watch.mjs';

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
    /** Deliver an event to every open watcher on `dir`. */
    fire(dir, filename, type = 'rename') {
      const on = watchers.filter((x) => x.dir === dir && !x.closed);
      assert.ok(on.length, `a watcher on ${dir}`);
      for (const w of on) if (!w.closed) w.cb(type, filename);
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
    live: typeof live === 'function' ? live : () => live,
    onChange: (cls) => changes.push(cls),
    watch: fs.watch,
    readFile: fs.readFile,
    readTail: (f, n) => (fs.files.has(f) ? fs.files.get(f).slice(-n) : null),
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
  // OVERMIND_CODEX_HOOKS_DIR as the CLI reads it (hooks_dir_override): `~/…` expanded, relative ignored.
  const hooks = (v) => discoveryRoots({ env: { OVERMIND_CODEX_HOOKS_DIR: v }, home: HOME }).find((x) => x.id === 'codex-hooks').dir;
  assert.equal(hooks('~/hooks'), path.join(HOME, 'hooks'));
  assert.equal(hooks('hooks'), path.join(HOME, '.local/state/overmind/codex-hooks'));
  assert.equal(hooks('./x'), path.join(HOME, '.local/state/overmind/codex-hooks'));
});

test('arms the roots that exist (recursive only for transcripts), skips missing ones, rearm() picks them up later', () => {
  const { fs, w } = setup({ missing: ['codex', 'codex-index', 'pi', 'stacks', 'codex-hooks'] });
  w.start();
  // + the state dir twice more: the parent of the missing stacks and codex-hooks roots (N3)
  assert.deepEqual(fs.open().map((x) => x.dir).sort(), [dir('sessions'), dir('claude'), dir('projects'), dir('done'), dir('done'), dir('done')].sort());
  assert.equal(fs.open().find((x) => x.dir === dir('projects')).recursive, true);
  assert.equal(fs.open().find((x) => x.dir === dir('sessions')).recursive, false);
  assert.equal(w.status().mode, 'watch', 'optional roots missing is still healthy');
  fs.dirs.add(dir('codex'));
  w.rearm();
  assert.ok(fs.open().some((x) => x.dir === dir('codex')));
  w.start();
  assert.equal(fs.open().length, 7, 'start() is idempotent');
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

test('review-38 N3: a root created after start is armed as it appears (its parent is watched meanwhile), and signals fast', () => {
  const { fs, clock, changes, w } = setup({ missing: ['codex-hooks', 'sessions'] });
  w.start();
  const h = dir('codex-hooks');
  const parentWatchers = () => fs.open().filter((x) => x.dir === path.dirname(h) && x !== fs.open().find((y) => y.dir === dir('done')));
  assert.equal(parentWatchers().length, 1, 'the state dir is watched for codex-hooks');
  fs.fire(path.dirname(h), 'snapshot.json');
  clock.flush();
  assert.deepEqual(changes, [], 'other names in the parent are no news');
  fs.dirs.add(h); // `overmind codex hooks install`
  fs.fire(path.dirname(h), 'codex-hooks');
  assert.ok(fs.open().some((x) => x.dir === h), 'armed without waiting for a list');
  assert.equal(parentWatchers().length, 0, 'the parent watch is closed');
  clock.flush();
  assert.deepEqual(changes, ['fast']);

  assert.equal(w.status().mode, 'degraded');
  fs.dirs.add(dir('sessions')); // Claude Code's first run on this host
  fs.fire(dir('claude'), 'sessions');
  assert.equal(w.status().mode, 'watch');
  w.stop();
  assert.equal(fs.open().length, 0, 'stop() closes parent watches too');
});

test('review-38 N2: a replaced watcher’s late error leaves the new one armed', () => {
  const { fs, w } = setup();
  w.start();
  const old = fs.open().find((x) => x.dir === dir('sessions'));
  fs.fire(dir('sessions'), 'sessions'); // replaced: a fresh watcher on the new dir
  const fresh = fs.open().find((x) => x.dir === dir('sessions'));
  assert.notEqual(fresh, old);
  old.handlers.error(new Error('late'));
  assert.equal(fresh.closed, false);
  assert.equal(w.status().mode, 'watch');
  assert.equal(w.status().roots.find((r) => r.id === 'sessions').armed, true);
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

const codexLine = (type) => JSON.stringify({ timestamp: '2026-11-04T10:00:00Z', type: 'event_msg', payload: { type } });
const piLine = (role, stopReason) => JSON.stringify({ type: 'message', message: { role, ...(stopReason ? { stopReason } : {}) } });

test('Codex / pi: a listed row’s rollout mid-turn is slow; session_index.jsonl is slow, other files in CODEX_HOME dropped', () => {
  const live = [{ session_id: '01a1-uuid', harness: 'codex', status: 'busy' }, { session_id: 'p1', harness: 'pi', status: 'busy' }];
  const { fs, clock, changes, w } = setup({ live });
  w.start();
  const rollout = path.join(dir('codex'), '2026/11/04/rollout-2026-11-04T10-00-00-01a1-uuid.jsonl');
  fs.files.set(rollout, [codexLine('task_started'), '{"type":"response_item","payload":{"type":"message"}}'].join('\n'));
  fs.fire(dir('codex'), '2026/11/04/rollout-2026-11-04T10-00-00-01a1-uuid.jsonl', 'change');
  clock.flush();
  fs.fire(dir('pi'), '--home-tester-x--/2026-11-04T10-00-00-000Z_p1.jsonl', 'change');
  clock.flush();
  fs.fire(dir('codex-index'), 'session_index.jsonl', 'change');
  fs.fire(dir('codex-index'), 'auth.json', 'change');
  clock.flush();
  assert.deepEqual(changes, ['slow', 'slow', 'slow'], 'mid-turn writes, and a tail with no boundary, are slow');
});

test('review-38 S1: a Codex / pi session started outside the web UI is fast the first time, then slow once per list', () => {
  let live = [{ session_id: 'sid-live', harness: 'claude' }]; // no Codex row at all
  const { fs, clock, changes, w } = setup({ live: () => live });
  w.start();
  const fresh = '2026/11/04/rollout-2026-11-04T10-01-00-new-id.jsonl';
  fs.fire(dir('codex'), fresh, 'change');
  fs.fire(dir('codex'), fresh, 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast'], 'its first prompt: the row appears within the fast gap');
  fs.fire(dir('codex'), fresh, 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast'], 'more writes before the next list are dropped');
  live = [...live]; // a list ran, and still no row owns it (a sub-agent's rollout)
  fs.fire(dir('codex'), fresh, 'change');
  fs.fire(dir('codex'), fresh, 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast', 'slow'], 'once per list, slow');
  fs.fire(dir('pi'), '--home-tester-x--/2026-11-04T10-00-00-000Z_p9.jsonl', 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast', 'slow', 'fast'], 'pi too');
  fs.fire(dir('codex'), '2026/11/05', 'rename'); // a day dir: not a rollout
  clock.flush();
  assert.equal(changes.length, 3);
  w.stop();
  w.start();
  fs.fire(dir('codex'), fresh, 'change');
  clock.flush();
  assert.equal(changes.at(-1), 'fast', 'stop() forgets what it saw');
});

test('review-38 S2: a Codex / pi turn boundary the last list does not show is fast (busy ↔ idle within the fast gap)', () => {
  const live = [
    { session_id: '01a1-uuid', harness: 'codex', status: 'busy' },
    { session_id: '02b2-uuid', harness: 'codex', status: 'waiting' },
    { session_id: 'p1', harness: 'pi', status: 'idle' },
  ];
  const { fs, clock, changes, w } = setup({ live });
  w.start();
  const rel = '2026/11/04/rollout-2026-11-04T10-00-00-01a1-uuid.jsonl';
  const file = path.join(dir('codex'), rel);
  fs.files.set(file, [codexLine('task_started'), codexLine('agent_message'), codexLine('task_complete'), codexLine('token_count'), '{"type":"ev'].join('\n'));
  fs.fire(dir('codex'), rel, 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast'], 'busy row, the turn ended: idle is due within the fast gap');
  live[0].status = 'idle';
  fs.fire(dir('codex'), rel, 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast', 'slow'], 'listed idle: no news');
  fs.files.set(file, `${fs.files.get(file)}\n${codexLine('task_started')}`);
  fs.fire(dir('codex'), rel, 'change');
  clock.flush();
  assert.deepEqual(changes, ['fast', 'slow', 'fast'], 'a new turn: busy');

  const waiting = '2026/11/04/rollout-2026-11-04T10-00-00-02b2-uuid.jsonl';
  fs.files.set(path.join(dir('codex'), waiting), [codexLine('task_started'), codexLine('exec_approval_request')].join('\n'));
  fs.fire(dir('codex'), waiting, 'change');
  clock.flush();
  assert.deepEqual(changes.at(-1), 'slow', 'a waiting row counts as busy');

  const pi = '--home-tester-x--/2026-11-04T10-00-00-000Z_p1.jsonl';
  fs.files.set(path.join(dir('pi'), pi), [piLine('assistant', 'stop'), piLine('user')].join('\n'));
  fs.fire(dir('pi'), pi, 'change');
  clock.flush();
  assert.deepEqual(changes.at(-1), 'fast', 'pi: a prompt on an idle row');
});

test('turnState mirrors the list: the last boundary in the tail wins; none → null', () => {
  assert.equal(turnState('codex', [codexLine('task_started'), codexLine('item_completed')].join('\n')), 'busy');
  assert.equal(turnState('codex', [codexLine('task_started'), codexLine('turn_aborted'), codexLine('token_count')].join('\n')), 'idle');
  assert.equal(turnState('codex', codexLine('item_completed')), null);
  assert.equal(turnState('codex', '{"type":"response_item","payload":{"type":"task_complete"}}'), null, 'only event_msg lines');
  assert.equal(turnState('pi', [piLine('user'), piLine('assistant', 'toolUse')].join('\n')), 'busy');
  assert.equal(turnState('pi', [piLine('user'), piLine('assistant', 'stop'), '{"type":"session_info"}'].join('\n')), 'idle');
  assert.equal(turnState('pi', null), null);
});

test('readFileTail reads the end of a real file', async () => {
  const os = await import('node:os');
  const nfs = await import('node:fs');
  const d = nfs.mkdtempSync(path.join(os.tmpdir(), 'overmind-watch-'));
  try {
    const f = path.join(d, 'r.jsonl');
    nfs.writeFileSync(f, 'a'.repeat(100) + 'tail');
    assert.equal(readFileTail(f, 4), 'tail');
    assert.equal(readFileTail(f, 1000).length, 104);
    assert.equal(readFileTail(path.join(d, 'none'), 4), null);
  } finally {
    nfs.rmSync(d, { recursive: true, force: true });
  }
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
