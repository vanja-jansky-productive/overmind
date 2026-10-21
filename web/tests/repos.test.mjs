// Settings → Git repos: GET/PUT /api/hosts/:host/repos, POST …/repos/sync|service. Two API
// servers (laptop + workstation) with temp configs; the `overmind` CLI is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createOvermind } from '../lib/overmind.mjs';
import { createOvermindCli } from '../lib/overmind-cli.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createRepos, reposSettings, spanSeconds, validateReposSettings } from '../lib/repos.mjs';

function tmpdir(t, prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function call(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

const ROW = { name: 'app', path: '~/Code/app', every: 86400, excluded: false, due: false, branch: 'main', ahead: 0, behind: 0, dirty: 0 };

/** A fake `overmind`: list, repos (--json --all), repos sync, repos install-service, config set. */
function fakeRun(h) {
  return async (bin, args, opts = {}) => {
    h.calls.push(args);
    if (args[0] === 'list') return { stdout: '[]', stderr: '' };
    if (args[0] === '--local' && args[1] === 'config' && args[2] === 'set') {
      const file = opts.env.OVERMIND_CONFIG;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw[args[3]] = JSON.parse(args[4]);
      fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === '--local' && args[1] === 'repos') {
      if (h.locked && args[2] === 'sync') throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'Error: another `overmind repos sync` is running\n' });
      if (args[2] === '--json') return { stdout: JSON.stringify([ROW]), stderr: '' };
      if (args[2] === 'sync') return { stdout: JSON.stringify([{ name: 'app', path: '~/Code/app', outcome: 'updated', pulled: 2 }]), stderr: '' };
      if (args[2] === 'install-service') {
        if (args.includes('--uninstall')) fs.rmSync(h.plist, { force: true });
        else fs.writeFileSync(h.plist, '<plist/>');
        return { stdout: '', stderr: '' };
      }
    }
    throw new Error(`unexpected overmind ${args.join(' ')}`);
  };
}

async function startPair(t) {
  const root = tmpdir(t, 'overmind-repos-');
  const hosts = {};
  for (const name of ['laptop', 'workstation']) {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    hosts[name] = { home, configFile: path.join(home, 'config.json'), calls: [], plist: path.join(home, 'Library', 'LaunchAgents', 'overmind.repos.plist') };
  }
  const urls = {};
  const handles = {};
  for (const name of Object.keys(hosts)) {
    const server = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(server);
    t.after(() => server.close());
  }
  for (const [name, h] of Object.entries(hosts)) {
    const raw = {
      version: 1,
      self: name,
      hosts: { laptop: { ssh: null, web: urls.laptop }, workstation: { ssh: 'workstation', web: urls.workstation } },
      repos: { roots: ['~/Code'], somethingNew: 1 },
    };
    fs.writeFileSync(h.configFile, `${JSON.stringify(raw, null, 2)}\n`);
    const config = normalizeConfig(raw, { env: {}, home: h.home });
    const cli = createOvermindCli({ run: fakeRun(h) });
    const api = createApi({
      config,
      cli,
      overmind: createOvermind({ cli, self: name }),
      backend: {},
      transcripts: {},
      spawner: {},
      repos: createRepos({ cli, configFile: h.configFile, self: name, home: h.home }),
      overmindRefreshMs: 60_000,
    });
    t.after(() => api.stop());
    handles[name] = api;
  }
  return { hosts, urls };
}

test('spanSeconds / reposSettings: CLI-compatible intervals, defaults filled in', () => {
  assert.equal(spanSeconds('30m'), 1800);
  assert.equal(spanSeconds('7d'), 7 * 86400);
  for (const bad of ['0m', '30s', '1w', '', 30, null, '3651d']) assert.equal(spanSeconds(bad), null, String(bad));
  assert.deepEqual(reposSettings(undefined), { roots: ['~/Code'], every: '24h', overrides: {}, exclude: [] });
  assert.deepEqual(reposSettings({ roots: ['~/a', 3], every: 'soon', overrides: { x: '1h', y: 'no' }, exclude: ['z'] }), {
    roots: ['~/a'],
    every: '24h',
    overrides: { x: '1h' },
    exclude: ['z'],
  });
});

test('validateReposSettings', () => {
  const ok = validateReposSettings({ roots: [' ~/Code ', '~/Code', '/abs'], every: '12h', overrides: { app: '30m', '~/Code/x': '1h' }, exclude: ['old', 'old'] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.settings, { roots: ['~/Code', '/abs'], every: '12h', overrides: { app: '30m', '~/Code/x': '1h' }, exclude: ['old'] });

  const bad = validateReposSettings({ roots: ['Code'], every: '5s', overrides: { app: 'often', 'rel/x': '1h' }, exclude: [''] });
  assert.deepEqual(
    bad.errors.map((e) => e.field),
    ['roots', 'every', 'overrides', 'overrides', 'exclude'],
  );
  assert.equal(validateReposSettings({ roots: [], every: '1h' }).errors[0].field, 'roots');
});

test('GET/PUT repos on this host and through a peer; unknown repos keys survive', async (t) => {
  const { hosts, urls } = await startPair(t);
  const got = await call(`${urls.laptop}/api/hosts/workstation/repos`);
  assert.equal(got.status, 200);
  assert.equal(got.body.host, 'workstation');
  assert.deepEqual(got.body.repos, [ROW]);
  assert.deepEqual(got.body.service, { installed: false, supported: process.platform === 'darwin', tickMinutes: 10 });
  assert.ok(hosts.workstation.calls.some((a) => a.join(' ') === '--local repos --json --all'));

  const put = await call(`${urls.laptop}/api/hosts/workstation/repos`, 'PUT', { roots: ['~/Code', '~/Code/work/repos'], every: '24h', overrides: { app: '30m' }, exclude: [] });
  assert.equal(put.status, 200);
  assert.equal(put.body.saved, true);
  assert.deepEqual(put.body.settings.overrides, { app: '30m' });
  const stored = JSON.parse(fs.readFileSync(hosts.workstation.configFile, 'utf8')).repos;
  assert.equal(stored.somethingNew, 1);
  assert.deepEqual(stored.roots, ['~/Code', '~/Code/work/repos']);
  // The laptop's own config is untouched.
  assert.deepEqual(JSON.parse(fs.readFileSync(hosts.laptop.configFile, 'utf8')).repos.roots, ['~/Code']);

  const invalid = await call(`${urls.laptop}/api/hosts/laptop/repos`, 'PUT', { roots: ['nope'], every: '1h' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /absolute or start with ~/);
});

test('POST repos/sync and repos/service', async (t) => {
  const { hosts, urls } = await startPair(t);
  const s = await call(`${urls.laptop}/api/hosts/laptop/repos/sync`, 'POST', { names: ['app'] });
  assert.equal(s.status, 200);
  assert.equal(s.body.results[0].outcome, 'updated');
  assert.ok(hosts.laptop.calls.some((a) => a.join(' ') === '--local repos sync --json -- app'));

  hosts.laptop.locked = true;
  const busy = await call(`${urls.laptop}/api/hosts/laptop/repos/sync`, 'POST', {});
  assert.equal(busy.status, 409);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/repos/sync`, 'POST', { names: [3] })).status, 400);

  if (process.platform === 'darwin') {
    const on = await call(`${urls.laptop}/api/hosts/workstation/repos/service`, 'POST', { install: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.service.installed, true);
    const off = await call(`${urls.laptop}/api/hosts/workstation/repos/service`, 'POST', { install: false });
    assert.equal(off.body.service.installed, false);
  }
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/repos/service`, 'POST', {})).status, 400);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/repos/sync`)).status, 405);
});
