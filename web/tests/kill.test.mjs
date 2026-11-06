import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKiller } from '../lib/kill.mjs';

function fakeProcess(alive = true, diesAfterTerm = true) {
  const sent = [];
  const killProcess = (pid, sig) => {
    sent.push(sig);
    if (!alive) {
      const e = new Error('no such process');
      e.code = 'ESRCH';
      throw e;
    }
    if (sig === 'SIGTERM' && diesAfterTerm) alive = false;
    if (sig === 'SIGKILL') alive = false;
  };
  return { sent, killProcess };
}

const noRun = async () => ({ stdout: '', stderr: '' });

function tmuxRun(shape, { failKill = null } = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args);
    if (args[0] === 'display-message') return { stdout: shape, stderr: '' };
    if (failKill && args[0].startsWith('kill-')) throw new Error(failKill);
    return { stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('kill: resolves the pane first, SIGTERMs, then kill-session by id when it was the only window', async () => {
  const { sent, killProcess } = fakeProcess();
  const { calls, run } = tmuxRun('$3 @7 1\n');
  const k = createKiller({ run, killProcess, sleep: async () => {} });
  const res = await k.kill({ pid: 4242, backend: 'tmux', handle: '%7', tmux_session: 'job' });
  assert.deepEqual(res, { process: 'terminated', terminal: 'tmux-session-killed' });
  assert.deepEqual(sent, [0, 'SIGTERM', 0]);
  assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%7', '#{session_id} #{window_id} #{session_windows}']);
  assert.deepEqual(calls.at(-1), ['kill-session', '-t', '$3']);
});

test('kill: only the window goes when the tmux session has other windows', async () => {
  const { killProcess } = fakeProcess();
  const { calls, run } = tmuxRun('$3 @7 2');
  const k = createKiller({ run, killProcess, sleep: async () => {} });
  const res = await k.kill({ pid: 4242, backend: 'tmux', handle: '%7', tmux_session: 'plain' });
  assert.equal(res.terminal, 'tmux-window-killed');
  assert.deepEqual(calls.at(-1), ['kill-window', '-t', '@7']);
});

test('kill: a tmux target that closed itself with Claude is fine, other tmux errors are not', async () => {
  const { killProcess } = fakeProcess();
  const gone = tmuxRun('$3 @7 1', { failKill: "can't find session: $3" });
  const res = await createKiller({ run: gone.run, killProcess, sleep: async () => {} }).kill({ pid: 4242, backend: 'tmux', handle: '%7' });
  assert.equal(res.terminal, 'tmux-session-killed');
  const broken = tmuxRun('$3 @7 1', { failKill: 'permission denied' });
  await assert.rejects(
    createKiller({ run: broken.run, killProcess: fakeProcess().killProcess, sleep: async () => {} }).kill({ pid: 4242, backend: 'tmux', handle: '%7' }),
    /permission denied/,
  );
});

test('kill: a pane that is already gone touches no tmux target', async () => {
  const { killProcess } = fakeProcess(false);
  const { calls, run } = tmuxRun(''); // tmux prints nothing for a vanished pane
  const res = await createKiller({ run, killProcess, sleep: async () => {} }).kill({ pid: 4242, backend: 'tmux', handle: '%7', tmux_session: 'job' });
  assert.deepEqual(res, { process: 'gone', terminal: 'tmux-pane-gone' });
  assert.ok(calls.every((a) => !a[0].startsWith('kill-')));
});

test('kill: escalates to SIGKILL after the grace period', async () => {
  const { sent, killProcess } = fakeProcess(true, false);
  const k = createKiller({ run: noRun, killProcess, sleep: async () => {}, graceMs: 0 });
  const res = await k.kill({ pid: 4242, backend: 'unknown', handle: null, tmux_session: null });
  assert.equal(res.process, 'killed');
  assert.ok(sent.includes('SIGKILL'));
  assert.equal(res.terminal, 'left');
});

test('kill: bad pids are skipped, never signalled', async () => {
  const { sent, killProcess } = fakeProcess();
  const k = createKiller({ run: noRun, killProcess, sleep: async () => {} });
  assert.equal(await k.terminate(1), 'skipped');
  assert.equal(await k.terminate(Number('x')), 'skipped');
  assert.deepEqual(sent, []);
});

test('kill: iterm closes the tab, tolerates refusal, dead pid is reported gone', async () => {
  const { killProcess } = fakeProcess(false);
  let closed = 0;
  const k = createKiller({ run: noRun, killProcess, sleep: async () => {}, closeIterm: async () => { closed += 1; } });
  const res = await k.kill({ pid: 4242, backend: 'iterm', handle: 'ABC', tmux_session: null });
  assert.deepEqual(res, { process: 'gone', terminal: 'iterm-tab-closed' });
  assert.equal(closed, 1);
  const k2 = createKiller({ run: noRun, killProcess, sleep: async () => {}, closeIterm: async () => { throw new Error('nope'); } });
  assert.equal((await k2.kill({ pid: 4242, backend: 'iterm', handle: 'ABC' })).terminal, 'iterm-tab-left');
});

test('kill: a busy or waiting Codex row is interrupted with Escape first, then SIGTERMed', async () => {
  for (const status of ['busy', 'waiting']) {
    const order = [];
    const { killProcess } = fakeProcess();
    let listed = 0;
    const k = createKiller({
      run: tmuxRun('$3 @7 1\n').run,
      killProcess: (pid, sig) => (sig === 'SIGTERM' && order.push('SIGTERM'), killProcess(pid, sig)),
      sleep: async () => {},
      keys: async (s, key) => void order.push(key),
      // Still busy on the first look, idle (turn_aborted) on the second.
      listSessions: async () => [{ pid: 4242, status: (listed += 1) < 2 ? status : 'idle' }],
    });
    const res = await k.kill({ pid: 4242, harness: 'codex', status, backend: 'tmux', handle: '%7' });
    assert.deepEqual(order, ['Escape', 'SIGTERM'], status);
    assert.equal(res.interrupt, 'interrupted');
    assert.equal(listed, 2);
  }
});

test('kill: the interrupt wait is bounded by the wall clock, slow lists included', async () => {
  let clock = 0;
  let listed = 0;
  const { sent, killProcess } = fakeProcess();
  const k = createKiller({
    run: noRun,
    killProcess,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    keys: async () => {},
    // Each list takes 2 s (osascript peeks): 5 s fit two of them, not twenty.
    listSessions: async () => ((listed += 1), (clock += 2000), [{ pid: 4242, status: 'busy' }]),
  });
  const res = await k.kill({ pid: 4242, harness: 'codex', status: 'busy', backend: 'tmux', handle: '%7' });
  assert.equal(res.interrupt, 'timeout');
  assert.equal(listed, 3);
  assert.ok(clock < 5000 + 2250 + 1, `${clock}`);
  assert.ok(sent.includes('SIGTERM'));
});

test('kill: an interrupt that never lands still SIGTERMs; idle Codex and Claude rows get no Escape', async () => {
  const keys = [];
  const { sent, killProcess } = fakeProcess();
  let clock = 0;
  const k = createKiller({
    run: noRun,
    killProcess,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    interruptMs: 1000,
    keys: async (s, key) => void keys.push(key),
    listSessions: async () => [{ pid: 4242, status: 'busy' }],
  });
  const res = await k.kill({ pid: 4242, harness: 'codex', status: 'busy', backend: 'tmux', handle: '%7' });
  assert.equal(res.interrupt, 'timeout');
  assert.ok(sent.includes('SIGTERM'));
  keys.length = 0;
  for (const row of [
    { pid: 4243, harness: 'codex', status: 'idle', backend: 'tmux', handle: '%8' },
    { pid: 4244, harness: 'claude', status: 'busy', backend: 'tmux', handle: '%9' },
  ]) {
    const r = await k.kill(row);
    assert.equal(r.interrupt, undefined);
  }
  assert.deepEqual(keys, []);
});

// #34 phase 5: a Codex turn's tool process (lib/codex-tools.mjs finds it) dies with its row.
/** Records every signal; the agent (any pid ≥ 4000) dies on SIGTERM like fakeProcess. */
function recorder(order) {
  const agent = fakeProcess();
  return (pid, sig) => {
    if (sig !== 0) order.push(`${sig} ${pid}`);
    if (Math.abs(pid) >= 4000) agent.killProcess(pid, sig);
  };
}

function toolsFake({ survivors = null } = {}) {
  const rows = [
    { pid: 600, ppid: 510, pgid: 600, startMs: 1, args: '/bin/zsh -c sleep 61' },
    { pid: 601, ppid: 600, pgid: 600, startMs: 1, args: 'sleep 61' },
  ];
  const seen = [];
  return {
    seen,
    find: async (s) => (seen.push(['find', s.pid]), { leaders: [600], pids: [600, 601], groups: [600], rows }),
    // The first check (right before the TERM) finds them all; later ones only the `survivors`.
    alive: async (found) => (seen.push(['alive']), found.rows.filter((r) => seen.filter((x) => x[0] === 'alive').length === 1 || survivors?.includes(r.pid))),
  };
}

test('kill: a busy Codex row — Escape, its turn\'s tool processes TERMed, the agent SIGTERMed, survivors KILLed after the grace', async () => {
  const order = [];
  const tools = toolsFake();
  const k = createKiller({
    run: tmuxRun('$3 @7 1\n').run,
    killProcess: recorder(order),
    sleep: async () => {},
    keys: async (s, key) => void order.push(key),
    listSessions: async () => [{ pid: 4242, status: 'idle' }],
    tools,
    graceMs: 50,
  });
  const res = await k.kill({ pid: 4242, harness: 'codex', status: 'busy', backend: 'tmux', handle: '%7', transcript: '/r', cwd: '/w' });
  assert.deepEqual(order.slice(0, 5), ['Escape', 'SIGTERM -600', 'SIGTERM 600', 'SIGTERM 601', 'SIGTERM 4242'], 'the group, each pid, then the agent');
  assert.deepEqual(tools.seen.slice(0, 2), [['find', 4242], ['alive']], 'checked to be the same processes right before the first TERM');
  assert.deepEqual(res.tools, { pids: [600, 601], result: 'terminated' });
  assert.ok(!order.some((o) => o.startsWith('SIGKILL')), 'all gone: nothing more');

  // One survives the grace: KILLed — only after it is checked to be the same process still.
  const order2 = [];
  const stubborn = toolsFake({ survivors: [601] });
  let clock = 0;
  const k2 = createKiller({
    run: noRun,
    killProcess: recorder(order2),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    keys: async () => {},
    listSessions: async () => [{ pid: 4242, status: 'idle' }],
    tools: stubborn,
    graceMs: 1000,
  });
  const res2 = await k2.kill({ pid: 4242, harness: 'codex', status: 'waiting', backend: 'tmux', handle: '%7' });
  assert.deepEqual(res2.tools, { pids: [600, 601], result: 'killed' });
  assert.deepEqual(order2.filter((o) => o.startsWith('SIGKILL')), ['SIGKILL 601'], 'only the verified survivor; never its old group');
  assert.ok(stubborn.seen.filter((s) => s[0] === 'alive').length >= 2, 'checked while waiting and again right before the KILL');
});

test("kill: the TERM goes only to what is still the same process (pid, args, start) after the lookup; a gone leader's group is never signalled", async () => {
  const order = [];
  const tools = toolsFake();
  // Between the lookup and the TERM, 600 ended (its pid may be reused); 601 still ran, and ends on the TERM.
  let checks = 0;
  tools.alive = async (found) => (checks += 1) === 1 ? found.rows.filter((r) => r.pid === 601) : [];
  const k = createKiller({ run: noRun, killProcess: recorder(order), sleep: async () => {}, keys: async () => {}, listSessions: async () => [], tools, graceMs: 50 });
  await k.kill({ pid: 4247, harness: 'codex', status: 'busy', backend: 'tmux', handle: '%8' });
  assert.deepEqual(order.filter((o) => !o.endsWith(' 4247')), ['SIGTERM 601']);
  // Nothing left by then: no TERM at all, no `tools` in the answer.
  const order2 = [];
  const gone = toolsFake();
  gone.alive = async () => [];
  const k2 = createKiller({ run: noRun, killProcess: recorder(order2), sleep: async () => {}, keys: async () => {}, listSessions: async () => [], tools: gone, graceMs: 50 });
  const res = await k2.kill({ pid: 4248, harness: 'codex', status: 'busy', backend: 'tmux', handle: '%8' });
  assert.deepEqual(order2, ['SIGTERM 4248']);
  assert.equal(res.tools, undefined);
});

test("kill: an idle Codex row's earlier commands are left running (a dev server the user asked for); Claude rows look for none", async () => {
  const order = [];
  const tools = toolsFake();
  const k = createKiller({ run: noRun, killProcess: recorder(order), sleep: async () => {}, keys: async () => order.push('Escape'), listSessions: async () => [], tools });
  const idle = await k.kill({ pid: 4243, harness: 'codex', status: 'idle', backend: 'tmux', handle: '%8' });
  assert.equal(idle.tools, undefined);
  assert.equal(idle.interrupt, undefined, 'no Escape for an idle row');
  assert.deepEqual(order, ['SIGTERM 4243']);
  assert.deepEqual(tools.seen, [], 'not even looked up');
  assert.equal((await k.kill({ pid: 4244, harness: 'claude', status: 'busy', backend: 'tmux', handle: '%9' })).tools, undefined);
  assert.deepEqual(tools.seen, []);
  const none = { find: async () => ({ leaders: [], pids: [], groups: [], rows: [] }), alive: async () => [] };
  const k2 = createKiller({ run: noRun, killProcess: recorder([]), sleep: async () => {}, keys: async () => {}, listSessions: async () => [], tools: none });
  assert.equal((await k2.kill({ pid: 4245, harness: 'codex', status: 'busy', backend: 'tmux', handle: '%8' })).tools, undefined);
  // A failing lookup never fails the close.
  const broken = { find: async () => { throw new Error('ps: boom'); }, alive: async () => [] };
  const k3 = createKiller({ run: noRun, killProcess: recorder([]), sleep: async () => {}, keys: async () => {}, listSessions: async () => [], tools: broken });
  assert.equal((await k3.kill({ pid: 4246, harness: 'codex', status: 'busy', backend: 'tmux', handle: '%8' })).process, 'terminated');
});
