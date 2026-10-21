// Composer autocomplete: skills (built-in, user, project, enabled plugins incl. a directory
// marketplace), .md / .plain files under the cwd (git and a plain walk), brain notes from
// ~/.brainrc, and the …/complete route locally and through one peer hop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { BUILTIN_COMMANDS, brainRefs, createCompleter, parseBrainrc, parseFrontmatter } from '../lib/complete.mjs';

/** A fake $HOME: user skills + commands, two plugins (one disabled), a project, a brain. */
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-complete-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const w = (rel, text) => {
    const abs = path.join(home, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  w('.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\nargument-hint: "[env]"\n---\n# Deploy\n');
  w('.claude/skills/.trash/old/SKILL.md', '---\nname: old\n---\n');
  w('.claude/skills/notaskill/README.md', 'nope');
  w('.claude/commands/standup.md', 'Write my standup.\n');
  w('.claude/commands/git/sync.md', '---\ndescription: >\n  Fetch and\n  rebase\n---\nbody\n');
  w('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'tools@market': true, 'off@market': false, 'local@dirmarket': true } }));
  const cache = path.join(home, '.claude/plugins/cache');
  w('.claude/plugins/installed_plugins.json', JSON.stringify({
    version: 2,
    plugins: {
      'tools@market': [{ scope: 'user', installPath: path.join(cache, 'market/tools/1.0.0') }],
      'off@market': [{ scope: 'user', installPath: path.join(cache, 'market/off/1.0.0') }],
      'local@dirmarket': [{ scope: 'user', installPath: path.join(cache, 'dirmarket/local/0.1.0') }],
    },
  }));
  w('.claude/plugins/cache/market/tools/1.0.0/skills/review/SKILL.md', '---\nname: review\ndescription: Review a PR\n---\n');
  w('.claude/plugins/cache/market/tools/1.0.0/commands/fix.md', '---\ndescription: Fix it\n---\n');
  w('.claude/plugins/cache/market/off/1.0.0/skills/hidden/SKILL.md', '---\nname: hidden\n---\n');
  // A directory marketplace: no cache dir, the plugin lives next to marketplace.json.
  const market = path.join(root, 'dirmarket');
  w('.claude/plugins/known_marketplaces.json', JSON.stringify({ dirmarket: { installLocation: market } }));
  fs.mkdirSync(path.join(market, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'local', source: './local' }] }));
  fs.mkdirSync(path.join(market, 'local/skills/radar'), { recursive: true });
  fs.writeFileSync(path.join(market, 'local/skills/radar/SKILL.md'), '---\nname: radar\ndescription: Todos\n---\n');
  // A project with its own skill, nested cwd, and docs.
  w('proj/.claude/skills/release/SKILL.md', '---\nname: release\ndescription: Cut a release\n---\n');
  w('proj/.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: project deploy (shadowed)\n---\n');
  w('proj/README.md', '# Proj\n');
  w('proj/docs/a.md', 'a');
  w('proj/specs/x.plain', 'spec');
  w('proj/src/main.rs', 'fn main() {}');
  w('proj/node_modules/pkg/README.md', 'dep');
  w('proj/.hidden/h.md', 'h');
  // A brain.
  w('.brainrc', 'brain_root: ~/brain\neditor: nano\n');
  w('brain/sheds.md', '---\ntitle: Sheds\n---\nbody');
  w('brain/dev/overmind/overmind.md', '# Overmind notes\n');
  w('brain/a/log.md', 'x');
  w('brain/b/log.md', 'y');
  w('brain/.beads/x.md', 'no');
  return { root, home, proj: path.join(home, 'proj') };
}

/** `git ls-files` unavailable: the completer walks the cwd. */
const noGit = async () => {
  throw new Error('not a git repository');
};

test('parseFrontmatter: plain, quoted, block scalars, none', () => {
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: "a: b"\n---\n'), { name: 'x', description: 'a: b' });
  assert.deepEqual(parseFrontmatter('---\ndescription: |\n  one\n  two\nname: y\n---\n'), { description: 'one two', name: 'y' });
  assert.deepEqual(parseFrontmatter('# no frontmatter'), {});
});

test('parseBrainrc and brainRefs', () => {
  assert.equal(parseBrainrc('editor: vi\nbrain_root: ~/notes\n', '/h'), '/h/notes');
  assert.equal(parseBrainrc('brain_root: "/abs/brain"', '/h'), '/abs/brain');
  assert.equal(parseBrainrc('brain_root: relative', '/h'), null);
  assert.equal(parseBrainrc(null, '/h'), null);
  assert.deepEqual(
    brainRefs([{ path: 'a/log.md' }, { path: 'b/log.md' }, { path: 'x/y/y.md', title: 'Y' }]).map((n) => n.ref),
    ['a/log', 'b/log', 'y'],
  );
});

test('skills: built-ins, user, project (shadowed by user), enabled plugins only', async (t) => {
  const fx = fixture(t);
  const c = createCompleter({ home: fx.home, run: noGit });
  const { skills } = await c.list('skills', path.join(fx.proj, 'docs'));
  const by = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(skills.filter((s) => s.source === 'builtin').length, BUILTIN_COMMANDS.length);
  assert.deepEqual(by.deploy, { name: 'deploy', description: 'Ship it', source: 'user', argumentHint: '[env]' });
  assert.equal(by.standup.description, 'Write my standup.');
  assert.equal(by['git:sync'].description, 'Fetch and rebase');
  assert.equal(by.release.source, 'project');
  assert.equal(by['tools:review'].source, 'plugin');
  assert.equal(by['tools:fix'].description, 'Fix it');
  assert.equal(by['local:radar'].description, 'Todos');
  for (const gone of ['old', 'notaskill', 'off:hidden']) assert.equal(by[gone], undefined, gone);
  // No cwd: user-level only.
  const { skills: userOnly } = await c.list('skills', null);
  assert.equal(userOnly.some((s) => s.name === 'release'), false);
});

test('files: git ls-files with the .md / .plain pathspecs, else a walk without hidden / dependency dirs', async (t) => {
  const fx = fixture(t);
  const calls = [];
  const git = createCompleter({
    home: fx.home,
    run: async (bin, args) => (calls.push([bin, ...args]), { stdout: 'b.md\0a.plain\0b.md\0', stderr: '' }),
  });
  assert.deepEqual(await git.list('files', fx.proj), { files: ['a.plain', 'b.md'], truncated: false });
  assert.deepEqual(calls[0], ['git', '-C', fx.proj, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md', '*.plain']);

  const walk = createCompleter({ home: fx.home, run: noGit });
  assert.deepEqual((await walk.list('files', fx.proj)).files, ['README.md', 'docs/a.md', 'specs/x.plain']);
  assert.deepEqual((await walk.list('files', fx.home)).files, [], 'never walks all of $HOME');
  assert.deepEqual((await walk.list('files', null)).files, []);
});

test('files: cached briefly per cwd', async (t) => {
  const fx = fixture(t);
  let clock = 0;
  let calls = 0;
  const c = createCompleter({ home: fx.home, now: () => clock, run: async () => (calls++, { stdout: 'a.md\0', stderr: '' }) });
  await c.list('files', fx.proj);
  await c.list('files', fx.proj);
  assert.equal(calls, 1);
  clock += 60 * 1000;
  await c.list('files', fx.proj);
  assert.equal(calls, 2);
});

test('brain: notes under brain_root with titles and refs; absent without a ~/.brainrc', async (t) => {
  const fx = fixture(t);
  const c = createCompleter({ home: fx.home, run: noGit });
  const b = await c.list('brain', null);
  assert.equal(b.available, true);
  assert.deepEqual(b.notes, [
    { ref: 'a/log', path: 'a/log.md' },
    { ref: 'b/log', path: 'b/log.md' },
    { ref: 'overmind', path: 'dev/overmind/overmind.md', title: 'Overmind notes' },
    { ref: 'sheds', path: 'sheds.md', title: 'Sheds' },
  ]);
  fs.rmSync(path.join(fx.home, '.brainrc'));
  assert.deepEqual(await createCompleter({ home: fx.home, run: noGit }).list('brain', null), { available: false, notes: [] });
});

// --- over HTTP: laptop proxies to workstation ------------------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('HTTP: …/complete locally and through a peer; bad kind 400, unknown session 404, no completer 501', async (t) => {
  const fx = fixture(t);
  const urls = {};
  const handles = {};
  for (const name of ['laptop', 'workstation']) {
    const server = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(server);
    t.after(() => server.close());
  }
  const ids = { laptop: 'aaaaaaaa-0000-0000-0000-000000000001', workstation: 'bbbbbbbb-0000-0000-0000-000000000002' };
  for (const name of ['laptop', 'workstation']) {
    const config = normalizeConfig(
      { self: name, hosts: { laptop: { web: urls.laptop }, workstation: { web: urls.workstation } } },
      { env: {}, home: '/home/tester' },
    );
    const overmind = { localHost: async () => ({ name, ok: true, sessions: [{ session_id: ids[name], cwd: fx.proj, status: 'idle', backend: 'tmux' }] }) };
    // The workstation has no completer: a peer hop must reach it (and get its 501).
    const completer = name === 'laptop' ? createCompleter({ home: fx.home, run: noGit }) : null;
    const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, completer, warmOvermind: false });
    t.after(() => api.stop());
    handles[name] = api;
  }
  const base = `${urls.laptop}/api/hosts`;
  const get = async (u) => {
    const res = await fetch(u);
    return { status: res.status, body: await res.json() };
  };
  const files = await get(`${base}/laptop/sessions/aaaaaaaa/complete?kind=files`);
  assert.equal(files.status, 200);
  assert.deepEqual(files.body.files, ['README.md', 'docs/a.md', 'specs/x.plain']);
  assert.equal(files.body.kind, 'files');
  assert.equal((await get(`${base}/laptop/sessions/aaaaaaaa/complete?kind=brain`)).body.notes.length, 4);
  assert.equal((await get(`${base}/laptop/sessions/aaaaaaaa/complete?kind=nope`)).status, 400);
  assert.equal((await get(`${base}/laptop/sessions/zzzzzzzz/complete?kind=files`)).status, 404);
  assert.equal((await fetch(`${base}/laptop/sessions/aaaaaaaa/complete?kind=files`, { method: 'POST' })).status, 405);
  const remote = await get(`${base}/workstation/sessions/bbbbbbbb/complete?kind=skills`);
  assert.equal(remote.status, 501);
});
