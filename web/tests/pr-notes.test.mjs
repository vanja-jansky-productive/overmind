// PR review notes (the diff reviewer on a PR without a session): the store, posting a note as a
// GitHub review comment, the handoff prompt, and the …/prs/:owner/:repo/:n/… routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createPrNotes, notesPrompt } from '../lib/pr-notes.mjs';

const PR = { owner: 'acme', repo: 'api', number: 12 };
const HEAD = 'a'.repeat(40);
const anchor = { root: '/w/api', path: 'src/x.ts', side: 'new', start: 3, end: 5, code: ['a', 'b', 'c'] };

function fixture(t, { ghFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-prnotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ghCalls = [];
  let ids = 0;
  const notes = createPrNotes({
    dir,
    gh: async (args) => {
      ghCalls.push(args);
      if (ghFails) throw Object.assign(new Error('x'), { stderr: 'gh: Validation Failed (HTTP 422)\n' });
      return { stdout: JSON.stringify({ html_url: 'https://github.com/acme/api/pull/12#discussion_r1' }) };
    },
    now: () => 1000,
    randomId: () => (++ids).toString(16).padStart(6, '0'),
  });
  return { dir, notes, ghCalls };
}

test('notes: create, edit, resolve, remove — shaped as draft threads, stored per PR', async (t) => {
  const fx = fixture(t);
  const c = await fx.notes.create(PR, { ...anchor, body: ' Why three lines? ' });
  assert.equal(c.thread.status, 'draft');
  assert.equal(c.thread.entries[0].body, 'Why three lines?');
  assert.equal(c.drafts, 1);
  assert.ok(fs.existsSync(path.join(fx.dir, 'acme__api__12.json')));
  assert.equal((await fx.notes.update(PR, c.thread.id, { body: 'Edited' })).thread.entries[0].body, 'Edited');
  assert.equal((await fx.notes.update(PR, c.thread.id, { resolved: true })).thread.resolved, true);
  assert.equal((await fx.notes.list({ ...PR, owner: 'ACME' })).threads.length, 1, 'owner/repo case-insensitive');
  assert.equal((await fx.notes.remove(PR, c.thread.id)).threads.length, 0);
  await assert.rejects(fx.notes.create(PR, { ...anchor, path: '../etc/passwd', body: 'x' }), { status: 400 });
  await assert.rejects(fx.notes.create(PR, { ...anchor, body: ' ' }), { status: 400 });
  await assert.rejects(fx.notes.create({ ...PR, owner: '../x' }, { ...anchor, body: 'x' }), { status: 400 });
  await assert.rejects(fx.notes.remove(PR, 'c-ffffff'), { status: 404 });
});

test('post: a note becomes a GitHub review comment on its lines at the head', async (t) => {
  const fx = fixture(t);
  const c = await fx.notes.create(PR, { ...anchor, body: 'Nit' });
  const r = await fx.notes.post(PR, c.thread.id, { headOid: HEAD });
  assert.deepEqual(fx.ghCalls[0], ['api', '-X', 'POST', 'repos/acme/api/pulls/12/comments', '-f', 'body=Nit', '-f', `commit_id=${HEAD}`, '-f', 'path=src/x.ts', '-F', 'line=5', '-f', 'side=RIGHT', '-F', 'start_line=3', '-f', 'start_side=RIGHT']);
  assert.equal(r.thread.posted.url, 'https://github.com/acme/api/pull/12#discussion_r1');
  assert.equal(r.drafts, 0);
  await assert.rejects(fx.notes.post(PR, c.thread.id, { headOid: HEAD }), { status: 409 }, 'once');
  await assert.rejects(fx.notes.update(PR, c.thread.id, { body: 'x' }), { status: 409 }, 'edit on GitHub');
  // A removed line, one line: LEFT, no start_line.
  const old = await fx.notes.create(PR, { ...anchor, side: 'old', start: 9, end: 9, body: 'Gone?' });
  await fx.notes.post(PR, old.thread.id, { headOid: HEAD });
  assert.deepEqual(fx.ghCalls[1].slice(-4), ['-F', 'line=9', '-f', 'side=LEFT']);
  await assert.rejects(fx.notes.post(PR, old.thread.id, { headOid: 'nope' }), { status: 409 });
});

test('post: GitHub refusing says why and keeps the note local', async (t) => {
  const fx = fixture(t, { ghFails: true });
  const c = await fx.notes.create(PR, { ...anchor, body: 'Nit' });
  await assert.rejects(fx.notes.post(PR, c.thread.id, { headOid: HEAD }), { status: 502, message: /Validation Failed/ });
  assert.equal((await fx.notes.list(PR)).threads[0].posted, null);
});

test('notesPrompt: every note with its file, lines and code, in order', () => {
  const p = notesPrompt(
    [
      { path: 'a.ts', side: 'new', start: 1, end: 2, code: ['x', 'y'], body: 'First' },
      { path: 'b.ts', side: 'old', start: 4, end: 4, code: [], body: 'Second', posted: { url: 'u' } },
    ],
    { summary: 'Overall: fine.' },
  );
  assert.match(p, /review notes/);
  assert.match(p, /Overall: fine\./);
  assert.match(p, /1\. a\.ts:1-2\n```\nx\ny\n```\nFirst/);
  assert.match(p, /2\. b\.ts:4 \(removed lines\) — already posted on GitHub\nSecond/);
});

test('HTTP: …/prs/:owner/:repo/:n — diff from the clone, notes, ask, handoff spawns with the notes', async (t) => {
  const fx = fixture(t);
  const config = normalizeConfig({ self: 'laptop' }, { env: {}, home: '/home/tester' });
  const overmind = { localHost: async () => ({ name: 'laptop', ok: true, sessions: [] }) };
  const pr = { owner: 'acme', repo: 'api', number: 12, title: 'Fix it', url: 'https://github.com/acme/api/pull/12', author: 'petra', headBranch: 'fix', baseBranch: 'main', headOid: HEAD, draft: false, local: { repoPath: '/w/api', worktree: null } };
  const cli = {
    prs: async () => ({ prs: [pr, { ...pr, number: 13, local: null }] }),
    prCheckout: async (ref) => ({ path: '/w/worktrees/fix', contextLine: `PR ${ref}.` }),
  };
  const diffCalls = [];
  const differ = {
    prDiff: async (root, o) => {
      diffCalls.push({ root, ...o });
      return { root, branch: 'fix', head: HEAD, base: { ref: 'main', sha: 'b'.repeat(40) }, tree: HEAD, fingerprint: 'fp', unchanged: o.since === 'fp', files: [], stats: { files: 0, additions: 0, deletions: 0 }, truncated: false };
    },
  };
  const started = [];
  const asks = { start: (o) => (started.push(o), { id: 'q-00000001', status: 'running' }) };
  const spawned = [];
  const spawner = { spawn: async (o) => (spawned.push(o), { tmuxSession: 'fix-review', dir: o.dir, name: o.name }) };
  const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner, cli, differ, asks, prNotes: fx.notes, warmOvermind: false });
  t.after(() => api.stop());
  const server = createHttpServer({ handleApi: api, uiDir: null });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/hosts/laptop/prs/acme/api/12`;
  const call = async (u, method = 'GET', body) => {
    const res = await fetch(u, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  const d = await call(`${base}/diff?refetch=1`);
  assert.equal(d.status, 200);
  assert.equal(d.body.repos[0].label, 'acme/api');
  assert.equal(d.body.pr.title, 'Fix it');
  assert.deepEqual([diffCalls[0].root, diffCalls[0].number, diffCalls[0].baseBranch, diffCalls[0].refetch], ['/w/api', 12, 'main', true]);
  const same = await call(`${base}/diff?since=fp`);
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.repos, undefined);
  assert.equal((await call(`${base.replace(/\/12$/, '/13')}/diff`)).status, 409, 'no clone');
  assert.equal((await call(`${base.replace(/\/12$/, '/99')}/diff`)).status, 404);

  const c = await call(`${base}/notes`, 'POST', { ...anchor, body: 'Hm' });
  assert.equal(c.status, 200);
  const nid = c.body.thread.id;
  assert.equal((await call(`${base}/notes`)).body.threads.length, 1);
  assert.equal((await call(`${base}/notes/${nid}`, 'PUT', { body: 'Hm?' })).body.thread.entries[0].body, 'Hm?');
  assert.equal((await call(`${base}/notes/${nid}/post`, 'POST', { headOid: HEAD })).body.thread.posted.url.includes('discussion'), true);
  assert.equal((await call(`${base}/notes/bad`, 'PUT', {})).status, 400);

  const a = await call(`${base}/ask`, 'POST', { ...anchor, question: 'Why?', head: HEAD, base: 'b'.repeat(40) });
  assert.equal(a.status, 200);
  assert.equal(started[0].cwd, '/w/api');
  assert.equal(started[0].resume, null);
  assert.ok(started[0].tools.includes('Bash(git show:*)'));
  assert.match(started[0].prompt, new RegExp(`git show ${HEAD}:<path>`));
  assert.match(started[0].prompt, /About src\/x\.ts:3-5:/);
  assert.doesNotMatch(started[0].prompt, /do not run commands/);

  // Handoff: the unresolved notes as the session's first prompt, on the PR's worktree.
  await call(`${base}/notes`, 'POST', { ...anchor, start: 8, end: 8, body: 'Second note' });
  const h = await call(`${base}/notes/handoff`, 'POST', { summary: 'Mostly good.' });
  assert.equal(h.status, 200);
  assert.equal(spawned[0].dir, '/w/worktrees/fix');
  assert.match(spawned[0].prompt, /^PR acme\/api#12\. My review notes/);
  assert.match(spawned[0].prompt, /Mostly good\./);
  assert.match(spawned[0].prompt, /Second note/);
  assert.equal((await call(`${base}/diff`, 'POST', {})).status, 405);
});
