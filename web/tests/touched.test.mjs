// Relative chat paths that live outside the cwd: resolved through the files the session touched
// (its transcript), their ancestor dirs and `web.files.roots` — with the $HOME / cwd sandbox intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../lib/config.mjs';
import { createFiles } from '../lib/files.mjs';
import { createTouchedIndex, ingestLine } from '../lib/touched.mjs';

const SESSION = { session_id: 'cccccccc-0000-0000-0000-000000000003' };

/** $HOME with a cwd repo, two other repos sharing a relative path, a secret, and a dir outside home. */
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-touched-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'Code', 'main');
  const other = path.join(home, 'Code', 'other');
  const third = path.join(home, 'Code', 'third');
  const outside = path.join(root, 'outside');
  const transcript = path.join(root, 'claude', 'session.jsonl');
  for (const d of [cwd, path.join(other, 'knowledge', 'notes'), path.join(other, '.git'), path.join(third, 'knowledge', 'notes'), path.join(outside, 'knowledge', 'notes'), path.join(home, '.ssh'), path.dirname(transcript)]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(other, 'knowledge', 'notes', 'x.md'), '# other\n');
  fs.writeFileSync(path.join(other, 'knowledge', 'notes', 'sibling.md'), '# sibling\n');
  fs.writeFileSync(path.join(third, 'knowledge', 'notes', 'x.md'), '# third\n');
  fs.writeFileSync(path.join(outside, 'knowledge', 'notes', 'only-out.md'), '# out\n');
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'secret');
  fs.writeFileSync(transcript, '');
  return { root, home, cwd, other, third, outside, transcript };
}

const toolUse = (name, input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } }) + '\n';
const toolResult = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: text }] } }) + '\n';

function setup(t, { roots = [] } = {}) {
  const fx = fixture(t);
  let locates = 0;
  const touched = createTouchedIndex({ locate: async () => (locates++, fx.transcript) });
  const files = createFiles({ home: fx.home, run: async () => ({}), touched, roots });
  const append = (s) => fs.appendFileSync(fx.transcript, s);
  const statOne = async (p) => (await files.stat([p], fx.cwd, { session: SESSION })).files[0];
  return { fx, files, touched, append, statOne, locates: () => locates };
}

test('ingestLine: tool inputs (incl. MultiEdit edits), result paths, junk ignored', () => {
  const st = { seq: 0, paths: new Map() };
  ingestLine(st, toolUse('Write', { file_path: '/h/a/one.md' }));
  ingestLine(st, toolUse('Grep', { pattern: 'x', path: '/h/a/dir/' }));
  ingestLine(st, toolUse('NotebookEdit', { notebook_path: '/h/a/n.ipynb' }));
  ingestLine(st, toolUse('MultiEdit', { file_path: '/h/a/m.md', edits: [{ old_string: 'a', new_string: 'b' }] }));
  ingestLine(st, toolResult('Found:\n/h/b/two.md\n/h/b/three.md.'));
  ingestLine(st, toolUse('Edit', { file_path: 'relative/ignored.md' }));
  ingestLine(st, '{not json "tool_use"');
  ingestLine(st, JSON.stringify({ type: 'user', message: { content: 'plain /h/not/a/tool.md' } }));
  assert.deepEqual(new Map([...st.paths].map(([p, v]) => [p, v.tier])), new Map([
    ['/h/a/one.md', 2], ['/h/a/dir', 2], ['/h/a/n.ipynb', 2], ['/h/a/m.md', 2], ['/h/b/two.md', 1], ['/h/b/three.md', 1],
  ]));
});

test('shell commands: redirect / tee targets (cd-relative too) are touched, other absolute paths hints', () => {
  const st = { seq: 0, paths: new Map() };
  ingestLine(st, toolUse('Bash', { command: 'cd ~/Code/repo/docs/sub && cat > out-summary.md <<"EOF"\nsee /abs/hint.md\nEOF' }), '/h');
  ingestLine(st, toolUse('Bash', { command: 'make 2>&1 | tee -a /tmp/log.txt; ls > /dev/null; echo 1 >> rel.txt' }), '/h');
  ingestLine(st, toolUse('Bash', { command: 'cd "/p q/r" && printf x > "f g.md"' }), '/h');
  const tiers = Object.fromEntries([...st.paths].map(([p, v]) => [p, v.tier]));
  assert.equal(tiers['/h/Code/repo/docs/sub/out-summary.md'], 2);
  assert.equal(tiers['/abs/hint.md'], 1);
  assert.equal(tiers['/tmp/log.txt'], 2);
  assert.equal(tiers['/p q/r/f g.md'], 2);
  assert.equal(tiers['/dev/null'], undefined);
  assert.ok(!Object.keys(tiers).some((p) => p.endsWith('rel.txt'))); // no cd → unknown dir
});

test('cwd hit stays cwd; cwd miss → touched hit; stat path is absolute so raw/open resolve it', async (t) => {
  const { fx, files, append, statOne } = setup(t);
  fs.writeFileSync(path.join(fx.cwd, 'here.md'), 'here');
  assert.equal((await statOne('here.md')).resolvedVia, 'cwd');
  const target = path.join(fx.other, 'knowledge', 'notes', 'x.md');
  assert.equal((await statOne('knowledge/notes/x.md')).exists, false); // nothing touched yet
  append(toolUse('Write', { file_path: target }));
  const f = await statOne('knowledge/notes/x.md:3');
  assert.equal(f.exists, true);
  assert.equal(f.resolvedVia, 'touched');
  assert.equal(f.path, target);
  assert.equal(f.line, 3);
  assert.equal(f.rel, '~/Code/other/knowledge/notes/x.md');
  // raw / open take the same route, by the relative path as written or the absolute one.
  const r = await files.raw('knowledge/notes/x.md', fx.cwd, { session: SESSION });
  r.stream.destroy();
  assert.equal(r.headers['x-overmind-kind'], 'markdown');
  await assert.rejects(files.raw('knowledge/notes/x.md', fx.cwd), { status: 404 }); // no session → no fallback
  const opened = await files.open('knowledge/notes/x.md', fx.cwd, { session: SESSION });
  assert.equal(opened.path, target);
  // Segment boundary: `notes/x.md` matches, `otes/x.md` does not.
  assert.equal((await statOne('otes/x.md')).exists, false);
});

test('ambiguous → the most recently touched wins; tool inputs beat result mentions', async (t) => {
  const { fx, append, statOne } = setup(t);
  const a = path.join(fx.other, 'knowledge', 'notes', 'x.md');
  const b = path.join(fx.third, 'knowledge', 'notes', 'x.md');
  append(toolUse('Edit', { file_path: a }));
  append(toolUse('Read', { file_path: b }));
  assert.equal((await statOne('knowledge/notes/x.md')).path, b);
  append(toolUse('Edit', { file_path: a }));
  assert.equal((await statOne('notes/x.md')).path, a); // cache key follows the transcript
  append(toolResult(`matches:\n${b}\n`)); // newer, but only seen in output
  assert.equal((await statOne('x.md')).path, a);
});

test('roots: ancestors of touched files, then web.files.roots', async (t) => {
  const cfg = normalizeConfig({ self: 'laptop', web: { files: { roots: ['~/Code/third'] } } }, { env: {}, home: '/home/tester' });
  assert.deepEqual(cfg.files.roots, ['/home/tester/Code/third']);
  assert.deepEqual(normalizeConfig({ self: 'laptop' }, { env: {}, home: '/h' }).files.roots, []);
  assert.throws(() => normalizeConfig({ self: 'laptop', web: { files: { roots: 'x' } } }, { env: {}, home: '/h' }), /array/);
  assert.throws(() => normalizeConfig({ self: 'laptop', web: { files: { roots: ['rel/dir'] } } }, { env: {}, home: '/h' }), /absolute/);

  const { fx, append, statOne } = setup(t);
  append(toolUse('Edit', { file_path: path.join(fx.other, 'knowledge', 'notes', 'x.md') }));
  const sib = await statOne('knowledge/notes/sibling.md'); // never touched, but its repo was
  assert.equal(sib.exists, true);
  assert.equal(sib.resolvedVia, 'root');
  assert.equal(sib.path, path.join(fx.other, 'knowledge', 'notes', 'sibling.md'));
  assert.equal((await statOne('../main/whatever.md')).exists, false); // `..` never falls back

  const { fx: fx2, statOne: stat2 } = setupWithRoots(t);
  fs.writeFileSync(path.join(fx2.third, 'README.md'), '# r');
  const readme = await stat2('README.md');
  assert.equal(readme.resolvedVia, 'root');
  assert.equal(readme.path, path.join(fx2.third, 'README.md'));
});

function setupWithRoots(t) {
  const fx = fixture(t);
  const touched = createTouchedIndex({ locate: async () => fx.transcript });
  const files = createFiles({ home: fx.home, run: async () => ({}), touched, roots: [fx.third, fx.outside] });
  return { fx, statOne: async (p) => (await files.stat([p], fx.cwd, { session: SESSION })).files[0] };
}

test('a Codex row: the files its rollout says it changed or wrote resolve a bare name (no Claude lookup)', async (t) => {
  const fx = fixture(t);
  const rollout = path.join(fx.root, 'codex', 'rollout-x.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  const deep = path.join(fx.other, 'knowledge', 'notes');
  const item = (it) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: it } }) + '\n';
  fs.writeFileSync(
    rollout,
    item({ type: 'FileChange', changes: { [path.join(deep, 'sibling.md')]: { type: 'update' }, [path.join(deep, 'gone.md')]: { type: 'delete' } } }) +
      item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'echo x > made.md'], cwd: `file://${deep}`, aggregated_output: '' }),
  );
  fs.writeFileSync(path.join(deep, 'made.md'), 'x');
  const touched = createTouchedIndex({ locate: async () => assert.fail('a Codex row names its rollout') });
  const files = createFiles({ home: fx.home, run: async () => ({}), touched });
  const session = { ...SESSION, harness: 'codex', transcript: rollout };
  const list = await touched.get(session);
  assert.deepEqual(list.worked, [path.join(deep, 'made.md'), path.join(deep, 'sibling.md')]);
  const stat = async (p) => (await files.stat([p], fx.cwd, { session })).files[0];
  assert.equal((await stat('sibling.md')).resolvedVia, 'touched');
  assert.equal((await stat('made.md')).resolvedVia, 'touched');
});

test('sandbox holds: touched paths / roots outside $HOME are ignored, secrets refused', async (t) => {
  const { fx, append, statOne } = setup(t);
  append(toolUse('Read', { file_path: path.join(fx.outside, 'knowledge', 'notes', 'only-out.md') }));
  append(toolUse('Read', { file_path: path.join(fx.home, '.ssh', 'config') }));
  const out = await statOne('notes/only-out.md');
  assert.equal(out.exists, false);
  assert.equal(out.resolvedVia, undefined);
  assert.equal((await statOne('.ssh/config')).exists, false);
  assert.equal((await statOne('config')).exists, false);

  const { statOne: stat2 } = setupWithRoots(t); // roots include a dir outside $HOME
  assert.equal((await stat2('knowledge/notes/only-out.md')).exists, false);
});

test('index: incremental reads, partial last line waits, reset when the transcript shrinks', async (t) => {
  const { fx, touched, append, locates } = setup(t);
  const a = path.join(fx.other, 'a.md');
  const b = path.join(fx.other, 'b.md');
  append(toolUse('Write', { file_path: a }));
  const v1 = await touched.get(SESSION);
  assert.deepEqual(v1.paths, [a]);
  assert.equal(await touched.get(SESSION), v1); // unchanged → same object, no re-read
  const line = toolUse('Write', { file_path: b });
  append(line.slice(0, 20)); // half a line
  assert.deepEqual((await touched.get(SESSION)).paths, [a]);
  append(line.slice(20));
  assert.deepEqual((await touched.get(SESSION)).paths, [b, a]);
  fs.writeFileSync(fx.transcript, toolUse('Write', { file_path: b }));
  assert.deepEqual((await touched.get(SESSION)).paths, [b]);
  assert.equal(locates(), 1); // the transcript is located once per session
  // First read of a big transcript scans only its tail.
  const small = createTouchedIndex({ locate: async () => fx.transcript, maxBytes: line.length + 10 });
  fs.writeFileSync(fx.transcript, toolUse('Write', { file_path: a }).repeat(3) + toolUse('Write', { file_path: b }));
  assert.deepEqual((await small.get(SESSION)).paths, [b]);
  assert.equal(await createTouchedIndex({ locate: async () => null }).get(SESSION), null);
});
