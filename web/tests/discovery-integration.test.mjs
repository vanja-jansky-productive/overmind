// Integration test (the unit tests are watch.test.mjs and overmind.test.mjs).
// Discovery on change with REAL fs.watch (FSEvents on macOS, inotify on Linux) in a temp home:
// the watcher, lib/overmind.mjs and lib/snapshot.mjs wired as server.mjs / lib/api.mjs do, with a
// fake CLI that counts runs and writes what `overmind list` writes (snapshot.json, its lock, the
// names cache unchanged). Timing budgets are generous; OVERMIND_TEST_FSWATCH=0 skips it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDiscoveryWatcher, discoveryRoots } from '../lib/watch.mjs';
import { createOvermind } from '../lib/overmind.mjs';
import { createSnapshot } from '../lib/snapshot.mjs';

const supported = ['darwin', 'linux'].includes(process.platform) && process.env.OVERMIND_TEST_FSWATCH !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('discovery lists on a watched change, not on silence or its own writes', { skip: !supported && 'needs recursive fs.watch (darwin/linux); OVERMIND_TEST_FSWATCH=0 opts out', timeout: 60_000 }, async (t) => {
  // FSEvents reports resolved paths: /var → /private/var on macOS.
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'overmind-watch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(home, 'state'), CODEX_HOME: path.join(home, 'codex'), PI_CODING_AGENT_DIR: path.join(home, 'pi') };
  const claude = path.join(home, '.claude');
  const sessions = path.join(claude, 'sessions');
  const enc = path.join(claude, 'projects', '-home-x');
  const state = path.join(home, 'state', 'overmind');
  for (const d of [sessions, enc, state]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(claude, 'overmind-names.json'), '{}');
  fs.writeFileSync(path.join(enc, 'live-sid.jsonl'), '');
  fs.writeFileSync(path.join(enc, 'other-sid.jsonl'), '');
  await sleep(1500); // let the setup's own events drain before anything watches

  let runs = 0;
  const cli = {
    list: async () => {
      runs += 1;
      fs.writeFileSync(path.join(state, 'snapshot.json.lock'), '');
      fs.writeFileSync(path.join(state, `snapshot.json.${runs}.tmp`), '{}');
      fs.renameSync(path.join(state, `snapshot.json.${runs}.tmp`), path.join(state, 'snapshot.json'));
      fs.writeFileSync(path.join(claude, 'overmind-names.json'), '{}');
      return [{ session_id: 'live-sid', harness: 'claude', pid: 1, status: 'busy' }];
    },
  };
  let api = null;
  const watcher = createDiscoveryWatcher({ roots: discoveryRoots({ env, home }), live: () => overmind.peek()?.sessions ?? null, onChange: (cls) => api(cls) });
  const overmind = createOvermind({ cli, self: 'test', watcher });
  const watched = () => overmind.status().mode === 'watch';
  const snapshot = createSnapshot({ build: ({ force = false } = {}) => overmind.localHost({ force: force || !watched() }), refreshMs: 3000 });
  api = (cls) => snapshot.poke(overmind.signal(cls));
  t.after(() => {
    snapshot.stop();
    overmind.stop();
  });

  await snapshot.get();
  assert.equal(runs, 1);
  assert.equal(overmind.status().mode, 'watch');
  const ask = setInterval(() => snapshot.get(), 1000); // the UI polling
  t.after(() => clearInterval(ask));

  async function within(ms, fn) {
    const before = runs;
    await fn?.();
    await sleep(ms);
    return runs - before;
  }

  await t.test('silence (and the list’s own writes) → no run', async () => {
    assert.equal(await within(4000), 0);
  });

  await t.test('a registry write → one run', async () => {
    const n = await within(3000, () => fs.writeFileSync(path.join(sessions, '1.json'), JSON.stringify({ pid: 1, kind: 'interactive', entrypoint: 'cli', status: 'busy' })));
    assert.equal(n, 1);
  });

  await t.test('a headless registry write → no run', async () => {
    const n = await within(2500, () => fs.writeFileSync(path.join(sessions, '2.json'), JSON.stringify({ pid: 2, kind: 'interactive', entrypoint: 'sdk-cli' })));
    assert.equal(n, 0);
  });

  await t.test('an unknown session’s transcript → no run', async () => {
    const n = await within(3000, () => fs.appendFileSync(path.join(enc, 'other-sid.jsonl'), '{"x":1}\n'));
    assert.equal(n, 0);
  });

  await t.test('50 appends over 2 s to the live transcript → at most leading + trailing', async () => {
    const n = await within(7000, async () => {
      for (let i = 0; i < 50; i++) {
        fs.appendFileSync(path.join(enc, 'live-sid.jsonl'), `{"i":${i}}\n`);
        await sleep(40);
      }
    });
    assert.ok(n >= 1 && n <= 2, `runs: ${n}`);
  });

  await t.test('the registry dir removed and recreated → a write still lists', async () => {
    await sleep(1000);
    const n = await within(5000, async () => {
      fs.rmSync(sessions, { recursive: true, force: true });
      await sleep(300);
      fs.mkdirSync(sessions);
      await sleep(300);
      fs.writeFileSync(path.join(sessions, '3.json'), JSON.stringify({ pid: 3, kind: 'interactive', entrypoint: 'cli' }));
    });
    assert.ok(n >= 1, `runs: ${n}`);
  });
});
