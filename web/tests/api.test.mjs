// End-to-end over real HTTP on ephemeral ports: two API servers (laptop + workstation)
// peering with each other, all child processes faked. No network beyond 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createOvermind } from '../lib/overmind.mjs';
import { createOvermindCli } from '../lib/overmind-cli.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createTranscriptReader, sliceDelta, snapshotEntry, transcriptPath } from '../lib/transcript.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

/** A transcripts fake over a list (or a function of the call): `messages` as before, `delta` through the real slicing. */
function fakeTranscripts(list) {
  const now = () => (typeof list === 'function' ? list() : list).slice();
  return {
    messages: async () => {
      const all = now();
      return { messages: all, total: all.length, truncated: false, updatedAt: 1 };
    },
    delta: async (s, o) => ({ ...sliceDelta(snapshotEntry(now(), { gen: 'f0f0f0f0' }), o), updatedAt: 1 }),
  };
}

function fakeHost(self, sessions) {
  const calls = [];
  const cli = createOvermindCli({ run: async () => ({ stdout: JSON.stringify(sessions), stderr: '' }) });
  const backend = {
    peek: async (s, lines) => (calls.push(['peek', s.session_id, lines]), `screen of ${s.name}`),
    send: async (s, text) => void calls.push(['send', s.session_id, text]),
    keys: async (s, key) => void calls.push(['keys', s.session_id, key]),
    screen: async (s) => (calls.push(['screen', s.session_id]), { cols: 80, rows: 2, cursor: { x: 0, y: 1, visible: true }, altScreen: true, appCursor: false, mouse: { tracking: 'all', sgr: true, utf8: false }, lines: [`screen of ${s.name}`, ''] }),
    input: async (s, data) => void calls.push(['input', s.session_id, data]),
  };
  const transcripts = fakeTranscripts([{ role: 'user', text: 'hi' }]);
  const spawner = { spawn: async (req) => (calls.push(['spawn', req]), { name: req.name, dir: req.dir, tmuxSession: req.name, command: 'claude', trusted: false }) };
  const killer = { kill: async (s) => (calls.push(['kill', s.session_id]), { process: 'terminated', terminal: 'tmux-session-killed' }) };
  const autoNamer = {
    lastRun: null,
    runOnce: async (reason) => {
      calls.push(['autoname', reason]);
      autoNamer.lastRun = { at: 1, ms: 1, reason, ok: true, renamed: [{ from: 'app-9d', to: 'fix-login' }], tmux: [], held: [], errors: [] };
      return autoNamer.lastRun;
    },
  };
  cli.sleep = async ({ target }) => (
    calls.push(['sleep', target]),
    { sessionId: target, title: 'one', process: 'terminated', terminal: 'tmux-session-killed', dormant: { kind: 'tmux', target: 'one', slept: true }, dryRun: false }
  );
  cli.rename = async ({ target, title }) => {
    calls.push(['rename', target, title]);
    if (title === 'while waiting') return { ok: false, result: 'held', held: 'waiting', title, message: `${target} is waiting on you — nothing sent (--force overrides)` };
    if (title === 'explode') throw new Error('tmux: boom');
    return { ok: true, result: 'renamed', title, from: 'app-9d', held: null, tmux: { renamed: true, from: 'om-101010', to: 'fix-login', note: '⧉ om-101010 → fix-login' }, message: `app-9d → ${title}` };
  };
  cli.nameOne = async ({ target, refresh }) => {
    calls.push(['nameOne', target, refresh]);
    if (self === 'workstation') return { stdout: '⏸ two  waiting on you — nothing sent\n', stderr: '' };
    return { stdout: 'one  →  fix-login   (model)\n⧉ om-1 → fix-login\n', stderr: '' };
  };
  cli.harnesses = async () => {
    calls.push(['harnesses']);
    return [
      { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [{ id: 'x', label: 'X' }] },
      { id: 'codex', label: 'Codex', command: 'codex', installed: self === 'workstation', models: [{ id: '', label: 'Default' }] },
    ];
  };
  cli.usage = async ({ refresh }) => {
    calls.push(['usage', refresh]);
    if (self === 'broken') throw new Error('no Claude Code login found');
    return { account: { email: `me@${self}` }, limits: [{ kind: 'session', percent: 25 }], stale: false };
  };
  cli.prs = async ({ refresh }) => {
    calls.push(['prs', refresh]);
    if (self === 'broken') throw new Error('gh not found: install the GitHub CLI and run `gh auth login`');
    return { user: `me-${self}`, stale: false, error: null, columns: [{ id: 'waitingOnMe', title: 'Waiting on me', count: 1 }], prs: [{ column: 'waitingOnMe', repo: 'app', number: 1, local: { repoPath: '/home/tester/app', worktree: '/home/tester/wt/app feat' } }, { column: 'draftMine', repo: 'app', number: 2 }] };
  };
  cli.prCheckout = async (ref) => {
    calls.push(['prCheckout', ref]);
    if (ref === 'acme/gone#9') throw new Error('no checkout of acme/gone under the repos roots (~/Code) — clone it there first');
    const [, owner, repo, number] = /^(.+)\/(.+)#(\d+)$/.exec(ref);
    const p = `/home/tester/wt/${repo}-feat`;
    return { owner, repo, number: Number(number), branch: 'feat', path: p, created: true, contextLine: `You're working on pull request ${ref} in ${p}.` };
  };
  cli.prSeen = async (ref) => {
    calls.push(['prSeen', ref]);
    return { pr: ref, seenAt: 1000, applied: true };
  };
  cli.tasks = async ({ refresh }) => {
    calls.push(['tasks', refresh]);
    if (self === 'broken') throw new Error('no Productive API token: set tasks.token in config or $PRODUCTIVE_API_TOKEN');
    return { user: { id: '7', name: `Ada@${self}` }, columns: [{ id: 'inProgress', title: 'In progress', count: 1 }], tasks: [{ id: '1001', column: 'inProgress', title: 'Fix it' }], statuses: {} };
  };
  cli.taskShow = async (id) => {
    calls.push(['taskShow', id]);
    if (id === '404') throw new Error('no task 404 among your open tasks');
    return { id, title: 'Fix it', contextLine: `Productive task #12 “Fix it”: https://app.productive.io/1-acme/tasks/${id}.` };
  };
  cli.schedule = async () => (calls.push(['schedule']), { host: 'ignored', entries: [] });
  cli.scheduleAdd = async (o) => (calls.push(['scheduleAdd', o]), { id: 'sabc', state: 'pending', ...o });
  cli.scheduleCancel = async (id) => (calls.push(['scheduleCancel', id]), `cancelled ${id}`);
  cli.taskStatus = async (id, status) => {
    calls.push(['taskStatus', id, status]);
    return { task: { id, status: { id: '5', name: status, category: 'started' } } };
  };
  let focusOn = false;
  const focusStatus = () => ({ active: focusOn, remainingMs: focusOn ? 60000 : 0, endsAt: null, apps: [], stale: false });
  const focus = {
    status: async () => focusStatus(),
    start: async (minutes) => (calls.push(['focusStart', minutes]), (focusOn = true), focusStatus()),
    stop: async () => (calls.push(['focusStop']), (focusOn = false), focusStatus()),
  };
  return { calls, cli, backend, transcripts, spawner, killer, autoNamer, focus, overmind: createOvermind({ cli, self }) };
}

async function startPair(t) {
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-web-ui-'));
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<p>custom ui</p>');
  t.after(() => fs.rmSync(uiDir, { recursive: true, force: true }));

  const lap = fakeHost('laptop', [{ session_id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'one', status: 'idle', backend: 'tmux', handle: '%1', updated_at: 1 }]);
  const remote = fakeHost('workstation', [{ session_id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'two', status: 'waiting', backend: 'tmux', handle: '%2', updated_at: 2 }]);

  // Bind first so each side knows the other's URL.
  const servers = {};
  const urls = {};
  const cfgs = {};
  for (const [name, host] of [['laptop', lap], ['workstation', remote]]) {
    let handle = null;
    servers[name] = createHttpServer({ handleApi: (req, url) => handle(req, url), uiDir });
    urls[name] = await listen(servers[name]);
    host.setHandle = (h) => (handle = h);
    t.after(() => servers[name].close());
  }
  for (const [name, host] of [['laptop', lap], ['workstation', remote]]) {
    cfgs[name] = normalizeConfig(
      {
        self: name,
        hosts: { laptop: { web: urls.laptop }, workstation: { web: urls.workstation } },
        spawnDirs: [{ label: 'Tmp', paths: { [name]: os.tmpdir() } }],
        web: { autoName: { enabled: true } },
      },
      { env: {}, home: '/home/tester' },
    );
    const api = createApi({ config: cfgs[name], ...host, version: '9.9.9' });
    t.after(() => api.stop());
    host.setHandle(api);
  }
  return { lap, remote, urls };
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('health and settings', async (t) => {
  const { urls } = await startPair(t);
  const h = await get(`${urls.laptop}/api/health`);
  assert.equal(h.status, 200);
  assert.equal(h.body.self, 'laptop');
  assert.equal(h.body.version, '9.9.9');
  assert.equal(h.body.apiVersion, 1);
  const s = await get(`${urls.laptop}/api/settings`);
  assert.deepEqual(s.body.hosts, ['laptop', 'workstation']);
  assert.ok(s.body.quickReplies.length > 0);
  assert.deepEqual(s.body.models[0], { id: '', label: 'Default' });
  assert.ok(s.body.models.some((m) => m.id === 'sonnet'));
});

test('settings exposes web.models when configured', async () => {
  const host = fakeHost('solo', []);
  const config = normalizeConfig({ self: 'solo', web: { models: [{ id: 'claude-sonnet-5', label: 'Sonnet' }, 'claude-opus-5-5'] } }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  const res = await api({ method: 'GET', headers: {} }, new URL('http://x/api/settings'));
  assert.deepEqual(res.body.models, [
    { id: 'claude-sonnet-5', label: 'Sonnet' },
    { id: 'claude-opus-5-5', label: 'claude-opus-5-5' },
  ]);
});

test('/api/overmind merges self + peer; ?local=1 does not fetch peers', async (t) => {
  const { urls } = await startPair(t);
  const all = await get(`${urls.laptop}/api/overmind`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.hosts.map((h) => h.name), ['laptop', 'workstation']);
  assert.equal(all.body.hosts[1].sessions[0].host, 'workstation');
  assert.equal(all.body.hosts[1].spawnDirs[0].label, 'Tmp', 'peer advertises its own spawnDirs');
  const local = await get(`${urls.workstation}/api/overmind?local=1`);
  assert.deepEqual(local.body.hosts.map((h) => h.name), ['workstation']);
});

test('peek/send/keys are served locally or proxied exactly once', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const peek = await get(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/peek?lines=50`);
  assert.equal(peek.status, 200);
  assert.equal(peek.body.host, 'workstation');
  assert.equal(peek.body.text, 'screen of two');
  assert.deepEqual(remote.calls.at(-1), ['peek', 'bbbbbbbb-0000-0000-0000-000000000002', 50]);

  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/send`, { text: 'go' })).status, 200);
  assert.deepEqual(lap.calls.at(-1), ['send', 'aaaaaaaa-0000-0000-0000-000000000001', 'go']);
  assert.equal((await post(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/keys`, { key: 'Escape' })).status, 200);
  assert.deepEqual(remote.calls.at(-1), ['keys', 'bbbbbbbb-0000-0000-0000-000000000002', 'Escape']);

  const msgs = await get(`${urls.workstation}/api/hosts/laptop/sessions/aaaaaaaa/messages`);
  assert.equal(msgs.status, 200);
  assert.equal(msgs.body.messages[0].text, 'hi');

  // a request that already went through a proxy is never forwarded again
  const chained = await get(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/peek?local=1`);
  assert.equal(chained.status, 404);
});

test('live terminal: screen and input are served locally or proxied', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const screen = await get(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/screen`);
  assert.equal(screen.status, 200);
  assert.equal(screen.body.host, 'workstation');
  assert.deepEqual(screen.body.lines, ['screen of two', '']);
  assert.equal(screen.body.mouse.tracking, 'all');
  assert.deepEqual(remote.calls.at(-1), ['screen', 'bbbbbbbb-0000-0000-0000-000000000002']);

  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/input`, { data: '\x1b[B\r' })).status, 200);
  assert.deepEqual(lap.calls.at(-1), ['input', 'aaaaaaaa-0000-0000-0000-000000000001', '\x1b[B\r']);
  assert.equal((await post(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/input`, { data: '2' })).status, 200);
  assert.deepEqual(remote.calls.at(-1), ['input', 'bbbbbbbb-0000-0000-0000-000000000002', '2']);

  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/input`, { data: '' })).status, 400);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/input`, { data: 5 })).status, 400);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/input`)).status, 405);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/screen`, {})).status, 405);
});

test('spawn validates against this host\'s spawnDirs and proxies to peers', async (t) => {
  const { urls, remote } = await startPair(t);
  const res = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { name: 'My Job', prompt: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, 'workstation');
  assert.equal(res.body.name, 'my-job');
  assert.equal(remote.calls.at(-1)[1].dir, fs.realpathSync(os.tmpdir()));
});

test('spawn rejects dirs outside this host\'s spawnDirs (400)', async (t) => {
  const { urls, remote } = await startPair(t);
  const before = remote.calls.length;
  const outside = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { dir: '/' });
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /not inside one of this host's spawn dirs/);
  const escape = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { dir: path.join(os.tmpdir(), '..', '..') });
  assert.equal(escape.status, 400);
  assert.equal(remote.calls.length, before, 'nothing spawned');
});

test('errors: unknown host/session/route, bad input, wrong method', async (t) => {
  const { urls } = await startPair(t);
  assert.equal((await get(`${urls.laptop}/api/hosts/nope/sessions/x/peek`)).status, 404);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/sessions/zzzzzzzzzz/peek`)).status, 404);
  assert.equal((await get(`${urls.laptop}/api/nope`)).status, 404);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/send`, { text: '' })).status, 400);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/keys`, { key: 'C-c' })).status, 400);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/send`)).status, 405);
  assert.equal((await post(`${urls.laptop}/api/overmind`, {})).status, 405);
});

test('static UI is served from the configured ui dir', async (t) => {
  const { urls } = await startPair(t);
  const res = await fetch(`${urls.laptop}/`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<p>custom ui</p>');
  assert.equal((await fetch(`${urls.laptop}/missing.js`)).status, 404);
});

test('kill is POST-only, served locally or proxied once, and reports what happened', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/kill`)).status, 405);
  const local = await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/kill`, {});
  assert.equal(local.status, 200);
  assert.deepEqual(local.body, {
    ok: true,
    host: 'laptop',
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    name: 'one',
    process: 'terminated',
    terminal: 'tmux-session-killed',
  });
  assert.deepEqual(lap.calls.at(-1), ['kill', 'aaaaaaaa-0000-0000-0000-000000000001']);
  const proxied = await post(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/kill`, {});
  assert.equal(proxied.body.host, 'workstation');
  assert.deepEqual(remote.calls.at(-1), ['kill', 'bbbbbbbb-0000-0000-0000-000000000002']);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/zzzzzzzzzz/kill`, {})).status, 404);
});

test('sleep is POST-only, runs overmind sleep on the session id and reports the dormant entry', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/sleep`)).status, 405);
  const local = await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/sleep`, {});
  assert.equal(local.status, 200);
  assert.equal(local.body.ok, true);
  assert.equal(local.body.id, 'aaaaaaaa-0000-0000-0000-000000000001');
  assert.equal(local.body.terminal, 'tmux-session-killed');
  assert.deepEqual(local.body.dormant, { kind: 'tmux', target: 'one', slept: true });
  assert.deepEqual(lap.calls.at(-1), ['sleep', 'aaaaaaaa-0000-0000-0000-000000000001']);
  const proxied = await post(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/sleep`, {});
  assert.equal(proxied.body.host, 'workstation');
  assert.deepEqual(remote.calls.at(-1), ['sleep', 'bbbbbbbb-0000-0000-0000-000000000002']);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/zzzzzzzzzz/sleep`, {})).status, 404);
});

test('autoname runs on the target host and shows up in /api/health', async (t) => {
  const { urls, remote } = await startPair(t);
  assert.equal((await get(`${urls.laptop}/api/hosts/workstation/autoname`)).status, 405);
  const res = await post(`${urls.laptop}/api/hosts/workstation/autoname`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.host, 'workstation');
  assert.deepEqual(res.body.renamed, [{ from: 'app-9d', to: 'fix-login' }]);
  assert.deepEqual(remote.calls.at(-1), ['autoname', 'manual']);
  const h = await get(`${urls.workstation}/api/health`);
  assert.deepEqual(h.body.autoName, { enabled: true, intervalMinutes: 5, lastRun: remote.autoNamer.lastRun });
  assert.equal((await post(`${urls.laptop}/api/hosts/nope/autoname`, {})).status, 404);
});

test('spawn without a name lets the auto-namer name it (only when auto-naming is on)', async (t) => {
  const { urls, remote } = await startPair(t);
  await post(`${urls.laptop}/api/hosts/workstation/spawn`, {});
  assert.equal(remote.calls.at(-1)[1].nameGiven, false);
  await post(`${urls.laptop}/api/hosts/workstation/spawn`, { name: 'job' });
  assert.equal(remote.calls.at(-1)[1].nameGiven, true);
});

test('spawn passes a valid model through and rejects a bad one (400, nothing spawned)', async (t) => {
  const { urls, remote } = await startPair(t);
  const ok = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { model: 'claude-haiku-4-5-20251001' });
  assert.equal(ok.status, 200);
  assert.equal(remote.calls.at(-1)[1].model, 'claude-haiku-4-5-20251001');
  const picked = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { harness: 'codex', model: 'gpt-6-luna', effort: 'max' });
  assert.equal(picked.status, 200);
  assert.deepEqual([remote.calls.at(-1)[1].model, remote.calls.at(-1)[1].effort], ['gpt-6-luna', 'max']);
  const before = remote.calls.length;
  assert.equal((await post(`${urls.laptop}/api/hosts/workstation/spawn`, { effort: 'max; id' })).status, 400);
  const bad = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { model: "x'; touch /tmp/pwned" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /model must be/);
  assert.equal(remote.calls.length, before);
});

function spawnReq(body) {
  return import('node:stream').then(({ PassThrough }) => {
    const req = Object.assign(new PassThrough(), { method: 'POST', headers: {} });
    req.end(JSON.stringify(body));
    return req;
  });
}

test('an unnamed spawn with a first prompt schedules a targeted naming pass (auto-naming on only)', async () => {
  const scheduled = [];
  const spawnNamer = { schedule: async (tmux) => void scheduled.push(tmux) };
  const mk = (enabled) => {
    const host = fakeHost('solo', []);
    const config = normalizeConfig({ self: 'solo', web: { autoName: { enabled } }, spawnDirs: [{ path: os.tmpdir() }] }, { env: {}, home: '/home/tester' });
    return createApi({ config, ...host, spawnNamer, warmOvermind: false });
  };
  const url = new URL('http://x/api/hosts/solo/spawn');
  const on = mk(true);
  const res = await on(await spawnReq({ prompt: 'reply ok' }), url);
  assert.deepEqual(scheduled, [res.body.tmuxSession]);
  await on(await spawnReq({}), url); // no first prompt: nothing to name from yet
  await on(await spawnReq({ name: 'job', prompt: 'x' }), url); // named by hand
  assert.equal(scheduled.length, 1);
  await mk(false)(await spawnReq({ prompt: 'reply ok' }), url);
  assert.equal(scheduled.length, 1, 'auto-naming off: om-hhmmss fallback, no pass');
});

test('spawn keeps `claude -n <name>` when auto-naming is off', async () => {
  const host = fakeHost('solo', []);
  const config = normalizeConfig({ self: 'solo', web: { autoName: { enabled: false } }, spawnDirs: [{ path: os.tmpdir() }] }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  const req = Object.assign(new (await import('node:stream')).PassThrough(), { method: 'POST', headers: {} });
  req.end('{}');
  await api(req, new URL('http://x/api/hosts/solo/spawn'));
  assert.equal(host.calls.at(-1)[1].nameGiven, true);
});

test('/api/overmind is served from the warm snapshot with snapshotAt', async (t) => {
  const { urls } = await startPair(t);
  const first = await get(`${urls.laptop}/api/overmind`);
  assert.equal(typeof first.body.snapshotAt, 'number');
  const again = await get(`${urls.laptop}/api/overmind`);
  assert.ok(again.body.snapshotAt >= first.body.snapshotAt);
  assert.deepEqual(again.body.hosts.map((h) => h.name), ['laptop', 'workstation']);
});

test('static files carry a weak ETag and answer 304 to If-None-Match', async (t) => {
  const { urls } = await startPair(t);
  const res = await fetch(`${urls.laptop}/`);
  const etag = res.headers.get('etag');
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  await res.text();
  const cached = await fetch(`${urls.laptop}/`, { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('etag'), etag);
  const other = await fetch(`${urls.laptop}/`, { headers: { 'if-none-match': 'W/"nope"' } });
  assert.equal(other.status, 200);
  await other.text();
});

test('rename is POST-only, validated, served locally or proxied once, and a held session is a 409', async (t) => {
  const { lap, remote, urls } = await startPair(t);
  const base = `${urls.laptop}/api/hosts`;
  assert.equal((await get(`${base}/laptop/sessions/aaaaaaaa/rename`)).status, 405);
  // The session id goes to the CLI, never the fuzzy id from the URL.
  const local = await post(`${base}/laptop/sessions/aaaaaaaa/rename`, { title: '  Fix login  ' });
  assert.equal(local.status, 200);
  assert.equal(local.body.ok, true);
  assert.equal(local.body.result, 'renamed');
  assert.equal(local.body.title, 'Fix login');
  assert.equal(local.body.tmux.to, 'fix-login');
  assert.deepEqual(lap.calls.at(-1), ['rename', 'aaaaaaaa-0000-0000-0000-000000000001', 'Fix login']);

  const proxied = await post(`${base}/workstation/sessions/bbbbbbbb/rename`, { title: 'Docs refresh' });
  assert.equal(proxied.status, 200);
  assert.deepEqual(remote.calls.at(-1), ['rename', 'bbbbbbbb-0000-0000-0000-000000000002', 'Docs refresh']);
  assert.equal(lap.calls.filter((c) => c[0] === 'rename').length, 1, 'proxied, not run on the laptop');

  const held = await post(`${base}/workstation/sessions/bbbbbbbb/rename`, { title: 'while waiting' });
  assert.equal(held.status, 409);
  assert.equal(held.body.result, 'held');
  assert.match(held.body.error, /waiting on you/);

  const failed = await post(`${base}/laptop/sessions/aaaaaaaa/rename`, { title: 'explode' });
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /rename failed: tmux: boom/);

  for (const title of [undefined, 42, '   ', 'two\nlines', 'x'.repeat(65)]) {
    assert.equal((await post(`${base}/laptop/sessions/aaaaaaaa/rename`, { title })).status, 400, String(title));
  }
  assert.equal((await post(`${base}/laptop/sessions/zzzzzzzzzz/rename`, { title: 'x' })).status, 404);
});

test('autoname regenerates one session: POST-only, by session id with --refresh, proxied once, held is a 409', async (t) => {
  const { lap, remote, urls } = await startPair(t);
  const base = `${urls.laptop}/api/hosts`;
  assert.equal((await get(`${base}/laptop/sessions/aaaaaaaa/autoname`)).status, 405);
  const local = await post(`${base}/laptop/sessions/aaaaaaaa/autoname`, {});
  assert.equal(local.status, 200);
  assert.equal(local.body.name, 'fix-login');
  assert.deepEqual(lap.calls.at(-1), ['nameOne', 'aaaaaaaa-0000-0000-0000-000000000001', true]);

  const held = await post(`${base}/workstation/sessions/bbbbbbbb/autoname`, {});
  assert.equal(held.status, 409);
  assert.match(held.body.error, /waiting on you/);
  assert.deepEqual(remote.calls.at(-1), ['nameOne', 'bbbbbbbb-0000-0000-0000-000000000002', true]);
  assert.equal(lap.calls.filter((c) => c[0] === 'nameOne').length, 1, 'proxied, not run on the laptop');
});

test('overmind CLI rename runs `overmind rename <id> <title> --json` and resolves a held report (exit 3)', async () => {
  const calls = [];
  let mode = 'ok';
  const run = async (bin, args, opts) => {
    calls.push({ args, opts });
    if (mode === 'held') {
      throw Object.assign(new Error('exit 3'), { code: 3, stdout: JSON.stringify({ ok: false, result: 'held', held: 'waiting', message: 'x is waiting on you — nothing sent' }) });
    }
    if (mode === 'fail') throw Object.assign(new Error('Error: no live session matches "x"'), { code: 1, stdout: '' });
    return { stdout: JSON.stringify({ ok: true, result: 'sent', title: 'T' }), stderr: '' };
  };
  const cli = createOvermindCli({ run, bin: '/x/overmind' });
  assert.equal((await cli.rename({ target: 'abc', title: 'T' })).result, 'sent');
  assert.deepEqual(calls[0].args, ['rename', 'abc', 'T', '--json']);
  assert.equal(calls[0].opts.env.NO_COLOR, '1');
  mode = 'held';
  assert.equal((await cli.rename({ target: 'abc', title: 'T' })).held, 'waiting');
  mode = 'fail';
  await assert.rejects(cli.rename({ target: 'abc', title: 'T' }), /no live session/);
});

test('stacks: settings/health advertise them; a server without the stacks module answers 501, also through a peer', async (t) => {
  const { urls } = await startPair(t);
  const s = await get(`${urls.laptop}/api/settings`);
  assert.deepEqual(s.body.stacks, { enabled: false, model: 'sonnet', generate: true });
  const h = await get(`${urls.laptop}/api/health`);
  assert.deepEqual(h.body.stacks, { sync: false, lastSync: null });
  const proxied = await get(`${urls.laptop}/api/hosts/workstation/stacks`);
  assert.equal(proxied.status, 501);
  assert.match(proxied.body.error, /stacks are not available/);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/stacks/not-a-stack`)).status, 400);
  // The kill still works (and skips the sync) without it.
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/kill`, {})).status, 200);
});

test('usage is GET-only, served locally or proxied once, with ?refresh=1 passed through', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const here = await get(`${urls.laptop}/api/hosts/laptop/usage`);
  assert.equal(here.status, 200);
  assert.deepEqual([here.body.host, here.body.account.email, here.body.limits[0].percent], ['laptop', 'me@laptop', 25]);
  const there = await get(`${urls.laptop}/api/hosts/workstation/usage?refresh=1`);
  assert.deepEqual([there.body.host, there.body.account.email], ['workstation', 'me@workstation']);
  assert.deepEqual(lap.calls.filter((c) => c[0] === 'usage'), [['usage', false]]);
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'usage'), [['usage', true]]);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/usage`, {})).status, 405);
  assert.equal((await get(`${urls.laptop}/api/hosts/nope/usage`)).status, 404);
});

test('prs is GET-only, served locally or proxied, with ?refresh=1 passed through', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const here = await get(`${urls.laptop}/api/hosts/laptop/prs`);
  assert.equal(here.status, 200);
  assert.deepEqual([here.body.host, here.body.user, here.body.prs[0].column], ['laptop', 'me-laptop', 'waitingOnMe']);
  // Worktrees get "Open in editor" links from the server the browser asked (no ssh alias: none).
  assert.equal(here.body.prs[0].local.editorUrl, 'vscode://file/home/tester/wt/app%20feat');
  assert.equal(here.body.prs[1].local, undefined);
  const there = await get(`${urls.laptop}/api/hosts/workstation/prs?refresh=1`);
  assert.deepEqual([there.body.host, there.body.user], ['workstation', 'me-workstation']);
  assert.equal(there.body.prs[0].local.editorUrl, null);
  assert.deepEqual(lap.calls.filter((c) => c[0] === 'prs'), [['prs', false]]);
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'prs'), [['prs', true]]);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/prs`, {})).status, 405);
});

test('prs/checkout and prs/spawn: worktree first, then a session there told about the PR; proxied to peers', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const co = await post(`${urls.laptop}/api/hosts/laptop/prs/checkout`, { pr: 'acme/app#12' });
  assert.equal(co.status, 200);
  assert.deepEqual([co.body.host, co.body.worktree.path], ['laptop', '/home/tester/wt/app-feat']);
  assert.equal(co.body.worktree.editorUrl, 'vscode://file/home/tester/wt/app-feat');
  assert.equal(lap.calls.filter((c) => c[0] === 'spawn').length, 0);

  const sp = await post(`${urls.laptop}/api/hosts/workstation/prs/spawn`, { pr: 'acme/app#12', prompt: '  Check CI. ', name: 'pr-12', model: 'opus', effort: 'high' });
  assert.equal(sp.status, 200);
  assert.equal(sp.body.host, 'workstation');
  assert.equal(sp.body.spawn.tmuxSession, 'pr-12');
  const [, req] = remote.calls.find((c) => c[0] === 'spawn');
  assert.equal(req.dir, '/home/tester/wt/app-feat');
  assert.equal(req.prompt, "You're working on pull request acme/app#12 in /home/tester/wt/app-feat. Check CI.");
  assert.equal(req.model, 'opus');
  assert.equal(req.effort, 'high');
  assert.equal(lap.calls.filter((c) => c[0] === 'spawn').length, 0);
});

test('prs/spawn: bad input is a 400 before anything is fetched; a failed checkout spawns nothing', async (t) => {
  const { urls, lap } = await startPair(t);
  for (const pr of ['app#12', 'acme/app', '../x#1', 'acme/app#0', 42]) {
    const r = await post(`${urls.laptop}/api/hosts/laptop/prs/spawn`, { pr });
    assert.equal(r.status, 400, String(pr));
  }
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/prs/spawn`, { pr: 'acme/app#1', model: 'x y' })).status, 400);
  assert.equal(lap.calls.filter((c) => c[0] === 'prCheckout').length, 0);
  const r = await post(`${urls.laptop}/api/hosts/laptop/prs/spawn`, { pr: 'acme/gone#9' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /clone it there first/);
  assert.equal(lap.calls.filter((c) => c[0] === 'spawn').length, 0);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/prs/spawn`)).status, 405);
});

test('prs/seen marks a PR seen on the host it was fetched on', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const r = await post(`${urls.laptop}/api/hosts/workstation/prs/seen`, { pr: 'acme/app#30' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.host, r.body.pr, r.body.seenAt], ['workstation', 'acme/app#30', 1000]);
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'prSeen'), [['prSeen', 'acme/app#30']]);
  assert.equal(lap.calls.filter((c) => c[0] === 'prSeen').length, 0);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/prs/seen`, { pr: 'app#30' })).status, 400);
  assert.equal(lap.calls.filter((c) => c[0] === 'prCheckout').length, 0);
});

test('prs: a CLI failure is a 502 with its reason', async () => {
  const host = fakeHost('broken', []);
  const config = normalizeConfig({ self: 'broken' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  await assert.rejects(api({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/broken/prs')), (e) => e.status === 502 && /gh auth login/.test(e.message));
});

test('overmind CLI prs runs `overmind --local prs --json [--refresh]` and surfaces the last error line', async () => {
  const calls = [];
  let stderr = null;
  const run = async (bin, args) => {
    calls.push(args);
    if (stderr) throw Object.assign(new Error('exit 1'), { code: 1, stderr });
    return { stdout: JSON.stringify({ prs: [], stale: false }), stderr: '' };
  };
  const cli = createOvermindCli({ run, bin: '/x/overmind' });
  assert.deepEqual(await cli.prs(), { prs: [], stale: false });
  await cli.prs({ refresh: true });
  assert.deepEqual(calls, [['--local', 'prs', '--json'], ['--local', 'prs', '--json', '--refresh']]);
  stderr = 'warning: prs.orgs: 3 is not a name\nError: gh api graphql failed: HTTP 502\n';
  await assert.rejects(cli.prs(), /^OvermindCliError: gh api graphql failed: HTTP 502$/);
  stderr = "error: unrecognized subcommand 'prs'\n";
  await assert.rejects(cli.prs(), (e) => e.missing === true);
});

test('overmind CLI prCheckout runs `overmind --local pr checkout --json -- <ref>`', async () => {
  const calls = [];
  let stderr = null;
  const run = async (bin, args) => {
    calls.push(args);
    if (stderr) throw Object.assign(new Error('exit 1'), { code: 1, stderr });
    return { stdout: JSON.stringify({ path: '/w', created: true }), stderr: '' };
  };
  const cli = createOvermindCli({ run, bin: '/x/overmind' });
  assert.deepEqual(await cli.prCheckout('acme/app#3'), { path: '/w', created: true });
  assert.deepEqual(calls, [['--local', 'pr', 'checkout', '--json', '--', 'acme/app#3']]);
  stderr = 'Error: git fetch --quiet origin feat: fatal: could not read from remote\n';
  await assert.rejects(cli.prCheckout('acme/app#3'), /^OvermindCliError: git fetch --quiet origin feat: fatal/);
  stderr = null;
  await cli.prSeen('acme/app#3');
  assert.deepEqual(calls.at(-1), ['--local', 'pr', 'seen', '--json', '--', 'acme/app#3']);
  stderr = "error: unrecognized subcommand 'seen'\n";
  await assert.rejects(cli.prSeen('acme/app#3'), (e) => e.missing === true);
});

test('tasks is GET-only, served locally or proxied, with ?refresh=1 passed through', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const here = await get(`${urls.laptop}/api/hosts/laptop/tasks`);
  assert.equal(here.status, 200);
  assert.deepEqual([here.body.host, here.body.user.name, here.body.tasks[0].id], ['laptop', 'Ada@laptop', '1001']);
  const there = await get(`${urls.laptop}/api/hosts/workstation/tasks?refresh=1`);
  assert.deepEqual([there.body.host, there.body.user.name], ['workstation', 'Ada@workstation']);
  assert.deepEqual(lap.calls.filter((c) => c[0] === 'tasks'), [['tasks', false]]);
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'tasks'), [['tasks', true]]);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/tasks`, {})).status, 405);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/tasks/status`)).status, 405);
});

test('focus: status and start/stop on the host it names, proxied there; bad bodies are 400s', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  assert.deepEqual((await get(`${urls.laptop}/api/settings`)).body.focus, { host: null });
  const r = await post(`${urls.laptop}/api/hosts/workstation/focus`, { on: true, minutes: 25 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.host, r.body.active], ['workstation', true]);
  assert.equal((await get(`${urls.laptop}/api/hosts/workstation/focus`)).body.active, true);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/focus`)).body.active, false);
  await post(`${urls.workstation}/api/hosts/workstation/focus`, { on: false });
  assert.deepEqual(remote.calls.filter((c) => c[0].startsWith('focus')), [['focusStart', 25], ['focusStop']]);
  for (const body of [{}, { on: 'yes' }, { on: true, minutes: 0 }, { on: true, minutes: 2.5 }]) {
    assert.equal((await post(`${urls.laptop}/api/hosts/laptop/focus`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(lap.calls.filter((c) => c[0].startsWith('focus')).length, 0);
});

test('focus: no focus CLI is a 501', async () => {
  const host = fakeHost('solo', []);
  const config = normalizeConfig({ self: 'solo', web: { focus: { host: 'solo' } } }, { env: {}, home: '/home/tester' });
  assert.equal(config.focus.host, 'solo');
  host.focus.status = async () => {
    throw Object.assign(new Error('focus not found on this host'), { missing: true });
  };
  const api = createApi({ config, ...host, warmOvermind: false });
  await assert.rejects(api({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/solo/focus')), (e) => e.status === 501);
});

test('tasks: a CLI failure is a 502 with its reason; a CLI without the command is a 501', async () => {
  const host = fakeHost('broken', []);
  const config = normalizeConfig({ self: 'broken' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  await assert.rejects(api({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/broken/tasks')), (e) => e.status === 502 && /tasks\.token/.test(e.message));
  host.cli.tasks = async () => {
    throw Object.assign(new Error('x'), { missing: true });
  };
  await assert.rejects(api({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/broken/tasks')), (e) => e.status === 501);
  delete host.cli.tasks;
  await assert.rejects(api({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/broken/tasks')), (e) => e.status === 501);
});

test('tasks/status moves a task on the host it was fetched on; ids or links only', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const r = await post(`${urls.laptop}/api/hosts/workstation/tasks/status`, { task: 'https://app.productive.io/1-acme/tasks/1001', status: 'Working' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.host, r.body.task.id, r.body.task.status.name], ['workstation', '1001', 'Working']);
  assert.deepEqual(remote.calls.filter((c) => c[0] === 'taskStatus'), [['taskStatus', '1001', 'Working']]);
  for (const task of ['abc', '0', '../1', 'https://evil.example/tasks/1', null]) {
    assert.equal((await post(`${urls.laptop}/api/hosts/laptop/tasks/status`, { task, status: 'Working' })).status, 400, String(task));
  }
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/tasks/status`, { task: '1001' })).status, 400);
  assert.equal(lap.calls.filter((c) => c[0] === 'taskStatus').length, 0);
});

test('tasks/spawn: a session in a spawn dir whose first prompt is the task context line + the prompt', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const sp = await post(`${urls.laptop}/api/hosts/workstation/tasks/spawn`, { task: '1001', dir: os.tmpdir(), prompt: '  Plan it. ', name: 'task-1001', model: 'opus', effort: 'low' });
  assert.equal(sp.status, 200);
  assert.deepEqual([sp.body.host, sp.body.task.id, sp.body.spawn.tmuxSession], ['workstation', '1001', 'task-1001']);
  const [, req] = remote.calls.find((c) => c[0] === 'spawn');
  assert.equal(req.prompt, 'Productive task #12 “Fix it”: https://app.productive.io/1-acme/tasks/1001. Plan it.');
  assert.equal(req.model, 'opus');
  assert.equal(req.effort, 'low');
  assert.equal(lap.calls.filter((c) => c[0] === 'spawn').length, 0);

  // Bad input: 400 before anything is looked up; outside the spawn dirs: refused.
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/tasks/spawn`, { task: 'x', dir: os.tmpdir() })).status, 400);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/tasks/spawn`, { task: '1001', dir: os.tmpdir(), model: 'x y' })).status, 400);
  assert.equal(lap.calls.filter((c) => c[0] === 'taskShow').length, 0);
  const outside = await post(`${urls.laptop}/api/hosts/laptop/tasks/spawn`, { task: '1001', dir: '/' });
  assert.ok(outside.status >= 400, String(outside.status));
  const gone = await post(`${urls.laptop}/api/hosts/laptop/tasks/spawn`, { task: '404', dir: os.tmpdir() });
  assert.equal(gone.status, 502);
  assert.equal(lap.calls.filter((c) => c[0] === 'spawn').length, 0);
});

test('schedule: add (a time, or a task + time) on the named host, list, cancel; bad input is a 400', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const list = await fetch(`${urls.laptop}/api/hosts/workstation/schedule`).then((r) => r.json());
  assert.deepEqual([list.host, list.entries], ['workstation', []]);

  const timed = await post(`${urls.laptop}/api/hosts/workstation/schedule`, { at: '2026-10-29T07:30', dir: os.tmpdir(), prompt: ' Triage. ', model: 'opus', effort: 'high' });
  assert.equal(timed.status, 200);
  assert.equal(timed.body.host, 'workstation');
  const [, o] = remote.calls.find((c) => c[0] === 'scheduleAdd');
  assert.deepEqual([o.at, o.task, o.prompt, o.model, o.effort, o.name], ['2026-10-29T07:30', null, 'Triage.', 'opus', 'high', null]);

  const linked = await post(`${urls.laptop}/api/hosts/workstation/schedule`, { task: 'https://app.productive.io/1-acme/tasks/1001', time: '09:15', dir: os.tmpdir() });
  assert.equal(linked.status, 200);
  const [, o2] = remote.calls.filter((c) => c[0] === 'scheduleAdd')[1];
  assert.deepEqual([o2.at, o2.task, o2.time], [null, '1001', '09:15']);

  const cancel = await post(`${urls.laptop}/api/hosts/workstation/schedule/sabc/cancel`, {});
  assert.equal(cancel.status, 200);
  assert.deepEqual(remote.calls.find((c) => c[0] === 'scheduleCancel'), ['scheduleCancel', 'sabc']);

  for (const body of [
    { dir: os.tmpdir() }, // no when
    { at: 'tomorrow 09:00', task: '1001', dir: os.tmpdir() }, // both
    { at: '$(reboot)', dir: os.tmpdir() },
    { at: 'in 2h', time: '09:00', dir: os.tmpdir() }, // time without a task
    { task: 'x', dir: os.tmpdir() },
    { at: 'in 2h', dir: os.tmpdir(), model: 'x y' },
  ]) {
    assert.equal((await post(`${urls.laptop}/api/hosts/laptop/schedule`, body)).status, 400, JSON.stringify(body));
  }
  const outside = await post(`${urls.laptop}/api/hosts/laptop/schedule`, { at: 'in 2h', dir: '/' });
  assert.ok(outside.status >= 400, String(outside.status));
  assert.equal(lap.calls.filter((c) => c[0] === 'scheduleAdd').length, 0);
});

test('overmind CLI schedule / add / cancel pass every value as one flag', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args);
    return { stdout: args.includes('add') ? JSON.stringify({ id: 's1' }) : JSON.stringify({ host: 'h', entries: [] }), stderr: '' };
  };
  const cli = createOvermindCli({ run, bin: '/x/overmind' });
  await cli.schedule();
  await cli.scheduleAdd({ at: 'in 2h', dir: '/d', prompt: '-rf', harness: 'codex', model: 'gpt-6-luna', effort: 'max' });
  await cli.scheduleAdd({ task: '1001', time: '09:00', dir: '/d', name: 'n', ghIdentity: 'bot' });
  await cli.scheduleCancel('s1');
  assert.deepEqual(calls, [
    ['--local', 'schedule', '--json'],
    ['--local', 'schedule', 'add', '--json', '--at=in 2h', '--dir=/d', '--model=gpt-6-luna', '--effort=max', '--harness=codex', '--', '-rf'],
    ['--local', '--gh-identity=bot', 'schedule', 'add', '--json', '--task=1001', '--time=09:00', '--dir=/d', '--name=n'],
    ['--local', 'schedule', 'cancel', '--', 's1'],
  ]);
});

test('overmind CLI tasks / task show / task status run the CLI and flag a missing command', async () => {
  const calls = [];
  let stderr = null;
  const run = async (bin, args) => {
    calls.push(args);
    if (stderr) throw Object.assign(new Error('exit 1'), { code: 1, stderr });
    return { stdout: JSON.stringify({ tasks: [] }), stderr: '' };
  };
  const cli = createOvermindCli({ run, bin: '/x/overmind' });
  await cli.tasks();
  await cli.tasks({ refresh: true });
  await cli.taskShow('1001');
  await cli.taskStatus('1001', 'Peer Review');
  assert.deepEqual(calls, [
    ['--local', 'tasks', '--json'],
    ['--local', 'tasks', '--json', '--refresh'],
    ['--local', 'task', 'show', '--json', '--', '1001'],
    ['--local', 'task', 'status', '--json', '--', '1001', 'Peer Review'],
  ]);
  stderr = 'warning: tasks.refresh: 1s is too short\nError: no Productive API token: set tasks.token\n';
  await assert.rejects(cli.tasks(), /^OvermindCliError: no Productive API token: set tasks.token$/);
  stderr = "error: unrecognized subcommand 'tasks'\n";
  await assert.rejects(cli.tasks(), (e) => e.missing === true);
  stderr = "error: unrecognized subcommand 'task'\n";
  await assert.rejects(cli.taskShow('1'), (e) => e.missing === true);
});

test('harnesses: per host, cached, Claude models from the CLI, proxied to peers', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const here = await get(`${urls.laptop}/api/hosts/laptop/harnesses`);
  assert.equal(here.status, 200);
  assert.deepEqual(here.body.harnesses.map((h) => [h.id, h.installed]), [['claude', true], ['codex', false]]);
  assert.deepEqual(here.body.harnesses[0].models, [{ id: 'x', label: 'X' }]); // the host's CLI list (no web.models)
  await get(`${urls.laptop}/api/hosts/laptop/harnesses`);
  assert.equal(lap.calls.filter((c) => c[0] === 'harnesses').length, 1);
  const there = await get(`${urls.laptop}/api/hosts/workstation/harnesses`);
  assert.deepEqual([there.body.host, there.body.harnesses[1].installed], ['workstation', true]);
  assert.equal(remote.calls.filter((c) => c[0] === 'harnesses').length, 1);
});

test("harnesses: web.models wins over the CLI's Claude list; an empty CLI list falls back to the built-in one", async () => {
  const host = fakeHost('solo', []);
  host.cli.harnesses = async () => [{ id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [] }];
  const call = async (config) => {
    const api = createApi({ config, ...host, warmOvermind: false });
    return (await api({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/solo/harnesses'))).body.harnesses[0].models;
  };
  const opts = { env: {}, home: '/home/tester' };
  assert.deepEqual(await call(normalizeConfig({ self: 'solo', web: { models: ['opus'] } }, opts)), [{ id: 'opus', label: 'opus' }]);
  assert.deepEqual((await call(normalizeConfig({ self: 'solo' }, opts))).map((m) => m.id), ['', 'fable', 'opus', 'sonnet', 'haiku']);
});

test('usage: a CLI failure is a 502 with its reason', async () => {
  const host = fakeHost('broken', []);
  const config = normalizeConfig({ self: 'broken' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  await assert.rejects(api({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/broken/usage')), (e) => e.status === 502 && /no Claude Code login/.test(e.message));
});

test('overmind CLI usage runs `overmind --local usage --json [--refresh]` and surfaces its error', async () => {
  const calls = [];
  let fail = false;
  const run = async (bin, args) => {
    calls.push(args);
    if (fail) throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'Error: no Claude Code login found (run `claude` and /login)\n' });
    return { stdout: JSON.stringify({ limits: [], stale: false }), stderr: '' };
  };
  const cli = createOvermindCli({ run, bin: '/x/overmind' });
  assert.deepEqual(await cli.usage(), { limits: [], stale: false });
  await cli.usage({ refresh: true });
  assert.deepEqual(calls, [['--local', 'usage', '--json'], ['--local', 'usage', '--json', '--refresh']]);
  fail = true;
  await assert.rejects(cli.usage(), /^OvermindCliError: no Claude Code login found/);
});

/** A terminal's ↓: the cursor mark (col 0) moves to the next numbered option line. */
function cursorDown(screen) {
  const lines = screen.split('\n');
  const i = lines.findIndex((l) => /^[❯›] \d+\./.test(l));
  const j = lines.findIndex((l, k) => k > i && /^ {2}\d+\./.test(l));
  if (i < 0 || j < 0) return screen;
  const mark = lines[i][0];
  lines[i] = ` ${lines[i].slice(1)}`;
  lines[j] = `${mark}${lines[j].slice(1)}`;
  return lines.join('\n');
}

test('a question only on screen (not yet in the transcript) shows in messages and is answered tab by tab', async (t) => {
  const id = 'cccccccc-0000-0000-0000-000000000004';
  const host = fakeHost('solo', [{ session_id: id, name: 'q', status: 'waiting', backend: 'tmux', handle: '%4', updated_at: 4 }]);
  host.transcripts = fakeTranscripts([{ role: 'assistant', kind: 'assistant', text: 'Need a pick.' }]);
  const tab = (q, cursor = 1) =>
    `←  ☐ A  ☐ B  ✔ Submit  →\n\n${q}\n\n${cursor === 1 ? '❯' : ' '} 1. Yes\n${cursor === 2 ? '❯' : ' '} 2. No\n  3. Type something.\n${'─'.repeat(20)}\n  4. Chat about this\n\nEnter to select · Esc to cancel`;
  let screen = tab('First?');
  host.backend.peek = async () => screen;
  host.backend.keys = async (s, key) => {
    host.calls.push(['keys', s.session_id, key]);
    if (key === 'Down') screen = cursorDown(screen);
  };
  host.backend.type = async (s, text) => void host.calls.push(['type', s.session_id, text]);
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false, sleep: async () => {} });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const pending = async () => (await (await fetch(`${base}/api/hosts/solo/sessions/${id}/messages`)).json()).messages.at(-1);
  const call = async (body) => (await post(`${base}/api/hosts/solo/sessions/${id}/answer`, body)).status;
  const typed = () => host.calls.filter((c) => c[0] === 'keys' || c[0] === 'type').map((c) => c[2]);

  const first = await pending();
  assert.equal(first.kind, 'question');
  assert.match(first.id, /^screen:/);
  assert.equal(first.questions[0].question, 'First?');
  assert.deepEqual(first.questions[0].options.map((o) => o.label), ['Yes', 'No']);

  screen = tab('First?', 2);
  assert.equal(await call({ toolUseId: first.id, answers: [{ options: [0] }] }), 409, 'moved in the terminal');
  screen = tab('First?');
  assert.equal(await call({ toolUseId: first.id, answers: [{ options: [1] }] }), 200);
  assert.deepEqual(typed(), ['Down', 'Enter']);

  screen = tab('Second?');
  const second = await pending();
  assert.notEqual(second.id, first.id);
  assert.equal(await call({ toolUseId: first.id, answers: [{ options: [0] }] }), 409, 'the first tab is gone');

  screen = '⏺ Done.';
  assert.equal((await pending()).kind, 'assistant', 'no prompt on screen, no card');
});

test('a waiting Codex row: its approval menu is a card, answered by its menu index, 409 once the screen moved on', async (t) => {
  const id = '01a1a876-0000-7000-8000-000000000001';
  const host = fakeHost('solo', [{ session_id: id, name: 'cx', harness: 'codex', status: 'waiting', waiting_for: 'exec approval: `printf hi > hello.txt`', backend: 'tmux', handle: '%9', updated_at: 9 }]);
  host.transcripts = fakeTranscripts([{ role: 'user', kind: 'user', text: 'create hello.txt' }]);
  let screen = fs.readFileSync(new URL('./fixtures/codex-approval.txt', import.meta.url), 'utf8');
  host.backend.peek = async () => screen;
  host.backend.keys = async (s, key) => {
    host.calls.push(['keys', s.session_id, key]);
    if (key === 'Down') screen = cursorDown(screen);
  };
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false, sleep: async () => {} });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const card = async () => (await (await fetch(`${base}/api/hosts/solo/sessions/${id}/messages`)).json()).messages.at(-1);
  const call = async (body) => (await post(`${base}/api/hosts/solo/sessions/${id}/answer`, body)).status;
  const typed = () => host.calls.filter((c) => c[0] === 'keys' || c[0] === 'type').map((c) => c[2]);

  const m = await card();
  assert.equal(m.kind, 'question');
  assert.match(m.id, /^screen:/);
  assert.equal(m.questions[0].header, 'Approval');
  assert.match(m.questions[0].question, /\$ printf hi > hello\.txt/);
  assert.deepEqual(m.questions[0].options.map((o) => !!o.secondary), [false, true, false]);
  assert.equal(await call({ toolUseId: m.id, answers: [{ text: 'do it differently' }] }), 400, 'no free text');

  // Answered in the terminal meanwhile: 409, nothing typed.
  const before = screen;
  screen = '✔ You approved codex to run printf hi > hello.txt this time\n• Working (1s • esc to interrupt)';
  assert.equal(await call({ toolUseId: m.id, answers: [{ options: [0] }] }), 409);
  assert.deepEqual(typed(), []);
  screen = before;
  assert.equal(await call({ toolUseId: m.id, answers: [{ options: [2] }] }), 200);
  assert.deepEqual(typed(), ['Down', 'Down', 'Enter']);
});

test('review-codex S3/N1: the same command asked again is a new card — the earlier card cannot answer it, even before the list cache saw it', async (t) => {
  const id = '01a1a876-0000-7000-8000-000000000003';
  const rows = [{ session_id: id, name: 'cx', harness: 'codex', status: 'waiting', approval_id: 'call_a', backend: 'tmux', handle: '%9', updated_at: 9 }];
  const host = fakeHost('solo', rows);
  host.transcripts = fakeTranscripts([]);
  const screen = fs.readFileSync(new URL('./fixtures/codex-approval.txt', import.meta.url), 'utf8');
  host.backend.peek = async () => screen;
  const overmind = createOvermind({ cli: host.cli, self: 'solo' });
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, overmind, warmOvermind: false, sleep: async () => {} });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const card = async () => (await (await fetch(`${base}/api/hosts/solo/sessions/${id}/messages`)).json()).messages.at(-1);
  const call = async (body) => (await post(`${base}/api/hosts/solo/sessions/${id}/answer`, body)).status;

  const first = await card();
  assert.equal((await card()).id, first.id, 'stable while the same request waits');
  // Approved in the TUI and the same command asked again, within the list cache's TTL: the
  // answer lists afresh, so the stale card answers nothing.
  rows[0].approval_id = 'call_b';
  assert.equal(await call({ toolUseId: first.id, answers: [{ options: [0] }] }), 409, 'the stale card answers nothing');
  assert.deepEqual(host.calls.filter((c) => c[0] === 'keys'), []);
  const second = await card();
  assert.notEqual(second.id, first.id, 'a fresh card: its form starts over');
});

test('review-codex S1: the screen is read again before Enter — a moved cursor or another approval gets no Enter', async (t) => {
  const id = '01a1a876-0000-7000-8000-000000000002';
  const host = fakeHost('solo', [{ session_id: id, name: 'cx', harness: 'codex', status: 'waiting', backend: 'tmux', handle: '%9', updated_at: 9 }]);
  host.transcripts = fakeTranscripts([]);
  const menu = fs.readFileSync(new URL('./fixtures/codex-approval.txt', import.meta.url), 'utf8');
  const other = menu.replaceAll('printf hi > hello.txt', 'rm -rf build');
  let screen = menu;
  let onKey = () => {}; // what the terminal does on our next key, besides moving the cursor
  host.backend.peek = async () => screen;
  host.backend.keys = async (s, key) => {
    host.calls.push(['keys', s.session_id, key]);
    if (key === 'Down') screen = cursorDown(screen);
    onKey(key);
  };
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false, sleep: async () => {} });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const card = async () => (await (await fetch(`${base}/api/hosts/solo/sessions/${id}/messages`)).json()).messages.at(-1);
  const call = async (body) => (await post(`${base}/api/hosts/solo/sessions/${id}/answer`, body)).status;
  const keys = () => host.calls.filter((c) => c[0] === 'keys').map((c) => c[2]);
  const m = await card();

  // Option 1 is a lone Enter: someone presses ↓ in the terminal between our check and our key.
  let peeks = 0;
  host.backend.peek = async () => (++peeks === 2 ? (screen = cursorDown(screen)) : screen);
  assert.equal(await call({ toolUseId: m.id, answers: [{ options: [0] }] }), 409, 'the cursor sits on "don\'t ask again"');
  assert.deepEqual(keys(), [], 'no Enter');

  // Another approval takes its place while we press ↓↓.
  screen = menu;
  host.backend.peek = async () => screen;
  onKey = (key) => key === 'Down' && (screen = other);
  assert.equal(await call({ toolUseId: m.id, answers: [{ options: [2] }] }), 409);
  assert.deepEqual(keys(), ['Down'], 'review-codex N2: the screen is read before each key — one stray ↓ at most, never an Enter');

  // The redraw lags a key: it waits for the cursor, then picks.
  screen = menu;
  onKey = () => {};
  let lag = 0;
  host.backend.keys = async (s, key) => {
    host.calls.push(['keys', s.session_id, key]);
    if (key === 'Down') lag += 1;
  };
  host.backend.peek = async () => {
    if (lag) {
      screen = cursorDown(screen);
      lag -= 1;
      return menu; // this read still shows the old frame
    }
    return screen;
  };
  host.calls.length = 0;
  assert.equal(await call({ toolUseId: m.id, answers: [{ options: [1] }] }), 200);
  assert.deepEqual(keys(), ['Down', 'Enter']);
});

/** ↓ on any Codex menu: the `›` moves to the next numbered option, indentation kept (the MCP form indents its options). */
function menuCursorDown(screen) {
  const lines = screen.split('\n');
  const i = lines.findIndex((l) => /^\s*› \d+\./.test(l));
  const j = lines.findIndex((l, k) => k > i && /^\s*\d+\./.test(l));
  if (i < 0 || j < 0) return screen;
  const col = lines[i].indexOf('›');
  lines[i] = `${lines[i].slice(0, col)} ${lines[i].slice(col + 1)}`;
  const at = lines[j].search(/\d/) - 2;
  lines[j] = `${lines[j].slice(0, at)}›${lines[j].slice(at + 1)}`;
  return lines.join('\n');
}

/** A Codex row waiting on `fixture`'s menu, answered from the web through a fake tmux. */
async function codexMenuHost(t, fixture, row = {}) {
  const id = row.session_id ?? '01a1a876-0000-7000-8000-0000000000p5';
  const rows = [{ session_id: id, name: 'cx', harness: 'codex', status: 'waiting', backend: 'tmux', handle: '%9', updated_at: 9, ...row }];
  const host = fakeHost('solo', rows);
  host.transcripts = fakeTranscripts([]);
  const menu = fs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  const st = { screen: menu, onKey: () => {} };
  host.backend.peek = async () => st.screen;
  host.backend.keys = async (s, key) => {
    host.calls.push(['keys', s.session_id, key]);
    if (key === 'Down') st.screen = menuCursorDown(st.screen);
    st.onKey(key);
  };
  const overmind = createOvermind({ cli: host.cli, self: 'solo' });
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, overmind, warmOvermind: false, sleep: async () => {} });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  return {
    menu,
    st,
    rows,
    host,
    card: async () => (await (await fetch(`${base}/api/hosts/solo/sessions/${id}/messages`)).json()).messages.at(-1),
    call: async (body) => (await post(`${base}/api/hosts/solo/sessions/${id}/answer`, body)).status,
    keys: () => host.calls.filter((c) => c[0] === 'keys' || c[0] === 'type').map((c) => c[2]),
    reset: () => {
      host.calls.length = 0;
      st.screen = menu;
      st.onKey = () => {};
      host.backend.peek = async () => st.screen;
    },
  };
}

test('#34 phase 5: a Codex patch approval is a card — its files, the diff preview, picked by index with every screen check', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-p5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rollout = path.join(dir, 'rollout.jsonl');
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n+patched by mock 1\n*** Add File: new.txt\n+new file from mock 1\n+second line\n*** End Patch\n';
  fs.writeFileSync(
    rollout,
    [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_p1', name: 'apply_patch', input: patch } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  const h = await codexMenuHost(t, 'codex-approval-patch.txt', { cwd: '/work/project', transcript: rollout, approval_id: 'call_p1', waiting_for: 'patch approval: `a.txt, new.txt`' });
  const m = await h.card();
  assert.equal(m.kind, 'question');
  const [q] = m.questions;
  assert.equal(q.header, 'Edit approval');
  assert.equal(q.question, 'Would you like to make the following edits?\nFiles:\n  a.txt\n  new.txt');
  assert.match(q.preview, /^\*\*\* Update File: a\.txt\n@@\n alpha\n\+patched by mock 1/);
  assert.deepEqual(q.options.map((o) => !!o.secondary), [false, true, false]);

  // Yes / don't ask again for these files / No: each is Down × index + Enter.
  for (const [pick, want] of [[0, ['Enter']], [1, ['Down', 'Enter']], [2, ['Down', 'Down', 'Enter']]]) {
    h.reset();
    assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [pick] }] }), 200);
    assert.deepEqual(h.keys(), want);
  }

  // The cursor moved in the terminal before the answer: 409, nothing typed.
  h.reset();
  h.st.screen = menuCursorDown(h.menu);
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [0] }] }), 409);
  assert.deepEqual(h.keys(), []);
  // Moved between our check and our key (option 1 is a lone Enter): 409, no Enter.
  h.reset();
  let peeks = 0;
  h.host.backend.peek = async () => (++peeks === 2 ? (h.st.screen = menuCursorDown(h.st.screen)) : h.st.screen);
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [0] }] }), 409);
  assert.deepEqual(h.keys(), []);
  // Another patch (other files) takes its place during ↓↓: one stray ↓ at most, never an Enter.
  h.reset();
  h.st.onKey = (key) => key === 'Down' && (h.st.screen = h.menu.replaceAll('/work/project/new.txt', '/work/project/secrets.env'));
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [2] }] }), 409);
  assert.deepEqual(h.keys(), ['Down']);
  // A stale card: the same files asked again by another call — a new card, the old one answers nothing.
  h.reset();
  h.rows[0].approval_id = 'call_p2';
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [0] }] }), 409);
  assert.deepEqual(h.keys(), []);
  const fresh = await h.card();
  assert.notEqual(fresh.id, m.id);
  assert.equal(fresh.questions[0].preview, undefined, 'no pending call_p2 patch in the rollout: no preview, never another patch\'s');
});

test('#34 phase 5: a Codex MCP approval is a card — server, tool, arguments; four options picked by index with every screen check', async (t) => {
  const h = await codexMenuHost(t, 'codex-approval-mcp.txt', { approval_id: 'call_m1', waiting_for: 'MCP approval: `tiny.write_note`' });
  const m = await h.card();
  const [q] = m.questions;
  assert.equal(q.header, 'MCP approval');
  assert.match(q.question, /^Allow the tiny MCP server to run tool "write_note"\?\npath: /);
  assert.deepEqual(q.options.map((o) => o.label), ['Allow', 'Allow for this session', 'Always allow', 'Cancel']);
  assert.deepEqual(q.options.map((o) => !!o.secondary), [false, true, true, false]);
  for (const [pick, want] of [[0, ['Enter']], [1, ['Down', 'Enter']], [2, ['Down', 'Down', 'Enter']], [3, ['Down', 'Down', 'Down', 'Enter']]]) {
    h.reset();
    assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [pick] }] }), 200);
    assert.deepEqual(h.keys(), want);
  }
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ text: 'no' }] }), 400, 'no free text');
  h.reset();
  h.st.screen = menuCursorDown(h.menu);
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [1] }] }), 409, 'moved in the terminal');
  assert.deepEqual(h.keys(), []);
  // Another tool's approval replaces it during ↓↓↓ (Cancel): never an Enter on it.
  h.reset();
  h.st.onKey = (key) => key === 'Down' && (h.st.screen = h.menu.replace('run tool "write_note"', 'run tool "delete_all"'));
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [3] }] }), 409);
  assert.deepEqual(h.keys(), ['Down']);
  // The redraw lags a key: it waits for the cursor on "Always allow", then picks it.
  h.reset();
  let lag = 0;
  h.host.backend.keys = async (s, key) => {
    h.host.calls.push(['keys', s.session_id, key]);
    if (key === 'Down') lag += 1;
  };
  h.host.backend.peek = async () => {
    if (lag) {
      h.st.screen = menuCursorDown(h.st.screen);
      lag -= 1;
      return h.menu.replace('  › 1.', '    1.').replace(/^ {4}(\d)\./m, '  › $1.'); // a stale frame: cursor not yet there
    }
    return h.st.screen;
  };
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [2] }] }), 200);
  assert.deepEqual(h.keys(), ['Down', 'Down', 'Enter']);
  // Answered in the terminal: the history keeps "Called", no menu — 409.
  h.reset();
  h.st.screen = '• Called tiny.write_note\n  └ wrote /work/project/note.txt\n• done.';
  assert.equal(await h.call({ toolUseId: m.id, answers: [{ options: [0] }] }), 409);
  assert.deepEqual(h.keys(), []);
});

test('answer types the keys for the pending question, only when it is safe to', async (t) => {
  const id = 'cccccccc-0000-0000-0000-000000000003';
  const host = fakeHost('solo', [{ session_id: id, name: 'q', status: 'waiting', backend: 'tmux', handle: '%3', updated_at: 3 }]);
  const questions = [{ question: 'Merge it?', header: 'Merge', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }];
  let answered = null;
  host.transcripts = fakeTranscripts(() => [{ role: 'assistant', kind: 'question', id: 'tq1', questions, text: '', ...answered }]);
  let screen = 'Merge it?\n❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate';
  host.backend.peek = async () => screen;
  host.backend.type = async (s, text) => void host.calls.push(['type', s.session_id, text]);
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false, sleep: async () => {} });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const call = async (body) => (await post(`${base}/api/hosts/solo/sessions/${id}/answer`, body)).status;

  assert.equal(await call({ toolUseId: 'nope', answers: [{ options: [1] }] }), 404);
  assert.equal(await call({ toolUseId: 'tq1', answers: [{ options: [0, 1] }] }), 400);
  screen = 'Merge it?\n  1. Yes\n❯ 2. No\nEnter to select';
  assert.equal(await call({ toolUseId: 'tq1', answers: [{ options: [1] }] }), 409, 'moved in the terminal');
  assert.equal(host.calls.filter((c) => c[0] === 'keys' || c[0] === 'type').length, 0, 'nothing typed yet');
  screen = 'Merge it?\n❯ 1. Yes\n  2. No\nEnter to select';
  assert.equal(await call({ toolUseId: 'tq1', answers: [{ text: 'later' }] }), 200);
  assert.deepEqual(
    host.calls.filter((c) => c[0] === 'keys' || c[0] === 'type').map((c) => c[2]),
    ['Down', 'Down', 'later', 'Enter'],
  );
  answered = { answers: ['later'] };
  assert.equal(await call({ toolUseId: 'tq1', answers: [{ options: [0] }] }), 409, 'already answered');
});

// --- discovery on change (lib/watch.mjs → lib/overmind.mjs) ---------------------------------

function armedOvermind(rows = [{ session_id: 'aaaaaaaa-0000-0000-0000-000000000001', status: 'idle', updated_at: 1 }], { mode = 'watch' } = {}) {
  let t = 5_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  let running = false;
  const watcher = { start: () => (running = true), stop: () => (running = false), rearm() {}, status: () => ({ mode: running ? mode : 'idle', events: 0, roots: [] }) };
  const runs = [];
  const cli = { list: async () => (runs.push(clock.now()), rows) };
  const overmind = createOvermind({ cli, self: 'solo', watcher, now: clock.now, setTimer: () => null, clearTimer() {} });
  return { clock, runs, overmind };
}

test('?local=1 with an armed watcher: a quiet host lists once; a registry signal makes the next poll list', async () => {
  const { clock, runs, overmind } = armedOvermind();
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, warmOvermind: false });
  const poll = () => api({ method: 'GET', headers: {} }, new URL('http://x/api/overmind?local=1'));
  for (let i = 0; i < 3; i++) {
    const r = await poll();
    assert.equal(r.body.hosts[0].fetchedAt, clock.now(), 'checked now');
    clock.advance(3_000);
  }
  assert.equal(runs.length, 1, 'three polls in ~10 s, one CLI run');
  clock.advance(2_000);
  api.discoveryChanged('fast');
  await poll();
  assert.equal(runs.length, 2, 'the change is listed on the next poll');

  const h = await api({ method: 'GET', headers: {} }, new URL('http://x/api/health'));
  assert.equal(h.body.discovery.mode, 'watch');
  assert.equal(h.body.discovery.listRuns, 2);
  assert.equal(h.body.discovery.lastListAt, runs[1]);
  assert.equal(h.body.discovery.safetyMs, 30_000);
  assert.deepEqual(h.body.discovery.gaps, { fast: 1000, slow: 5000 });
});

test('review-38 S3: a watcher signal pokes a rebuild in watch mode only — degraded, the tick lists anyway', async (t) => {
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  for (const [mode, extra] of [['watch', 1], ['degraded', 0]]) {
    const { clock, runs, overmind } = armedOvermind(undefined, { mode });
    const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, overmindRefreshMs: 60_000 });
    t.after(() => api.stop());
    await api({ method: 'GET', headers: {} }, new URL('http://x/api/overmind'));
    await settle();
    const before = runs.length;
    clock.advance(10_000); // past the gap: the change is due at once
    api.discoveryChanged('slow');
    await settle();
    assert.equal(runs.length - before, extra, `${mode}: ${extra} extra list(s) per signal`);
  }
});

test('/api/health.discovery without a watcher says ttl', async () => {
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const cli = createOvermindCli({ run: async () => ({ stdout: '[]', stderr: '' }) });
  const api = createApi({ config, overmind: createOvermind({ cli, self: 'solo' }), backend: {}, transcripts: {}, spawner: {}, warmOvermind: false });
  const h = await api({ method: 'GET', headers: {} }, new URL('http://x/api/health'));
  assert.equal(h.body.discovery.mode, 'ttl');
  assert.equal(h.body.discovery.listRuns, 0);
});

test('refreshOvermind({ wait: true }) with an armed watcher resolves after a list that started after the call', async (t) => {
  const { runs, overmind } = armedOvermind();
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, overmindRefreshMs: 60_000 });
  t.after(() => api.stop());
  await api({ method: 'GET', headers: {} }, new URL('http://x/api/overmind'));
  assert.equal(runs.length, 1);
  await api.refreshOvermind({ wait: true });
  assert.equal(runs.length, 2, 'forced past the validated cache');
});

// --- chat deltas (#37) -----------------------------------------------------------------------

test('messages: no `after` is today\'s shape (+ full/from/cursor), the screen prompt inside messages', async (t) => {
  const id = 'cccccccc-0000-0000-0000-000000000037';
  const host = fakeHost('solo', [{ session_id: id, name: 'q', status: 'waiting', backend: 'tmux', handle: '%4', updated_at: 4 }]);
  host.transcripts = fakeTranscripts([{ role: 'user', kind: 'user', text: 'go' }, { role: 'assistant', kind: 'assistant', text: 'Need a pick.' }]);
  host.backend.peek = async () => '←  ☐ A  ✔ Submit  →\n\nFirst?\n\n❯ 1. Yes\n  2. No\n  3. Type something.\n\nEnter to select · Esc to cancel';
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const url = (q = '') => `${base}/api/hosts/solo/sessions/${id}/messages${q}`;

  const legacy = await get(url());
  assert.equal(legacy.status, 200);
  for (const k of ['host', 'id', 'status', 'backend', 'name', 'limit', 'messages', 'queue', 'total', 'truncated', 'updatedAt', 'capturedAt', 'full', 'from', 'cursor']) assert.ok(k in legacy.body, k);
  assert.equal('stable' in legacy.body, false, 'inside the cursor only');
  assert.equal('screen' in legacy.body, false);
  assert.deepEqual(legacy.body.messages.map((m) => m.kind), ['user', 'assistant', 'question'], 'the screen prompt last, as today');
  assert.deepEqual([legacy.body.total, legacy.body.truncated, legacy.body.full, legacy.body.from], [2, false, true, 0]);

  const first = await get(url('?after='));
  assert.deepEqual(first.body.messages.map((m) => m.kind), ['user', 'assistant'], 'never inside messages');
  assert.equal(first.body.screen.kind, 'question');
  assert.equal(first.body.full, true);
  const same = await get(url(`?after=${encodeURIComponent(first.body.cursor)}`));
  assert.deepEqual([same.body.full, same.body.from, same.body.messages, same.body.cursor], [false, 2, [], first.body.cursor]);
  assert.equal(same.body.screen.id, first.body.screen.id, 'sent on every answer, "same" too');
  assert.ok(JSON.stringify(same.body).length < 1500);

  host.backend.peek = async () => '⏺ Done.';
  const gone = await get(url(`?after=${encodeURIComponent(first.body.cursor)}`));
  assert.equal(gone.body.screen, null, 'the card drops the moment the prompt leaves the terminal');
});

test('messages: an open question left behind the window (a killed run, resumed) does not hide the screen prompt', async (t) => {
  const id = 'cccccccc-0000-0000-0000-000000000038';
  const host = fakeHost('solo', [{ session_id: id, name: 'q', status: 'waiting', backend: 'tmux', handle: '%4', updated_at: 4 }]);
  // The orphan: an AskUserQuestion that never got a result, then 70 messages of the resumed run.
  const orphan = { role: 'assistant', kind: 'question', id: 'toolu_orphan', questions: [{ question: 'Old?', header: 'Old', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }], text: 'Old?' };
  const after = Array.from({ length: 70 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', kind: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
  host.transcripts = fakeTranscripts([orphan, ...after]);
  host.backend.peek = async () => '←  ☐ A  ✔ Submit  →\n\nFirst?\n\n❯ 1. Yes\n  2. No\n  3. Type something.\n\nEnter to select · Esc to cancel';
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const url = (q) => `${base}/api/hosts/solo/sessions/${id}/messages?limit=60${q}`;

  const delta = await get(url('&after='));
  assert.equal(delta.body.screen?.kind, 'question', 'the orphan is 70 messages back, outside the window');
  assert.equal(delta.body.screen.questions[0].question, 'First?');
  const legacy = await get(url(''));
  assert.equal(legacy.body.messages.at(-1).kind, 'question', 'legacy shape: the prompt last, as today');
  assert.match(legacy.body.messages.at(-1).id, /^screen:/);
});

test('messages: a real reader behind the route — an idle poll is "same", an append is a small delta', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-delta-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = 'dddddddd-0000-0000-0000-000000000037';
  const file = transcriptPath('/w', id, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (type, text, mid) => JSON.stringify({ type, timestamp: '2026-11-05T10:00:00Z', message: { id: mid, role: type, content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => `${line('user', `prompt ${i}`)}\n${line('assistant', `reply ${i} ${'z'.repeat(400)}`, `m${i}`)}\n`).join(''));
  const host = fakeHost('solo', [{ session_id: id, name: 'r', status: 'idle', backend: 'tmux', handle: '%5', cwd: '/w', updated_at: 5 }]);
  host.transcripts = createTranscriptReader({ home });
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: '/home/tester' });
  const api = createApi({ config, ...host, warmOvermind: false });
  const server = createHttpServer({ handleApi: api, uiDir: os.tmpdir() });
  const base = await listen(server);
  t.after(() => server.close());
  const raw = async (after) => {
    const res = await fetch(`${base}/api/hosts/solo/sessions/${id}/messages?limit=60${after == null ? '' : `&after=${encodeURIComponent(after)}`}`);
    const text = await res.text();
    return { bytes: Buffer.byteLength(text), body: JSON.parse(text) };
  };
  const legacy = await raw(null);
  const first = await raw('');
  assert.deepEqual(first.body.messages, legacy.body.messages, 'a full answer is the legacy list');
  const idle = await raw(first.body.cursor);
  assert.equal(idle.body.messages.length, 0);
  assert.ok(idle.bytes < 400, `idle poll ${idle.bytes} B`);
  fs.appendFileSync(file, `${line('user', 'one more')}\n`);
  const next = await raw(idle.body.cursor);
  assert.deepEqual(next.body.messages.map((m) => m.text.slice(0, 8)), ['reply 29', 'one more']);
  assert.ok(next.bytes < legacy.bytes / 10, `delta ${next.bytes} B vs full ${legacy.bytes} B`);
});

test('messages through a peer: the proxy passes `after` and the delta both ways; an old peer\'s body passes unchanged', async (t) => {
  const { urls, lap } = await startPair(t);
  const via = (q) => get(`${urls.workstation}/api/hosts/laptop/sessions/aaaaaaaa/messages${q}`);
  const first = await via('?limit=60&after=');
  assert.deepEqual([first.status, first.body.host, first.body.full, first.body.messages.length], [200, 'laptop', true, 1]);
  const same = await via(`?limit=60&after=${encodeURIComponent(first.body.cursor)}`);
  assert.deepEqual([same.body.full, same.body.messages], [false, []]);
  const inner = lap.transcripts.delta;
  lap.transcripts.delta = async (s, o) => (lap.calls.push(['delta', o.after]), inner(s, o));
  await via(`?limit=60&after=${encodeURIComponent(first.body.cursor)}`);
  assert.deepEqual(lap.calls.at(-1), ['delta', first.body.cursor], 'the peer got the cursor verbatim');

  // An old peer: answers today's body whatever the query says (no cursor, no full).
  const oldBody = { host: 'old', id: 'eeee', status: 'idle', backend: 'tmux', name: 'x', limit: 60, messages: [{ role: 'user', kind: 'user', text: 'hi' }], queue: null, total: 1, truncated: false, updatedAt: 1, capturedAt: 2 };
  const old = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.includes('/messages') ? { ...oldBody, url: req.url } : { hosts: [] }));
  });
  const oldUrl = await listen(old);
  t.after(() => old.close());
  const cfg = normalizeConfig({ self: 'laptop', hosts: { laptop: { web: urls.laptop }, old: { web: oldUrl } } }, { env: {}, home: '/home/tester' });
  const proxy = createApi({ config: cfg, ...fakeHost('laptop', []), warmOvermind: false });
  t.after(() => proxy.stop());
  const res = await proxy({ method: 'GET', headers: {} }, new URL('http://x/api/hosts/old/sessions/eeee/messages?limit=60&after=abc'));
  assert.equal(res.status, 200);
  assert.equal(res.body.cursor, undefined, 'no cursor: the new UI reads it as a legacy answer');
  assert.deepEqual(res.body.messages, oldBody.messages);
  assert.match(res.body.url, /after=abc/);
});
