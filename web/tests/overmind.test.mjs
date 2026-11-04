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

test('a waiting Codex row has no file signal for its end: the list is reused for the TTL only', async () => {
  const { clock, cli, om } = setup();
  let rows = [{ session_id: 'c1', harness: 'codex', status: 'waiting' }];
  cli.list = async () => ((cli.runs += 1), rows);
  await om.localHost();
  clock.advance(1_999);
  await om.localHost();
  assert.equal(cli.runs, 1, 'under the TTL: reused');
  clock.advance(1);
  rows = [{ session_id: 'c1', harness: 'codex', status: 'busy' }]; // approved in the TUI
  assert.equal((await om.localHost()).sessions[0].status, 'busy');
  assert.equal(cli.runs, 2);
  clock.advance(29_000);
  await om.localHost();
  assert.equal(cli.runs, 2, 'no waiting Codex row: back to the safety bound');
  // A waiting Claude row has its own file signal (sessions/<pid>.json): the safety bound.
  rows = [{ session_id: 'k1', harness: 'claude', status: 'waiting' }];
  clock.advance(1_000);
  await om.localHost();
  clock.advance(5_000);
  await om.localHost();
  assert.equal(cli.runs, 3);
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

/** A CLI whose every list waits until `release()`; `pending` counts the lists in flight. */
function gatedCli() {
  const cli = { runs: 0, waiting: [] };
  cli.list = () => {
    cli.runs += 1;
    const n = cli.runs;
    return new Promise((r) => cli.waiting.push(() => r([{ session_id: `s${n}`, status: 'busy', updated_at: n }])));
  };
  cli.release = () => cli.waiting.shift()?.();
  return cli;
}
const tick = () => new Promise((r) => setImmediate(r));

test('an event during every run → at most one run per gap (dueAt counts from the latest run)', async () => {
  const clock = fakeClock();
  const cli = gatedCli();
  const om = createOvermind({ cli, watcher: fakeWatcher(), ...clock, gaps: { fast: 1000, slow: 5000 } });
  let p = om.localHost();
  cli.release();
  await p;
  // A busy fleet: a slow event every 250 ms, one of them always during the list (which takes 500 ms),
  // and a caller (tick, peer, poke) every 250 ms. Over 20 s the 5 s gap allows 4 or 5 runs.
  const start = cli.runs;
  for (let i = 0; i < 80; i++) {
    clock.advance(250);
    om.signal('slow');
    p = om.localHost();
    await tick();
    if (cli.waiting.length) {
      clock.advance(250);
      om.signal('slow'); // lands mid-run
      clock.advance(250);
      cli.release();
      i += 2;
    }
    await p;
  }
  const runs = cli.runs - start;
  assert.ok(runs >= 3 && runs <= 5, `${runs} runs in 20 s with a 5 s gap`);
});

test('stuck-state repro (review B1): after events landed mid-run, a 5 s gap still means ≤ 1 run in 5 s', async () => {
  // Ported from the reviewer's probe: ten due runs, each with a slow event during it; then a slow
  // event and a caller every 300 ms for 3 s (each again with an event mid-run).
  const clock = fakeClock();
  const cli = gatedCli();
  const om = createOvermind({ cli, watcher: fakeWatcher(), ...clock, gaps: { fast: 1000, slow: 5000 } });
  let p = om.localHost();
  cli.release();
  await p;
  for (let i = 0; i < 10; i++) {
    clock.advance(6000);
    om.signal('slow');
    p = om.localHost();
    await tick();
    assert.equal(cli.waiting.length, 1, `run ${i}: due after 6 s`);
    clock.advance(300);
    om.signal('slow');
    cli.release();
    await p;
  }
  assert.equal(cli.runs, 11);
  const before = cli.runs;
  for (let i = 0; i < 10; i++) {
    clock.advance(300);
    om.signal('slow');
    p = om.localHost();
    await tick();
    if (cli.waiting.length) {
      clock.advance(200);
      om.signal('slow');
      cli.release();
    }
    await p;
  }
  assert.ok(cli.runs - before <= 1, `${cli.runs - before} runs in ~5 s with slowGapMs 5000 (was 10)`);
});

test('a list longer than the gap: a validated caller once the change is due chains, not joins (review S1)', async () => {
  const clock = fakeClock();
  const cli = gatedCli();
  const om = createOvermind({ cli, watcher: fakeWatcher(), ...clock });
  let p = om.localHost();
  cli.release();
  await p;
  clock.advance(10_000);
  const peer = om.localHost({ force: true }); // a peer's ?local=1 / the tick starts run 2 at t0
  await tick();
  clock.advance(100); // a registry rewrite at t0+0.1 …
  const due = om.signal('fast'); // … signalled at t0+0.35
  assert.equal(due, clock.now() + 900, 'due 1 s after run 2 started');
  clock.advance(250);
  assert.equal((await om.localHost()).sessions[0].session_id, 's1', 'not due yet: the last complete list');
  assert.equal(cli.runs, 2);
  clock.advance(650); // t0+1 s: the poke — run 2 is still listing
  const poked = om.localHost();
  await tick();
  assert.equal(cli.runs, 2, 'chained behind run 2, not started in parallel');
  cli.release();
  assert.equal((await peer).sessions[0].session_id, 's2');
  await tick();
  assert.equal(cli.runs, 3, 'run 3 starts as run 2 ends');
  cli.release();
  assert.equal((await poked).sessions[0].session_id, 's3', 'the poked build sees a list that started after the change');
});

test('a signal during a run that covers a mutation: callers join that run, never the older list (review r2 SHOULD-1)', async () => {
  const clock = fakeClock();
  const cli = gatedCli();
  const om = createOvermind({ cli, watcher: fakeWatcher(), ...clock });
  let p = om.localHost();
  cli.release();
  await p; // run 1: s1, the list before the mutation
  clock.advance(10_000);
  om.invalidate(); // a kill / spawn
  const forced = om.localHost({ force: true }); // the snapshot rebuild starts run 2
  await tick();
  clock.advance(100);
  const before = om.localHost(); // a peer's ?local=1 before any signal
  clock.advance(100);
  om.signal('slow'); // a transcript append mid-run 2: dueAt moves to run 2's start + 5 s
  clock.advance(100);
  const after = om.localHost(); // must not get s1 while run 2 (which has the mutation) lists
  const raced = await Promise.race([after, tick().then(() => 'pending')]);
  assert.equal(raced, 'pending', 'joined run 2 instead of serving the pre-mutation list');
  assert.equal(cli.runs, 2);
  cli.release();
  for (const x of [forced, before, after]) assert.equal((await x).sessions[0].session_id, 's2');
  assert.equal(cli.runs, 2, 'joined, no extra run');
});

test('a signal during a run started by an earlier change: callers join it; a same-gen run does not hide the cache', async () => {
  const clock = fakeClock();
  const cli = gatedCli();
  const om = createOvermind({ cli, watcher: fakeWatcher(), ...clock });
  let p = om.localHost();
  cli.release();
  await p;
  clock.advance(2000);
  om.signal('fast'); // due now (the gap since run 1 has passed)
  const run2 = om.localHost(); // starts run 2 at the new gen
  await tick();
  assert.equal(cli.runs, 2);
  clock.advance(100);
  om.signal('slow'); // not due until run 2's start + 5 s
  const peer = om.localHost();
  assert.equal(await Promise.race([peer, tick().then(() => 'pending')]), 'pending', 'joins run 2, which has the fast change');
  cli.release();
  assert.equal((await peer).sessions[0].session_id, 's2');
  await run2;
  // Clean and quiet: a run at the same gen (a force with no change since) does not hide the cache.
  clock.advance(5000); // the slow change is due: run 3 lists it
  p = om.localHost();
  await tick();
  cli.release();
  await p;
  clock.advance(1000);
  const forced = om.localHost({ force: true });
  await tick();
  assert.equal(cli.runs, 4);
  assert.equal((await om.localHost()).sessions[0].session_id, 's3', 'served at once: run 4 has no change the cache lacks');
  cli.release();
  await forced;
});

test('ttl mode: non-force callers still join an in-flight list after invalidate (kill-switch = before)', async () => {
  const clock = fakeClock();
  const cli = gatedCli();
  const om = createOvermind({ cli, watcher: null, ...clock });
  const a = om.localHost();
  await tick();
  om.invalidate();
  const b = om.localHost();
  cli.release();
  assert.equal(await a, await b);
  assert.equal(cli.runs, 1);
});

test('degraded: one invalidate() forces one list, not every list while signals keep coming (N2)', async () => {
  const clock = fakeClock();
  const cli = gatedCli();
  const om = createOvermind({ cli, watcher: fakeWatcher('degraded'), ttlMs: 2000, ...clock });
  let p = om.localHost();
  cli.release();
  await p;
  om.invalidate();
  p = om.localHost(); // run 2, started after the invalidate
  await tick();
  om.signal('fast'); // the still-armed roots keep signalling
  cli.release();
  await p;
  clock.advance(500);
  om.signal('slow');
  await om.localHost();
  assert.equal(cli.runs, 2, 'inside the TTL: served from cache');
});

test('dirty but not yet due: the list is served with its own fetchedAt, not restamped (N3)', async () => {
  const { clock, om } = setup();
  const first = await om.localHost();
  clock.advance(200);
  om.signal('slow');
  clock.advance(1000);
  const again = await om.localHost();
  assert.equal(again.fetchedAt, first.fetchedAt, 'known stale: keeps the list time');
});

test('status(): ttl mode reports only what applies; a watcher adds its bound, gaps and roots (N4)', async () => {
  const ttl = createOvermind({ cli: fakeCli(), ...fakeClock() });
  assert.deepEqual(Object.keys(ttl.status()).sort(), ['lastListAt', 'listRuns', 'mode', 'ttlMs']);
  const { om } = setup();
  await om.localHost();
  const s = om.status();
  assert.equal(s.mode, 'watch');
  for (const k of ['safetyMs', 'gaps', 'events', 'roots']) assert.ok(k in s, k);
});
