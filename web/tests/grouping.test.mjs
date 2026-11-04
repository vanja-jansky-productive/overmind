// Smart grouping: the scheduler (lib/grouping.mjs), /api/groups served by the grouping host
// and proxied from peers, the config keys, and `run`'s stdin. The `overmind` CLI is faked.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi, groupEditOp } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createOvermind } from '../lib/overmind.mjs';
import { createOvermindCli } from '../lib/overmind-cli.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createGrouper, liveKeys, memberKeys } from '../lib/grouping.mjs';
import { run } from '../lib/run.mjs';

const HOME = '/home/tester';

function report(groups, lastRun = { mode: 'incremental', ok: true, modelCalls: 1, classified: 2 }) {
  return { version: 1, applied: true, updatedAt: 42, lastRun, groups, ungrouped: [], hosts: {} };
}

const BOARD = { id: 'g-1', label: 'Overmind Board', description: 'Kanban', source: 'llm', members: [{ host: 'laptop', id: 'a1', name: 'board' }] };

function fakeCli({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    groupCached: async () => (calls.push(['cached']), report([BOARD], { mode: 'noop', ok: true, modelCalls: 0, classified: 0 })),
    groupEdit: async (op) => {
      calls.push(['edit', op]);
      if (op.to === 'g-gone') throw Object.assign(new Error('no group g-gone'), { refused: true });
      return report([{ ...BOARD, label: op.label ?? BOARD.label }]);
    },
    groupRun: async ({ overmind, refresh }) => {
      calls.push(['run', overmind, refresh]);
      if (fail) throw new Error('overmind group timed out after 300s');
      return report([BOARD, { id: 'g-2', label: 'Team Reviews', description: null, source: 'llm', members: [{ host: 'workstation', id: 'b1' }] }]);
    },
  };
}

const OVERMIND = {
  self: 'laptop',
  hosts: [
    { name: 'laptop', ok: true, sessions: [{ host: 'laptop', session_id: 'a1' }] },
    { name: 'workstation', ok: true, sessions: [{ host: 'workstation', session_id: 'b1' }] },
    { name: 'down', ok: false, sessions: [{ host: 'down', session_id: 'z' }] },
  ],
};

test('liveKeys / memberKeys', () => {
  assert.deepEqual([...liveKeys(OVERMIND)], ['laptop/a1', 'workstation/b1']);
  assert.deepEqual([...memberKeys(report([BOARD]))], ['laptop/a1']);
});

test('grouper: stored groups first, a run feeds the overmind to the CLI and reports lastRun', async () => {
  const cli = fakeCli();
  let t = 1000;
  const g = createGrouper({ cli, getOvermind: async () => OVERMIND, self: 'laptop', now: () => t, intervalMs: 600000 });
  await g.loadCached();
  let r = g.response();
  assert.equal(r.enabled, true);
  assert.equal(r.host, 'laptop');
  assert.equal(r.intervalMinutes, 10);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].members, [{ host: 'laptop', id: 'a1' }], 'members reduced to host/id');
  assert.equal(r.lastRun.reason, 'stored');

  const a = g.runOnce('manual');
  const b = g.runOnce('manual');
  assert.equal(a, b, 'concurrent runs are de-duplicated');
  t = 1500;
  r = await a;
  assert.equal(cli.calls.filter((c) => c[0] === 'run').length, 1);
  assert.equal(cli.calls.at(-1)[1], OVERMIND);
  assert.equal(r.groups.length, 2);
  assert.equal(r.running, false);
  assert.equal(r.updatedAt, 42);
  assert.deepEqual(
    { ...r.lastRun },
    { at: 1000, ms: 500, ok: true, reason: 'manual', mode: 'incremental', modelCalls: 1, classified: 2 },
  );
});

test('grouper: a failing run keeps the last groups and reports the error', async () => {
  const g = createGrouper({ cli: fakeCli({ fail: true }), getOvermind: async () => OVERMIND });
  await g.loadCached();
  const r = await g.runOnce('scheduled');
  assert.equal(r.lastRun.ok, false);
  assert.match(r.lastRun.error, /timed out/);
  assert.equal(r.groups.length, 1, 'stored groups survive');
});

test('grouper: the change check runs early only for unknown live sessions, never discovers', async () => {
  const cli = fakeCli();
  let t = 0;
  let peek = null;
  let built = 0;
  const g = createGrouper({
    cli,
    getOvermind: async () => (built++, OVERMIND),
    peekOvermind: () => peek,
    now: () => t,
    minGapMs: 1000,
  });
  await g.loadCached();
  assert.equal(await g.checkChanges(), false, 'no snapshot → nothing');
  peek = { hosts: [{ name: 'laptop', ok: true, sessions: [{ host: 'laptop', session_id: 'a1' }] }] };
  assert.equal(await g.checkChanges(), false, 'every live session is known');
  assert.equal(built, 0);
  peek = OVERMIND; // workstation/b1 is new
  assert.equal(await g.checkChanges(), true);
  assert.equal(cli.calls.at(-1)[0], 'run');
  assert.equal(g.lastRun.reason, 'changes');
  peek = { hosts: [{ name: 'laptop', ok: true, sessions: [{ host: 'laptop', session_id: 'new' }] }] };
  t = 500;
  assert.equal(await g.checkChanges(), false, 'within the minimum gap');
  t = 5000;
  assert.equal(await g.checkChanges(), true);
});

test('overmind-cli groupRun pipes the overmind on stdin and parses the report', async () => {
  const seen = [];
  const cli = createOvermindCli({
    run: async (bin, args, opts) => (seen.push({ args, opts }), { stdout: JSON.stringify(report([BOARD])), stderr: '' }),
  });
  const r = await cli.groupRun({ overmind: OVERMIND, refresh: true });
  assert.equal(r.groups[0].id, 'g-1');
  assert.deepEqual(seen[0].args, ['group', '--input', '-', '--apply', '--json', '--refresh']);
  assert.deepEqual(JSON.parse(seen[0].opts.input), OVERMIND);
  const bad = createOvermindCli({ run: async () => ({ stdout: 'nope', stderr: '' }) });
  await assert.rejects(bad.groupRun({ overmind: OVERMIND }), /non-JSON/);
  const cached = createOvermindCli({ run: async (b, args) => (seen.push({ args }), { stdout: '{"groups":[]}', stderr: '' }) });
  await cached.groupCached();
  assert.deepEqual(seen.at(-1).args, ['group', '--cached', '--json']);
});

test('run() writes opts.input to the child stdin', async () => {
  const { stdout } = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello' });
  assert.equal(stdout, 'hello');
});

test('config: web.grouping is opt-in, grouping.host makes one host authoritative', () => {
  const n = (raw, env = {}) => normalizeConfig(raw, { env, home: HOME }).grouping;
  assert.deepEqual(n({}), { enabled: false, intervalMinutes: 10, host: null });
  assert.deepEqual(n({ self: 'laptop', web: { grouping: { enabled: true, intervalMinutes: 3 } } }), {
    enabled: true,
    intervalMinutes: 3,
    host: null,
  });
  assert.equal(n({ self: 'laptop', web: { grouping: { enabled: true } }, grouping: { host: 'laptop' } }).enabled, true);
  // Enabled here but another host is the grouping host: this one stays off.
  assert.equal(n({ self: 'laptop', web: { grouping: { enabled: true } }, grouping: { host: 'workstation' } }).enabled, false);
  assert.equal(n({ self: 'laptop' }, { OVERMIND_WEB_GROUPING: '1' }).enabled, true);
  assert.throws(() => n({ web: { grouping: { enabled: 'yes' } } }), /grouping.enabled/);
  assert.throws(() => n({ web: { grouping: { intervalMinutes: 0 } } }), /intervalMinutes/);
  assert.throws(() => n({ grouping: { host: '' } }), /grouping.host/);
});

// --- over HTTP: laptop runs grouping, workstation proxies to it -------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function startPair(t, { workstationGrouping = {} } = {}) {
  const hosts = {
    laptop: [{ session_id: 'a1', name: 'board', status: 'idle', backend: 'tmux' }],
    workstation: [{ session_id: 'b1', name: 'review', status: 'idle', backend: 'tmux' }],
  };
  const servers = {};
  const urls = {};
  const handles = {};
  for (const name of Object.keys(hosts)) {
    servers[name] = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(servers[name]);
    t.after(() => servers[name].close());
  }
  const groupCli = fakeCli();
  for (const name of Object.keys(hosts)) {
    const raw = {
      self: name,
      hosts: { laptop: { web: urls.laptop }, workstation: { web: urls.workstation } },
      web: name === 'laptop' ? { grouping: { enabled: true } } : {},
      ...(name === 'workstation' ? { grouping: workstationGrouping } : {}),
    };
    const config = normalizeConfig(raw, { env: {}, home: HOME });
    const cli = createOvermindCli({ run: async () => ({ stdout: JSON.stringify(hosts[name]), stderr: '' }) });
    const overmind = createOvermind({ cli, self: name });
    let api = null;
    const grouper = config.grouping.enabled
      ? createGrouper({ cli: groupCli, getOvermind: () => api.buildOvermind(), peekOvermind: () => api.peekOvermind(), self: name })
      : null;
    api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, grouper, warmOvermind: false });
    t.after(() => api.stop());
    handles[name] = api;
  }
  return { urls, groupCli };
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('/api/groups: served by the grouping host, proxied by grouping.host, runs over the merged overmind', async (t) => {
  const { urls, groupCli } = await startPair(t, { workstationGrouping: { host: 'laptop' } });
  const empty = await get(`${urls.laptop}/api/groups`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.enabled, true);
  assert.deepEqual(empty.body.groups, []);

  const ran = await post(`${urls.workstation}/api/groups/run`, {});
  assert.equal(ran.status, 200);
  assert.equal(ran.body.host, 'laptop');
  assert.equal(ran.body.lastRun.reason, 'manual');
  const fed = groupCli.calls.at(-1)[1];
  assert.deepEqual(
    fed.hosts.map((h) => [h.name, h.sessions.map((s) => s.session_id)]),
    [
      ['laptop', ['a1']],
      ['workstation', ['b1']],
    ],
    'the CLI gets every host, fetched over HTTP',
  );

  const viaPeer = await get(`${urls.workstation}/api/groups`);
  assert.equal(viaPeer.status, 200);
  assert.equal(viaPeer.body.host, 'laptop');
  assert.deepEqual(viaPeer.body.groups.map((g) => g.label), ['Overmind Board', 'Team Reviews']);

  const h = await get(`${urls.laptop}/api/health`);
  assert.equal(h.body.grouping.enabled, true);
  assert.equal(h.body.grouping.lastRun.reason, 'manual');
  assert.equal((await get(`${urls.laptop}/api/groups/run`)).status, 405);
  assert.equal((await post(`${urls.laptop}/api/groups`, {})).status, 405);
});

test('/api/groups: without grouping.host a peer finds the grouping host itself', async (t) => {
  const { urls } = await startPair(t);
  const r = await get(`${urls.workstation}/api/groups`);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.host, 'laptop');
});

test('/api/groups: nobody runs grouping → disabled response and 501 on run', async () => {
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: HOME });
  const cli = createOvermindCli({ run: async () => ({ stdout: '[]', stderr: '' }) });
  const api = createApi({ config, overmind: createOvermind({ cli, self: 'solo' }), backend: {}, transcripts: {}, spawner: {}, warmOvermind: false });
  const r = await api({ method: 'GET', headers: {} }, new URL('http://x/api/groups'));
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.deepEqual(r.body.groups, []);
  const req = Object.assign(new (await import('node:stream')).PassThrough(), { method: 'POST', headers: {} });
  req.end('{}');
  await assert.rejects(api(req, new URL('http://x/api/groups/run')), (err) => err.status === 501);
});

test('grouper: an edit waits for a running pass and a pass waits for an edit', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const cli = {
    groupCached: async () => report([BOARD]),
    groupRun: async () => (order.push('run:start'), await gate, order.push('run:end'), report([BOARD])),
    groupEdit: async (op) => (order.push(`edit:${op.label}`), report([{ ...BOARD, label: op.label }])),
  };
  const g = createGrouper({ cli, getOvermind: async () => OVERMIND });
  const run = g.runOnce('manual');
  await new Promise((r) => setImmediate(r));
  const edit = g.edit({ op: 'rename', id: 'g-1', label: 'Renamed' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['run:start'], 'the edit waits');
  release();
  await run;
  const r = await edit;
  assert.deepEqual(order, ['run:start', 'run:end', 'edit:Renamed']);
  assert.equal(r.groups[0].label, 'Renamed');
});

test('overmind-cli groupEdit: flags as --k=v, the CLI error surfaces as refused', async () => {
  const seen = [];
  const cli = createOvermindCli({ run: async (b, args) => (seen.push(args), { stdout: JSON.stringify(report([BOARD])), stderr: '' }) });
  await cli.groupEdit({ op: 'rename', id: 'g-1', label: '-dash' });
  await cli.groupEdit({ op: 'move', host: 'laptop', session: 'a1', to: 'g-2' });
  await cli.groupEdit({ op: 'move', host: 'laptop', session: 'a1', label: 'New One' });
  await cli.groupEdit({ op: 'create', label: 'Spikes' });
  await cli.groupEdit({ op: 'delete', id: 'g-3' });
  assert.deepEqual(seen, [
    ['group', '--rename=g-1', '--label=-dash', '--json'],
    ['group', '--move=laptop/a1', '--to=g-2', '--json'],
    ['group', '--move=laptop/a1', '--label=New One', '--json'],
    ['group', '--create', '--label=Spikes', '--json'],
    ['group', '--delete=g-3', '--json'],
  ]);
  const failing = createOvermindCli({
    run: async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'Error: no group g-9\n' });
    },
  });
  await assert.rejects(failing.groupEdit({ op: 'move', host: 'laptop', session: 'a1', to: 'g-9' }), (e) => e.refused && e.message === 'no group g-9');
});

test('groupEditOp validates the body', () => {
  assert.deepEqual(groupEditOp({ op: 'rename', id: 'g-1', label: '  X  ' }), { op: 'rename', id: 'g-1', label: 'X' });
  assert.deepEqual(groupEditOp({ op: 'move', host: 'laptop', session: 'a1', to: 'repo-app' }), { op: 'move', host: 'laptop', session: 'a1', to: 'repo-app' });
  assert.deepEqual(groupEditOp({ op: 'move', host: 'laptop', session: '123', label: 'New' }), { op: 'move', host: 'laptop', session: '123', label: 'New' });
  assert.deepEqual(groupEditOp({ op: 'create', label: ' Spikes ', id: 'ignored' }), { op: 'create', label: 'Spikes' });
  assert.deepEqual(groupEditOp({ op: 'delete', id: 'g-3' }), { op: 'delete', id: 'g-3' });
  for (const bad of [
    null,
    { op: 'nuke' },
    { op: 'rename', id: 'g-1', label: '   ' },
    { op: 'rename', id: 'g 1', label: 'X' },
    { op: 'move', host: 'a/b', session: 'a1', to: 'g-1' },
    { op: 'move', host: 'laptop', session: '../x', to: 'g-1' },
    { op: 'move', host: 'laptop', session: 'a1' },
    { op: 'create' },
    { op: 'delete', id: '' },
  ]) {
    assert.throws(() => groupEditOp(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test('/api/groups/edit: applied on the grouping host, proxied from a peer, refusals are 409', async (t) => {
  const { urls, groupCli } = await startPair(t, { workstationGrouping: { host: 'laptop' } });
  const r = await post(`${urls.workstation}/api/groups/edit`, { op: 'rename', id: 'g-1', label: 'Board UI' });
  assert.equal(r.status, 200);
  assert.equal(r.body.groups[0].label, 'Board UI');
  assert.deepEqual(groupCli.calls.at(-1), ['edit', { op: 'rename', id: 'g-1', label: 'Board UI' }]);
  const refused = await post(`${urls.laptop}/api/groups/edit`, { op: 'move', host: 'laptop', session: 'a1', to: 'g-gone' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no group g-gone/);
  assert.equal((await post(`${urls.laptop}/api/groups/edit`, { op: 'rename', id: 'g-1' })).status, 400);
  assert.equal((await get(`${urls.laptop}/api/groups/edit`)).status, 405);
});

test('grouper: a member\'s `dormant: true` passes through to /api/groups (only when true)', async () => {
  const members = [{ host: 'laptop', id: 'a1', dormant: true }, { host: 'laptop', id: 'a2', dormant: false }, { host: 'laptop', id: 'a3' }];
  const cli = { ...fakeCli(), groupCached: async () => report([{ ...BOARD, members }]) };
  const g = createGrouper({ cli, getOvermind: async () => OVERMIND, self: 'laptop', intervalMs: 600000 });
  await g.loadCached();
  assert.deepEqual(g.response().groups[0].members, [{ host: 'laptop', id: 'a1', dormant: true }, { host: 'laptop', id: 'a2' }, { host: 'laptop', id: 'a3' }]);
});
