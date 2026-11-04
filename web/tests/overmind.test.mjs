import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOvermind } from '../lib/overmind.mjs';

// Local discovery decided by a watcher (lib/watch.mjs) — fakes only: a fake CLI, watcher and clock.

function fakeClock(start = 1_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    advance: (ms) => (t += ms),
    setTimer: (fn, ms) => {
      const x = { fn, at: t + ms, cleared: false };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => x && (x.cleared = true),
    /** Run the timers due by now. */
    run: () => {
      for (const x of timers.splice(0)) {
        if (x.cleared) continue;
        if (x.at <= t) x.fn();
        else timers.push(x);
      }
    },
  };
}

function fakeWatcher(mode = 'watch') {
  const w = { mode, starts: 0, stops: 0, rearms: 0, running: false };
  return Object.assign(w, {
    start: () => ((w.starts += 1), (w.running = true)),
    stop: () => ((w.stops += 1), (w.running = false)),
    rearm: () => (w.rearms += 1),
    status: () => ({ mode: w.running ? w.mode : 'idle', events: 0, roots: [] }),
  });
}

function fakeCli() {
  const cli = { runs: 0, gate: null };
  cli.list = async () => {
    cli.runs += 1;
    const n = cli.runs;
    if (cli.gate) await cli.gate;
    return [{ session_id: `s${n}`, status: 'idle', updated_at: n }];
  };
  return cli;
}

function setup({ mode = 'watch', ...opts } = {}) {
  const clock = fakeClock();
  const cli = fakeCli();
  const watcher = fakeWatcher(mode);
  const om = createOvermind({ cli, self: 'laptop', watcher, ...clock, ...opts });
  return { clock, cli, watcher, om };
}

test('armed and quiet: the last list is served (fetchedAt restamped) until the 30 s age bound', async () => {
  const { clock, cli, watcher, om } = setup();
  const first = await om.localHost();
  assert.equal(cli.runs, 1);
  assert.equal(watcher.starts, 1, 'the first caller starts the watcher');
  assert.equal(first.fetchedAt, clock.now());
  clock.advance(29_000);
  const later = await om.localHost();
  assert.equal(cli.runs, 1, 'no change, under the bound: no CLI');
  assert.equal(later.fetchedAt, clock.now(), 'checked now');
  assert.deepEqual(later.sessions, first.sessions);
  clock.advance(1_000);
  await om.localHost();
  assert.equal(cli.runs, 2, 'at 30 s it lists again');
  assert.equal(om.status().listRuns, 2);
  assert.equal(om.status().mode, 'watch');
});

test('a signal right after a run is served until its gap, then lists once', async () => {
  const { clock, cli, om } = setup();
  await om.localHost();
  clock.advance(200);
  const due = om.signal('fast');
  assert.equal(due, clock.now() + 800, 'the last run started 200 ms ago, gap 1 s');
  await om.localHost();
  assert.equal(cli.runs, 1, 'not due yet');
  clock.advance(800);
  await om.localHost();
  await om.localHost();
  assert.equal(cli.runs, 2, 'due: one list, then clean');
});

test('a quiet host lists on the leading edge; fast after slow takes the earlier dueAt', async () => {
  const { clock, cli, om } = setup();
  await om.localHost();
  clock.advance(10_000);
  assert.equal(om.signal('slow'), clock.now(), 'last run 10 s ago: due now');
  await om.localHost();
  assert.equal(cli.runs, 2);
  clock.advance(100);
  assert.equal(om.signal('slow'), clock.now() + 4_900);
  assert.equal(om.signal('fast'), clock.now() + 900, 'the earliest wins');
  clock.advance(900);
  await om.localHost();
  assert.equal(cli.runs, 3);
});

test('a change during an in-flight list keeps it dirty; force chains a new run behind it', async () => {
  const { cli, om } = setup();
  await om.localHost();
  let release;
  cli.gate = new Promise((r) => (release = r));
  const stale = om.localHost({ force: true }); // run 2 starts
  await new Promise((r) => setImmediate(r));
  om.invalidate(); // a mutation while it runs
  const fresh = om.localHost({ force: true });
  cli.gate = null;
  release();
  assert.equal((await stale).sessions[0].session_id, 's2');
  assert.equal((await fresh).sessions[0].session_id, 's3', 'the forced call got a list that started after the change');
  assert.equal(cli.runs, 3);
});

test('force joins an in-flight run of the same generation', async () => {
  const { cli, om } = setup();
  let release;
  cli.gate = new Promise((r) => (release = r));
  const a = om.localHost();
  const b = om.localHost({ force: true });
  release();
  await Promise.all([a, b]);
  assert.equal(cli.runs, 1);
});

test('no watcher / degraded: the plain TTL (2 s), invalidate() forces the next list', async () => {
  for (const mode of ['degraded', null]) {
    const clock = fakeClock();
    const cli = fakeCli();
    const watcher = mode ? fakeWatcher(mode) : null;
    const om = createOvermind({ cli, self: 'l', watcher, ttlMs: 2000, ...clock });
    const first = await om.localHost();
    clock.advance(500);
    if (watcher) om.signal('fast'); // a degraded watcher's signals don't shorten the TTL
    clock.advance(1000);
    const again = await om.localHost();
    assert.equal(cli.runs, 1, `${mode}: served from cache`);
    assert.equal(again, first, `${mode}: the cached object as is (no restamp)`);
    om.invalidate();
    await om.localHost();
    assert.equal(cli.runs, 2, `${mode}: invalidated`);
    clock.advance(2000);
    await om.localHost();
    assert.equal(cli.runs, 3, `${mode}: TTL expired`);
    assert.equal(om.status().mode, mode ?? 'ttl');
  }
});

test('a failed list is not trusted past the TTL even when armed', async () => {
  const clock = fakeClock();
  let fail = true;
  let runs = 0;
  const cli = { list: async () => (runs++, fail ? Promise.reject(new Error('boom')) : []) };
  const om = createOvermind({ cli, watcher: fakeWatcher(), ...clock });
  assert.equal((await om.localHost()).ok, false);
  clock.advance(2_500);
  fail = false;
  assert.equal((await om.localHost()).ok, true);
  assert.equal(runs, 2);
});

test('idleAfterMs without a caller stops the watcher; the next caller restarts it and lists', async () => {
  const { clock, cli, watcher, om } = setup({ idleAfterMs: 90_000 });
  await om.localHost();
  clock.advance(60_000);
  await om.localHost(); // 60 s: past the 30 s bound → run 2
  clock.advance(60_000);
  clock.run(); // 120 s: asked 60 s ago → still warm
  assert.equal(watcher.stops, 0);
  clock.advance(30_000);
  clock.run();
  assert.equal(watcher.stops, 1, 'idle 90 s → stopped');
  assert.equal(om.status().mode, 'idle');
  await om.localHost();
  assert.equal(watcher.starts, 2);
  assert.equal(cli.runs, 3, 'events may have been missed while idle: list');
  om.stop();
  assert.equal(watcher.running, false);
});

test('each run re-arms missing watch roots; peek() reads the last list without listing', async () => {
  const { cli, watcher, om } = setup();
  assert.equal(om.peek(), null);
  await om.localHost();
  assert.equal(watcher.rearms, 1);
  assert.equal(om.peek().sessions[0].session_id, 's1');
  assert.equal(cli.runs, 1);
});
