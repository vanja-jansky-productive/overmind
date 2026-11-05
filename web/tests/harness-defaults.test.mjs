// Settings → Agents: PUT /api/hosts/:host/harness-defaults, the defaults in GET harnesses, and the
// spawn line that uses them. Two API servers (laptop + workstation); the CLI is a fake object.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createOvermind } from '../lib/overmind.mjs';
import { harnessDefaultsOf, normalizeConfig } from '../lib/config.mjs';
import { applyHarnessDefaults, launchCommand } from '../lib/spawn.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function call(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

async function startPair(t) {
  const urls = {};
  const handles = {};
  const hosts = {};
  for (const name of ['laptop', 'workstation']) {
    const server = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(server);
    t.after(() => server.close());
  }
  for (const name of Object.keys(urls)) {
    const raw = {
      self: name,
      hosts: { laptop: { web: urls.laptop }, workstation: { ssh: 'workstation', web: urls.workstation } },
      harnesses: { codex: { command: 'codex', effort: 'low' } },
    };
    const config = normalizeConfig(raw, { env: {}, home: '/home/tester' });
    const sets = [];
    const cli = {
      list: async () => [],
      configSet: async ({ key, value }) => {
        sets.push([key, value]);
      },
      harnesses: async () => [
        { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [], efforts: ['low', 'high'] },
        { id: 'codex', label: 'Codex', command: 'codex', installed: true, models: [] },
      ],
    };
    const api = createApi({ config, cli, overmind: createOvermind({ cli, self: name }), backend: {}, transcripts: {}, spawner: {}, overmindRefreshMs: 60_000 });
    t.after(() => api.stop());
    handles[name] = api;
    hosts[name] = { config, sets };
  }
  return { urls, hosts };
}

test('PUT harness-defaults writes both keys through the CLI, locally or on a peer, and GET harnesses shows them', async (t) => {
  const { urls, hosts } = await startPair(t);

  const before = await call(`${urls.laptop}/api/hosts/laptop/harnesses`);
  const codex = before.body.harnesses.find((h) => h.id === 'codex');
  assert.equal(codex.defaultEffort, 'low');
  assert.deepEqual(codex.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh'], 'an older CLI without efforts gets the fallback');
  assert.deepEqual(before.body.harnesses.find((h) => h.id === 'claude').efforts, ['low', 'high']);

  const r = await call(`${urls.laptop}/api/hosts/workstation/harness-defaults`, 'PUT', { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { host: 'workstation', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(hosts.workstation.sets, [['harnesses.claude.model', 'claude-opus-5-5'], ['harnesses.claude.effort', 'high']]);
  assert.deepEqual(hosts.laptop.sets, [], 'the laptop only proxied it');
  assert.deepEqual(hosts.workstation.config.harnessDefaults.claude, { model: 'claude-opus-5-5', effort: 'high' });

  const after = await call(`${urls.laptop}/api/hosts/workstation/harnesses`);
  const claude = after.body.harnesses.find((h) => h.id === 'claude');
  assert.equal(claude.defaultModel, 'claude-opus-5-5', 'fresh from the config, not the 10-minute cache');
  assert.equal(claude.defaultEffort, 'high');

  // "" / null clear one
  const cleared = await call(`${urls.laptop}/api/hosts/laptop/harness-defaults`, 'PUT', { harness: 'codex', model: '', effort: null });
  assert.deepEqual(cleared.body, { host: 'laptop', harness: 'codex', model: null, effort: null });
  assert.deepEqual(hosts.laptop.sets, [['harnesses.codex.model', null], ['harnesses.codex.effort', null]]);
});

test('PUT harness-defaults refuses a bad harness, model or effort', async (t) => {
  const { urls, hosts } = await startPair(t);
  for (const body of [{ harness: 'gpt', model: null, effort: null }, { harness: 'claude', model: "x';id'", effort: null }, { harness: 'claude', model: null, effort: 'High!' }, { harness: 'pi', model: 5, effort: null }]) {
    const r = await call(`${urls.laptop}/api/hosts/laptop/harness-defaults`, 'PUT', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(hosts.laptop.sets, []);
});

test('the spawn line takes the defaults unless the pick or the launcher sets them', () => {
  const d = { model: 'claude-opus-5-5', effort: 'high' };
  const line = (launcher, harness, model, defaults) => launchCommand({ launcher, harness, prompt: 'go', ...applyHarnessDefaults(launcher, harness, model, defaults) });
  assert.equal(line('claude', 'claude', '', d), "claude --model 'claude-opus-5-5' --effort high 'go'");
  assert.equal(line('claude', 'claude', 'claude-haiku-5-5', d), "claude --model 'claude-haiku-5-5' --effort high 'go'");
  assert.equal(line('claude --model opus --effort low', 'claude', '', d), "claude --model opus --effort low 'go'");
  assert.equal(line('codex', 'codex', '', { effort: 'xhigh' }), "codex -c model_reasoning_effort=xhigh 'go'");
  assert.equal(line('pi', 'pi', '', { model: null, effort: 'medium' }), "pi --thinking medium 'go'");
  assert.equal(line('claude', 'claude', '', {}), "claude 'go'");
  // a picked effort wins over the default, also over a launcher's own (the harness's last flag wins)
  const picked = (launcher, harness, effort, defaults) => launchCommand({ launcher, harness, prompt: 'go', ...applyHarnessDefaults(launcher, harness, '', defaults, effort) });
  assert.equal(picked('claude', 'claude', 'max', d), "claude --model 'claude-opus-5-5' --effort max 'go'");
  assert.equal(picked('codex -c model_reasoning_effort=high', 'codex', 'low', {}), "codex -c model_reasoning_effort=high -c model_reasoning_effort=low 'go'");
  assert.equal(picked('codex', 'codex', '', { effort: 'xhigh' }), "codex -c model_reasoning_effort=xhigh 'go'", "'' is no pick");
});

test('harnessDefaultsOf reads leniently: bad values are dropped, never fatal', () => {
  assert.deepEqual(harnessDefaultsOf({ harnesses: { claude: { model: ' claude-opus-5-5 ', effort: 'high' }, codex: { model: 'a b', effort: 'X' }, pi: 'nope' } }), {
    claude: { model: 'claude-opus-5-5', effort: 'high' },
    codex: { model: null, effort: null },
    pi: { model: null, effort: null },
  });
});

const TMP = fs.realpathSync(os.tmpdir());
const SOL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const LUNA = ['low', 'medium', 'high', 'xhigh', 'max'];

/** One API server whose CLI lists per-model levels (Default = Luna) and counts `harness list` runs. */
async function startLevels(t, { sessions = [] } = {}) {
  const config = normalizeConfig({ self: 'laptop' }, { env: {}, home: TMP });
  const calls = [];
  let defaultLevels = LUNA;
  const cli = {
    list: async () => sessions,
    configSet: async () => {},
    harnesses: async () => {
      calls.push('harnesses');
      return [
        { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [], efforts: LUNA },
        {
          id: 'codex',
          label: 'Codex',
          command: 'codex',
          installed: true,
          models: [{ id: '', label: 'Default', efforts: defaultLevels }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: SOL }, { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: LUNA }],
          efforts: SOL,
        },
        { id: 'pi', label: 'pi', command: 'pi', installed: true, models: [] }, // a CLI from before per-spawn effort
      ];
    },
    prCheckout: async (ref) => (calls.push(['prCheckout', ref]), { path: '/tmp/wt', contextLine: '' }),
    taskStatus: async () => ({}),
    taskShow: async (id) => (calls.push(['taskShow', id]), { id, title: 'T', contextLine: '' }),
  };
  const spawner = { spawn: async (req) => (calls.push(['spawn', req.harness, req.model, req.effort]), { name: 'n', dir: req.dir, tmuxSession: 'n', command: 'x', trusted: true }) };
  const brancher = { branch: async (s, req) => (calls.push(['branch', req.effort]), { spawn: { name: 'b' } }) };
  const server = createHttpServer({ handleApi: (req, url) => api(req, url), uiDir: null });
  const api = createApi({ config, cli, overmind: createOvermind({ cli, self: 'laptop' }), backend: {}, transcripts: {}, spawner, brancher, overmindRefreshMs: 60_000 });
  const url = await listen(server);
  t.after(() => (api.stop(), server.close()));
  return { url, calls, setDefaultLevels: (l) => (defaultLevels = l) };
}

test('a Settings save drops the cached harness rows: Default carries the new default model’s levels at once', async (t) => {
  const { url, calls, setDefaultLevels } = await startLevels(t);
  const levels = async () => (await call(`${url}/api/hosts/laptop/harnesses`)).body.harnesses.find((h) => h.id === 'codex').models[0].efforts;
  assert.deepEqual(await levels(), LUNA);
  setDefaultLevels(SOL); // the default model is now Sol
  assert.deepEqual(await levels(), LUNA, 'cached');
  assert.equal((await call(`${url}/api/hosts/laptop/harness-defaults`, 'PUT', { harness: 'codex', model: 'gpt-6.1-sol', effort: null })).status, 200);
  assert.deepEqual(await levels(), SOL);
  assert.equal(calls.filter((c) => c === 'harnesses').length, 2);
});

test('an effort the picked model does not take is a 400 on every web spawn, worded like the CLI', async (t) => {
  const { url, calls } = await startLevels(t, { sessions: [{ session_id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'one', status: 'idle', backend: 'tmux', harness: 'codex', cwd: TMP, updated_at: 1 }] });
  const spawn = (body) => call(`${url}/api/hosts/laptop/spawn`, 'POST', { dir: TMP, ...body });
  let r = await spawn({ harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'effort "ultra" is not one Codex model gpt-6-luna takes — pick one of: low, medium, high, xhigh, max');
  r = await spawn({ harness: 'codex', effort: 'ultra' });
  assert.equal(r.status, 400, 'Default is Luna here');
  assert.match(r.body.error, /Codex's default model takes/);
  r = await spawn({ effort: 'ultra' });
  assert.match(r.body.error, /Claude Code's default model/);
  assert.equal(calls.filter((c) => c[0] === 'spawn').length, 0, 'nothing spawned');

  for (const ok of [{ harness: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' }, { harness: 'codex', model: 'gpt-7-new', effort: 'ultra' }, { harness: 'codex', effort: 'max' }, { effort: 'max' }, { harness: 'pi', effort: 'ultra' }]) {
    assert.equal((await spawn(ok)).status, 200, JSON.stringify(ok)); // a model the cache lacks: the harness's levels; pi lists none: no check
  }

  r = await call(`${url}/api/hosts/laptop/prs/spawn`, 'POST', { pr: 'acme/app#12', harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' });
  assert.equal(r.status, 400);
  r = await call(`${url}/api/hosts/laptop/tasks/spawn`, 'POST', { task: '1001', dir: TMP, harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' });
  assert.equal(r.status, 400);
  assert.equal(calls.filter((c) => c[0] === 'prCheckout' || c[0] === 'taskShow').length, 0, 'checked before anything is fetched');

  const branch = (body) => call(`${url}/api/hosts/laptop/sessions/aaaaaaaa-0000-0000-0000-000000000001/branch`, 'POST', { ref: 'm1', ...body });
  assert.equal((await branch({ effort: 'ultra' })).status, 400, "the source's harness, Codex Default = Luna");
  assert.equal((await branch({ model: 'gpt-6.1-sol', effort: 'ultra' })).status, 200);
  assert.deepEqual(calls.filter((c) => c[0] === 'branch'), [['branch', 'ultra']]);
  assert.equal(calls.filter((c) => c === 'harnesses').length, 1, 'the cached rows');
});
