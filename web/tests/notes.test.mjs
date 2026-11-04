// Notes explorer: the root sandbox (traversal, symlinks out, hidden / ignored entries),
// frontmatter, withheld age blocks, the built-in search and an external search command,
// config parsing, and the HTTP routes locally and through one peer hop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import {
  cleanRel,
  createNotes,
  isIgnored,
  matchRanges,
  parseIgnore,
  parseQuery,
  parseSearchOutput,
  snippet,
  splitFrontmatter,
  withoutSecrets,
} from '../lib/notes.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const AGE = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBhYmNkZWZnaGlqa2xtbm9w\n-----END AGE ENCRYPTED FILE-----';

/** A synthetic notes dir with a secret-ish store, a symlink out and ignored folders. */
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-notes-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(home, 'notes');
  const outside = path.join(base, 'outside');
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  fs.mkdirSync(outside, { recursive: true });
  w('index.md', '---\ntitle: Garden index\ntags: [garden, ref]\n---\n# Ignored heading\n\nSee [[recipes/soup]] and [pasta](recipes/pasta.md).\n');
  w('recipes/soup.md', '# Tomato soup\n\nSimmer the tomatoes.\n\n## Serving\n\nWith basil and tomatoes.\n');
  w('recipes/pasta.md', '---\ntags:\n  - food\n  - quick\nsource: https://example.com/pasta\n---\nBoil water. Add pasta.\n![plate](img/plate.png)\n');
  w('recipes/img/plate.png', PNG);
  w('data/payload.json', '{ "tomato": 1 }\n');
  w('vault/locked.md', `---\nencrypted: true\n---\n<!-- secret -->\n${AGE}\n<!-- /secret -->\n`);
  w('.git/config', '[core]\n');
  w('.hidden/secret.md', 'hidden tomato\n');
  w('node_modules/pkg/readme.md', 'tomato\n');
  w('build/out.md', 'tomato build output\n');
  w('scratch.log', 'tomato\n');
  w('drafts/private.md', 'tomato draft\n');
  w('.gitignore', '# comment\nbuild/\n*.log\n!keep.md\n');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'outside tomato\n');
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'secret-link.md'));
  fs.symlinkSync(path.join(root, 'recipes'), path.join(root, 'link-in'));
  fs.symlinkSync(path.join(root, 'recipes', 'soup.md'), path.join(root, 'alias.md'));
  return { base, home, root, outside };
}

const notesFor = (fx, extra = {}) => createNotes({ config: { root: fx.root, name: 'notes', searchCmd: null, exclude: ['drafts'], ...extra }, home: fx.home });

test('cleanRel: only plain root-relative paths', () => {
  assert.equal(cleanRel('a/b.md'), 'a/b.md');
  assert.equal(cleanRel('./a//b.md'), 'a/b.md');
  for (const bad of ['', '/etc/passwd', '../x.md', 'a/../../x.md', 'a/.git/config', '.env', 'a\\b.md', 'a\0b', null, 3]) assert.equal(cleanRel(bad), null, String(bad));
});

test('parseIgnore / isIgnored: names, dirs, anchored paths, globs; negations dropped', () => {
  const rules = parseIgnore('build/\n*.log\n/top.md\ndocs/**/tmp\n!keep.md\n[ab].md\n');
  assert.equal(rules.length, 4);
  assert.equal(isIgnored('x/build', 'build', true, rules), true);
  assert.equal(isIgnored('x/build', 'build', false, rules), false);
  assert.equal(isIgnored('a/b.log', 'b.log', false, rules), true);
  assert.equal(isIgnored('top.md', 'top.md', false, rules), true);
  assert.equal(isIgnored('sub/top.md', 'top.md', false, rules), false);
  assert.equal(isIgnored('docs/a/b/tmp', 'tmp', true, rules), true);
});

test('splitFrontmatter: scalars, inline and block lists, quoted values', () => {
  const fm = splitFrontmatter('---\ntitle: "Hello"\ntags: [a, b]\nitems:\n  - one\n  - two\nempty:\n---\nbody\n')
  assert.deepEqual(fm.meta, [['title', 'Hello'], ['tags', ['a', 'b']], ['items', ['one', 'two']]]);
  assert.equal(fm.body, 'body\n');
  assert.equal(fm.lines, 8);
  assert.deepEqual(splitFrontmatter('no fm').meta, []);
});

test('withoutSecrets: age blocks are withheld', () => {
  const r = withoutSecrets(`a\n${AGE}\nb`);
  assert.equal(r.encrypted, true);
  assert.equal(r.text, 'a\n[encrypted]\nb');
  assert.equal(withoutSecrets('plain').encrypted, false);
});

test('parseQuery / matchRanges / snippet', () => {
  assert.deepEqual(parseQuery('Foo "two words" #Tag foo'), [{ v: 'foo' }, { v: 'two words' }, { v: '#tag', tag: 'tag' }]);
  assert.deepEqual(matchRanges('Tomato and tomatoes', [{ v: 'tomato' }]), [[0, 6], [11, 17]]);
  assert.deepEqual(matchRanges('abcabc', [{ v: 'abc' }, { v: 'bca' }]), [[0, 6]]);
  const long = `${'x'.repeat(300)} needle ${'y'.repeat(300)}`;
  const s = snippet(long, [{ v: 'needle' }], 100);
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'));
  assert.equal(s.text.slice(s.ranges[0][0], s.ranges[0][1]), 'needle');
});

test('parseSearchOutput: grep -n lines and path + indented matches', () => {
  assert.deepEqual(parseSearchOutput('a/b.md:3:hello there\nc.md:10:x:y\nnot a path\n'), [
    { path: 'a/b.md', matches: [{ line: 3, text: 'hello there' }] },
    { path: 'c.md', matches: [{ line: 10, text: 'x:y' }] },
  ]);
  assert.deepEqual(parseSearchOutput('notes/x.md\n  first hit\n  tags: a, b\n  ... +3 more\nother.md\n  z\n'), [
    { path: 'notes/x.md', matches: [{ line: null, text: 'first hit' }, { line: null, text: 'tags: a, b' }] },
    { path: 'other.md', matches: [{ line: null, text: 'z' }] },
  ]);
});

test('tree: md/text/images only, hidden + node_modules + .gitignore + exclude skipped, symlinked dirs not followed, symlinks out refused', async (t) => {
  const fx = fixture(t);
  const notes = notesFor(fx);
  const tree = await notes.tree();
  const paths = tree.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'alias.md',
    'data/payload.json',
    'index.md',
    'recipes/img/plate.png',
    'recipes/pasta.md',
    'recipes/soup.md',
    'vault/locked.md',
  ]);
  assert.equal(tree.name, 'notes');
  assert.equal(tree.root, '~/notes');
  const byPath = Object.fromEntries(tree.files.map((f) => [f.path, f]));
  assert.equal(byPath['index.md'].title, 'Garden index');
  assert.equal(byPath['recipes/soup.md'].title, 'Tomato soup');
  assert.equal(byPath['recipes/pasta.md'].title, 'pasta');
  assert.equal(byPath['vault/locked.md'].encrypted, true);
  assert.equal(byPath['recipes/img/plate.png'].kind, 'image');
});

test('file: frontmatter split, body line, encrypted blocks withheld; traversal and unlisted files refused', async (t) => {
  const fx = fixture(t);
  const notes = notesFor(fx);
  const f = await notes.file('recipes/pasta.md');
  assert.deepEqual(f.meta, [['tags', ['food', 'quick']], ['source', 'https://example.com/pasta']]);
  assert.equal(f.body, 'Boil water. Add pasta.\n![plate](img/plate.png)\n');
  assert.equal(f.bodyLine, 7);
  assert.equal(f.abs, path.join(fx.root, 'recipes/pasta.md'));

  const locked = await notes.file('vault/locked.md');
  assert.equal(locked.encrypted, true);
  assert.ok(!locked.text.includes('YWdl'));
  assert.ok(!locked.body.includes('BEGIN AGE'));

  const status = async (p) => notes.file(p).then(() => 200, (e) => e.status);
  assert.equal(await status('../outside/secret.md'), 400);
  assert.equal(await status('/etc/passwd'), 400);
  assert.equal(await status('recipes/../../outside/secret.md'), 400);
  assert.equal(await status('%2e%2e/outside/secret.md'), 404);
  assert.equal(await status('.hidden/secret.md'), 400);
  assert.equal(await status('link-out/secret.md'), 404);
  assert.equal(await status('secret-link.md'), 404);
  assert.equal(await status('build/out.md'), 404);
  assert.equal(await status('drafts/private.md'), 404);
  assert.equal(await status('node_modules/pkg/readme.md'), 404);
  assert.equal(await status('recipes/img/plate.png'), 400);
  assert.equal(await status('missing.md'), 404);
  assert.equal(await status('link-in/soup.md'), 404);
  assert.equal((await notes.file('alias.md')).title, 'Tomato soup');

  const img = await notes.raw('recipes/img/plate.png');
  assert.equal(img.headers['content-type'], 'image/png');
  assert.match(img.headers['content-security-policy'], /sandbox/);
  await new Promise((resolve) => img.stream.on('close', resolve).resume());
  await assert.rejects(notes.raw('index.md'), (e) => e.status === 400);
});

test('builtin search: AND terms, #tags, titles rank first, snippets with ranges, nothing outside/hidden/encrypted', async (t) => {
  const fx = fixture(t);
  const notes = notesFor(fx);
  const r = await notes.search('tomato');
  const paths = r.results.map((x) => x.path);
  assert.equal(r.engine, 'builtin');
  assert.ok(paths.slice(0, 2).includes('recipes/soup.md'));
  assert.ok(paths.includes('data/payload.json'));
  for (const p of paths) assert.ok(!/outside|hidden|build|drafts|node_modules|secret/.test(p), p);
  const soup = r.results.find((x) => x.path === 'recipes/soup.md');
  assert.equal(soup.title, 'Tomato soup');
  assert.equal(soup.matches[0].line, 1);
  const m = soup.matches[1];
  assert.equal(m.text.slice(m.ranges[0][0], m.ranges[0][1]).toLowerCase(), 'tomato');

  assert.deepEqual((await notes.search('tomato basil')).results.map((x) => x.path).sort(), ['alias.md', 'recipes/soup.md']);
  assert.deepEqual((await notes.search('#quick')).results.map((x) => x.path), ['recipes/pasta.md']);
  assert.deepEqual((await notes.search('#garden')).results.map((x) => x.path), ['index.md']);
  assert.deepEqual((await notes.search('YWdl')).results, []);
  assert.deepEqual((await notes.search('   ')).results, []);
  assert.equal((await notes.search('tomato', { limit: 1 })).results.length, 1);
});

test('search command: {query} substituted, cwd = root, output mapped to listed files only; failure falls back', async (t) => {
  const fx = fixture(t);
  const calls = [];
  let reply = async () => ({ stdout: `recipes/soup.md:3:Simmer the tomatoes.\n${fx.outside}/secret.md:1:outside tomato\n.hidden/secret.md:1:x\nindex.md\n  See [[recipes/soup]]\n`, stderr: '' });
  const notes = createNotes({
    config: { root: fx.root, name: 'n', searchCmd: ['grepper', '-n', '{query}', '--'], exclude: [] },
    home: fx.home,
    run: async (bin, args, opts) => (calls.push([bin, args, opts.cwd]), reply()),
  });
  const r = await notes.search('tomato');
  assert.equal(r.engine, 'command');
  assert.deepEqual(calls[0], ['grepper', ['-n', 'tomato', '--'], fx.root]);
  assert.deepEqual(r.results.map((x) => x.path), ['recipes/soup.md', 'index.md']);
  assert.deepEqual(r.results[0].matches[0].ranges, [[11, 17]]);

  const split = createNotes({
    config: { root: fx.root, name: 'n', searchCmd: ['grepper', '{args}'], exclude: [] },
    home: fx.home,
    run: async (bin, args) => (calls.push([bin, args]), { stdout: '', stderr: '' }),
  });
  await split.search('#food  soup');
  assert.deepEqual(calls.at(-1), ['grepper', ['#food', 'soup']]);

  reply = async () => Promise.reject(Object.assign(new Error(''), { code: 1, stdout: '' }));
  assert.deepEqual((await notes.search('nothing')).results, []);

  reply = async () => Promise.reject(Object.assign(new Error('grepper: not found'), { code: 'ENOENT' }));
  const fb = await notes.search('basil');
  assert.equal(fb.engine, 'builtin');
  assert.match(fb.fallback, /grepper: not found/);
  assert.ok(fb.results.some((x) => x.path === 'recipes/soup.md'));
});

test('config: web.notes parsed, off by default, bad shapes rejected', () => {
  const opts = { env: {}, home: '/home/tester' };
  assert.equal(normalizeConfig({}, opts).notes, null);
  const c = normalizeConfig({ web: { notes: { root: '~/notes', searchCmd: '~/bin/search -n {query}', exclude: ['/drafts/'] } } }, opts).notes;
  assert.deepEqual(c, { root: '/home/tester/notes', name: 'notes', searchCmd: ['/home/tester/bin/search', '-n', '{query}'], exclude: ['drafts'] });
  assert.equal(normalizeConfig({ web: { notes: { root: '/n', name: 'Wiki' } } }, opts).notes.name, 'Wiki');
  for (const bad of [{ root: 'rel/dir' }, { root: '' }, { root: '/n', searchCmd: [] }, { root: '/n', searchCmd: [1] }, { root: '/n', exclude: 'x' }, 'x']) {
    assert.throws(() => normalizeConfig({ web: { notes: bad } }, opts), /web\.notes/);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('HTTP: tree / search / file / raw locally and through a peer; 501 when off; settings flag', async (t) => {
  const fx = fixture(t);
  const urls = {};
  const handles = {};
  for (const name of ['laptop', 'workstation']) {
    const server = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(server);
    t.after(() => server.close());
  }
  for (const name of ['laptop', 'workstation']) {
    const config = normalizeConfig(
      { self: name, hosts: { laptop: { web: urls.laptop, ssh: 'laptop' }, workstation: { web: urls.workstation, ssh: 'workstation' } } },
      { env: {}, home: '/home/tester' },
    );
    const overmind = { localHost: async () => ({ name, ok: true, sessions: [] }), invalidate() {} };
    // Only the workstation has notes configured.
    const notes = name === 'workstation' ? notesFor(fx) : null;
    const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, notes, warmOvermind: false });
    t.after(() => api.stop());
    handles[name] = api;
  }
  const get = async (u) => {
    const res = await fetch(u);
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
  const ws = `${urls.laptop}/api/hosts/workstation/notes`;
  const tree = await get(`${ws}/tree`);
  assert.equal(tree.status, 200);
  assert.equal(tree.body.host, 'workstation');
  assert.ok(tree.body.files.some((f) => f.path === 'index.md'));
  // Built by the laptop's server: Remote-SSH with its alias for the workstation.
  assert.equal(tree.body.editorUrl, `vscode://vscode-remote/ssh-remote+workstation${fx.root}`);

  const s = await get(`${ws}/search?q=${encodeURIComponent('tomato basil')}`);
  assert.equal(s.status, 200);
  assert.ok(s.body.results.some((r) => r.path === 'recipes/soup.md'));

  const f = await get(`${ws}/file?path=${encodeURIComponent('recipes/soup.md')}`);
  assert.equal(f.status, 200);
  assert.equal(f.body.title, 'Tomato soup');
  assert.match(f.body.editorUrl, /^vscode:\/\/vscode-remote\/ssh-remote\+workstation\/.+\/recipes\/soup\.md$/);
  const local = await get(`${urls.workstation}/api/hosts/workstation/notes/file?path=index.md`);
  assert.equal(local.body.editorUrl, `vscode://file${fx.root}/index.md`);

  const img = await fetch(`${ws}/raw?path=${encodeURIComponent('recipes/img/plate.png')}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  for (const p of ['../outside/secret.md', '..%2Foutside%2Fsecret.md', 'link-out/secret.md', '.git/config']) {
    const r = await get(`${ws}/file?path=${p}`);
    assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes('outside tomato'));
  }
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/notes/tree`)).status, 501);
  assert.equal((await fetch(`${ws}/tree`, { method: 'POST' })).status, 405);
  assert.equal((await get(`${urls.laptop}/api/hosts/nowhere/notes/tree`)).status, 404);
  assert.deepEqual((await get(`${urls.laptop}/api/settings`)).body.notes, { enabled: false });
  // Each host entry says whether it has notes (the UI's nav + host picker).
  const overmind = (await get(`${urls.laptop}/api/overmind`)).body;
  assert.deepEqual(overmind.hosts.map((h) => [h.name, h.notes ?? null]), [['laptop', null], ['workstation', { name: 'notes' }]]);
  assert.deepEqual((await get(`${urls.workstation}/api/settings`)).body.notes, { enabled: true, name: 'notes' });
});
