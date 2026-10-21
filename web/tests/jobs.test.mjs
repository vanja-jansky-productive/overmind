// Jobs: GET /api/hosts/:host/jobs[/:name], POST …/jobs/:name/run|enabled. Two API servers
// (laptop + workstation); the `overmind` CLI is faked.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createOvermind } from '../lib/overmind.mjs';
import { createOvermindCli } from '../lib/overmind-cli.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createJobs, validJobName } from '../lib/jobs.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function call(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

const RUN = {
  id: '20260101-0700',
  trigger: 'schedule',
  startedAt: 1767247200000,
  slot: 1767247200000,
  outcome: 'spawned',
  reason: null,
  promptFile: null,
  sessions: [
    { tmuxSession: 'triage-0101-0700', name: 'triage-0101-0700', parent: null, at: 1767247200000, closedAt: null },
    { tmuxSession: 'triage-fix', name: 'triage-fix', parent: 'triage-0101-0700', at: 1767247300000, closedAt: null },
  ],
};
const JOB = {
  name: 'triage',
  schedule: '0 7 * * 1-5',
  enabled: true,
  dir: '~/Code/project',
  harness: 'claude',
  model: null,
  command: 'claude',
  keep: 86400,
  prompt: { inline: 'triage' },
  nextRun: 1767333600000,
  lastSlot: 1767247200000,
  runs: [RUN],
  live: [],
};

/** A fake `overmind`: list, jobs (--json / show / run / enable / disable). */
function fakeRun(h) {
  const fail = (stderr) => Object.assign(new Error('exit 1'), { code: 1, stderr });
  return async (bin, args) => {
    h.calls.push(args);
    if (args[0] === 'list') return { stdout: '[]', stderr: '' };
    if (args[0] === '--local' && args[1] === 'jobs') {
      if (h.old) throw fail("error: unrecognized subcommand 'jobs'\n");
      const name = args.at(-1);
      if (args[2] === '--json') return { stdout: JSON.stringify(h.jobs ?? [JOB]), stderr: '' };
      if (name !== 'triage') throw fail(`Error: no bot \`${name}\` — configured: triage\n`);
      if (args[2] === 'show') return { stdout: JSON.stringify({ ...JOB, enabled: h.enabled }), stderr: '' };
      if (args[2] === 'run') {
        if (h.busy && !args.includes('--force')) throw fail('Error: triage: a session of the job is working — pass --force to start another run anyway\n');
        return { stdout: '→ triage — run 20260101-0900 in tmux session triage-0101-0900\n', stderr: '' };
      }
      if (args[2] === 'enable' || args[2] === 'disable') {
        h.enabled = args[2] === 'enable';
        return { stdout: h.enabled ? 'triage: enabled — next run tomorrow 07:00\n' : 'triage: paused\n', stderr: '' };
      }
    }
    throw new Error(`unexpected overmind ${args.join(' ')}`);
  };
}

async function startPair(t) {
  const hosts = { laptop: { calls: [], enabled: true }, workstation: { calls: [], enabled: true } };
  const urls = {};
  const handles = {};
  for (const name of Object.keys(hosts)) {
    const server = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(server);
    t.after(() => server.close());
  }
  for (const [name, h] of Object.entries(hosts)) {
    const raw = { version: 1, self: name, hosts: { laptop: { ssh: null, web: urls.laptop }, workstation: { ssh: 'workstation', web: urls.workstation } } };
    const config = normalizeConfig(raw, { env: {}, home: '/nonexistent' });
    const cli = createOvermindCli({ run: fakeRun(h) });
    const api = createApi({
      config,
      cli,
      overmind: createOvermind({ cli, self: name }),
      backend: {},
      transcripts: {},
      spawner: {},
      jobs: createJobs({ cli, self: name, home: `/home/${name}`, exists: (p) => p === `/home/${name}/notes/.git` }),
      overmindRefreshMs: 60_000,
    });
    t.after(() => api.stop());
    handles[name] = api;
  }
  return { hosts, urls };
}

test('validJobName', () => {
  for (const ok of ['triage', 'a', 'nightly_build-2', 'x'.repeat(40)]) assert.equal(validJobName(ok), true, ok);
  for (const bad of ['', 'x'.repeat(41), 'a b', 'a/b', '../x', 'é', null, 3]) assert.equal(validJobName(bad), false, String(bad));
});

test('GET jobs and jobs/:name, here and through a peer', async (t) => {
  const { hosts, urls } = await startPair(t);
  const list = await call(`${urls.laptop}/api/hosts/workstation/jobs`);
  assert.equal(list.status, 200);
  assert.equal(list.body.host, 'workstation');
  assert.deepEqual(list.body.jobs, [JOB]);
  assert.ok(hosts.workstation.calls.some((a) => a.join(' ') === '--local jobs --json'));
  assert.ok(!hosts.laptop.calls.some((a) => a[1] === 'jobs'));

  const show = await call(`${urls.laptop}/api/hosts/laptop/jobs/triage`);
  assert.equal(show.status, 200);
  assert.equal(show.body.host, 'laptop');
  assert.equal(show.body.runs[0].sessions[1].parent, 'triage-0101-0700');
  assert.ok(hosts.laptop.calls.some((a) => a.join(' ') === '--local jobs show --json -- triage'));

  const missing = await call(`${urls.laptop}/api/hosts/workstation/jobs/nope`);
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no bot `nope`/);

  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/jobs/bad%20name`)).status, 400);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/jobs/${'x'.repeat(41)}`)).status, 400);
  assert.equal((await call(`${urls.laptop}/api/hosts/nowhere/jobs`)).status, 404);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/jobs`, 'POST', {})).status, 405);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/jobs/triage/run`)).status, 405);
});

test('GET jobs: a prompt file gets its absolute path and an editor link', async (t) => {
  const { hosts, urls } = await startPair(t);
  hosts.workstation.jobs = [
    { ...JOB, prompt: { file: '~/notes/triage.md' } },
    { ...JOB, name: 'abs', prompt: { file: '/srv/prompt.md' } },
    { ...JOB, name: 'rel', prompt: { file: 'prompt.md' } },
  ];
  const list = await call(`${urls.laptop}/api/hosts/workstation/jobs`);
  assert.equal(list.status, 200);
  const remote = 'vscode://vscode-remote/ssh-remote+workstation';
  assert.deepEqual(
    list.body.jobs.map((j) => j.prompt),
    [
      {
        file: '~/notes/triage.md',
        abs: '/home/workstation/notes/triage.md',
        root: '/home/workstation/notes',
        editorUrl: `${remote}/home/workstation/notes/triage.md:1`,
        rootEditorUrl: `${remote}/home/workstation/notes`,
      },
      { file: '/srv/prompt.md', abs: '/srv/prompt.md', root: '/srv', editorUrl: `${remote}/srv/prompt.md:1`, rootEditorUrl: `${remote}/srv` },
      { file: 'prompt.md' },
    ],
  );
  hosts.laptop.jobs = [{ ...JOB, prompt: { file: '~/p.md' } }];
  const local = await call(`${urls.laptop}/api/hosts/laptop/jobs`);
  assert.deepEqual(local.body.jobs[0].prompt, {
    file: '~/p.md',
    abs: '/home/laptop/p.md',
    root: '/home/laptop',
    editorUrl: 'vscode://file/home/laptop/p.md:1',
    rootEditorUrl: 'vscode://file/home/laptop',
  });
});

test('POST jobs/:name/run: refuses while busy unless forced, proxies to a peer', async (t) => {
  const { hosts, urls } = await startPair(t);
  const ok = await call(`${urls.laptop}/api/hosts/workstation/jobs/triage/run`, 'POST', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.host, 'workstation');
  assert.match(ok.body.output, /run 20260101-0900/);
  assert.ok(hosts.workstation.calls.some((a) => a.join(' ') === '--local jobs run -- triage'));

  hosts.workstation.busy = true;
  const busy = await call(`${urls.laptop}/api/hosts/workstation/jobs/triage/run`, 'POST', {});
  assert.equal(busy.status, 409);
  assert.equal(busy.body.busy, true);
  assert.match(busy.body.error, /--force/);
  const forced = await call(`${urls.laptop}/api/hosts/workstation/jobs/triage/run`, 'POST', { force: true });
  assert.equal(forced.status, 200);
  assert.ok(hosts.workstation.calls.some((a) => a.join(' ') === '--local jobs run --force -- triage'));

  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/jobs/triage/run`, 'POST', { force: 'yes' })).status, 400);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/jobs/nope/run`, 'POST', {})).status, 404);
});

test('POST jobs/:name/enabled', async (t) => {
  const { hosts, urls } = await startPair(t);
  const off = await call(`${urls.laptop}/api/hosts/workstation/jobs/triage/enabled`, 'POST', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.job.enabled, false);
  assert.match(off.body.output, /paused/);
  assert.ok(hosts.workstation.calls.some((a) => a.join(' ') === '--local jobs disable -- triage'));
  const on = await call(`${urls.laptop}/api/hosts/workstation/jobs/triage/enabled`, 'POST', { enabled: true });
  assert.equal(on.body.job.enabled, true);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/jobs/triage/enabled`, 'POST', {})).status, 400);
});

test('an older CLI without `jobs` → 501', async (t) => {
  const { hosts, urls } = await startPair(t);
  hosts.workstation.old = true;
  for (const [path, method, body] of [
    ['jobs', 'GET'],
    ['jobs/triage', 'GET'],
    ['jobs/triage/run', 'POST', {}],
    ['jobs/triage/enabled', 'POST', { enabled: true }],
  ]) {
    const r = await call(`${urls.laptop}/api/hosts/workstation/${path}`, method, body);
    assert.equal(r.status, 501, path);
    assert.match(r.body.error, /no `jobs` command/);
  }
});
