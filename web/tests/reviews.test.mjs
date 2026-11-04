// Diff reviewer threads: prompts with markers, single comments sent at once, drafts sent as one
// review, replies read back from the transcript (and kept once it scrolls on), and the routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { commentPrompt, createReviews, reviewPrompt, turnsByThread } from '../lib/reviews.mjs';

const SID = 'aaaaaaaa-0000-0000-0000-000000000001';
const session = { session_id: SID, cwd: '/tmp/x', status: 'idle', backend: 'tmux' };

function fixture(t, { start = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-reviews-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const transcript = [];
  let clock = start;
  let ids = 0;
  const reviews = createReviews({
    dir,
    send: async (_s, text) => void sent.push(text),
    messages: async () => transcript,
    now: () => clock,
    randomId: () => (++ids).toString(16).padStart(6, '0'),
  });
  return { dir, sent, transcript, reviews, tick: (ms) => (clock += ms), at: () => clock };
}

const anchor = { path: 'src/a.ts', side: 'new', start: 10, end: 11, code: ['const a = 1', 'const b = 2'] };

test('commentPrompt / reviewPrompt: marker, range, fenced code (a fence the code cannot close)', () => {
  const t = { id: 'c-000001', ...anchor, code: ['x = "```"'], entries: [{ body: 'Why?' }] };
  const p = commentPrompt(t, ' Why? ')
  assert.match(p, /^\[review c-000001\] Review comment on src\/a\.ts:10-11:\n````ts\nx = "```"\n````\n\nWhy\?$/);
  const r = reviewPrompt([t, { ...t, id: 'c-000002', side: 'old', start: 3, end: 3 }], 'Overall fine.');
  assert.match(r, /2 comments/);
  assert.match(r, /Overall fine\./);
  assert.match(r, /## 1\. \[review c-000001\] src\/a\.ts:10-11/);
  assert.match(r, /## 2\. \[review c-000002\] src\/a\.ts:3 \(removed lines\)/);
});

test('turnsByThread: answers up to the next prompt; a batched prompt answers every marker in it', () => {
  const msgs = [
    { role: 'user', kind: 'user', text: 'hello', ts: 1 },
    { role: 'user', kind: 'user', text: '[review c-000001] Review comment on x', ts: 2 },
    { role: 'assistant', kind: 'assistant', text: 'Looking', ts: 3, final: false },
    { role: 'assistant', kind: 'assistant', text: 'Fixed it', ts: 4, final: true },
    { role: 'user', kind: 'user', text: 'review:\n[review c-000001] a\n[review c-000002] b', ts: 5 },
    { role: 'assistant', kind: 'assistant', text: 'On it', ts: 6, final: false },
    { role: 'user', kind: 'user', text: '[review c-000003] queued', ts: 7, queued: true },
  ];
  const m = turnsByThread(msgs);
  assert.equal(m.get('c-000001').length, 2);
  assert.deepEqual(m.get('c-000001')[0].replies.map((r) => r.text), ['Looking', 'Fixed it']);
  assert.equal(m.get('c-000001')[0].done, true);
  assert.equal(m.get('c-000002')[0].done, false, 'still working');
  assert.deepEqual(m.get('c-000003')[0], { ts: 7, queued: true, replies: [], done: false });
});

test('a single comment is sent at once; its answer comes from the transcript and stays after it scrolls out', async (t) => {
  const fx = fixture(t);
  const r = await fx.reviews.create(session, { ...anchor, body: 'Rename this?' });
  assert.equal(r.thread.status, 'sent');
  assert.equal(fx.sent.length, 1);
  assert.match(fx.sent[0], /^\[review c-000001\]/);

  let list = await fx.reviews.list(session);
  assert.equal(list.threads[0].entries[0].state, 'sent', 'not in the transcript yet');

  fx.transcript.push({ role: 'user', kind: 'user', text: fx.sent[0], ts: fx.at() + 500 });
  list = await fx.reviews.list(session);
  assert.equal(list.threads[0].entries[0].state, 'working');
  fx.transcript.push({ role: 'assistant', kind: 'assistant', text: 'Renamed to `count`.', ts: fx.at() + 900, final: true });
  list = await fx.reviews.list(session);
  assert.equal(list.threads[0].entries[0].state, 'done');
  assert.deepEqual(list.threads[0].entries[0].replies.map((x) => x.text), ['Renamed to `count`.']);

  // A follow-up in the thread: its own turn.
  fx.tick(10_000);
  await fx.reviews.reply(session, 'c-000001', { body: 'Also the other one' });
  assert.match(fx.sent[1], /^\[review c-000001\] Re: src\/a\.ts:10-11\n\nAlso the other one$/);
  fx.transcript.push({ role: 'user', kind: 'user', text: fx.sent[1], ts: fx.at() + 100 }, { role: 'assistant', kind: 'assistant', text: 'Done too.', ts: fx.at() + 200, final: true });
  list = await fx.reviews.list(session);
  assert.deepEqual(list.threads[0].entries.map((e) => [e.state, e.replies.map((x) => x.text)]), [
    ['done', ['Renamed to `count`.']],
    ['done', ['Done too.']],
  ]);

  // The transcript window moves on: the stored answers stay.
  fx.transcript.splice(0, fx.transcript.length, { role: 'user', kind: 'user', text: 'something else', ts: fx.at() + 9000 });
  list = await fx.reviews.list(session);
  assert.deepEqual(list.threads[0].entries.map((e) => e.replies.map((x) => x.text)), [['Renamed to `count`.'], ['Done too.']]);
  // …and on disk.
  const disk = JSON.parse(fs.readFileSync(path.join(fx.dir, `${SID}.json`), 'utf8'));
  assert.equal(disk.threads[0].entries[1].replies[0].text, 'Done too.');
});

test('drafts wait for submit, which sends them in one prompt; every thread gets the answer', async (t) => {
  const fx = fixture(t);
  await fx.reviews.create(session, { ...anchor, body: 'First', draft: true });
  const second = await fx.reviews.create(session, { ...anchor, start: 20, end: 20, code: ['x'], body: 'Second', draft: true });
  assert.equal(second.drafts, 2);
  assert.equal(fx.sent.length, 0);
  await assert.rejects(fx.reviews.reply(session, 'c-000001', { body: 'x' }), { status: 409 });
  await fx.reviews.update(session, 'c-000001', { body: 'First, edited' });

  const s = await fx.reviews.submit(session, { body: 'Nice work overall.' });
  assert.equal(s.drafts, 0);
  assert.equal(fx.sent.length, 1);
  assert.match(fx.sent[0], /\[review c-000001\][^\n]*\n````?ts[\s\S]*First, edited/);
  assert.match(fx.sent[0], /\[review c-000002\]/);
  assert.equal(s.review.threads.length, 2);
  await assert.rejects(fx.reviews.submit(session, {}), { status: 409 });
  await assert.rejects(fx.reviews.update(session, 'c-000001', { body: 'late edit' }), { status: 409 });

  fx.transcript.push({ role: 'user', kind: 'user', text: fx.sent[0], ts: fx.at() + 10 }, { role: 'assistant', kind: 'assistant', text: 'Both fixed.', ts: fx.at() + 20, final: true });
  const list = await fx.reviews.list(session);
  assert.deepEqual(list.threads.map((x) => x.entries[0].replies[0]?.text), ['Both fixed.', 'Both fixed.']);

  await fx.reviews.update(session, 'c-000002', { resolved: true });
  const after = await fx.reviews.remove(session, 'c-000001');
  assert.deepEqual(after.threads.map((x) => [x.id, x.resolved]), [['c-000002', true]]);
});

test('validation: bad anchors and bodies are 400s, unknown threads 404', async (t) => {
  const fx = fixture(t);
  await assert.rejects(fx.reviews.create(session, { ...anchor, body: '  ' }), { status: 400 });
  await assert.rejects(fx.reviews.create(session, { ...anchor, path: '/etc/passwd', body: 'x' }), { status: 400 });
  await assert.rejects(fx.reviews.create(session, { ...anchor, start: 5, end: 2, body: 'x' }), { status: 400 });
  await assert.rejects(fx.reviews.create(session, { ...anchor, side: 'both', body: 'x' }), { status: 400 });
  await assert.rejects(fx.reviews.reply(session, 'c-ffffff', { body: 'x' }), { status: 404 });
  assert.equal(fx.sent.length, 0);
});

test('HTTP: …/review routes locally (methods, ids) and 501 without reviews', async (t) => {
  const fx = fixture(t);
  const config = normalizeConfig({ self: 'laptop' }, { env: {}, home: '/home/tester' });
  const overmind = { localHost: async () => ({ name: 'laptop', ok: true, sessions: [session] }) };
  const urls = {};
  for (const [k, reviews] of [['on', fx.reviews], ['off', null]]) {
    const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, reviews, warmOvermind: false });
    t.after(() => api.stop());
    const server = createHttpServer({ handleApi: api, uiDir: null });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    urls[k] = `http://127.0.0.1:${server.address().port}/api/hosts/laptop/sessions/aaaaaaaa/review`;
    t.after(() => server.close());
  }
  const call = async (u, method = 'GET', body) => {
    const res = await fetch(u, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const created = await call(`${urls.on}/threads`, 'POST', { ...anchor, body: 'Draft', draft: true });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, SID);
  const tid = created.body.thread.id;
  assert.equal((await call(urls.on)).body.drafts, 1);
  assert.equal((await call(`${urls.on}/threads/${tid}`, 'PUT', { body: 'Edited' })).body.thread.entries[0].body, 'Edited');
  assert.equal((await call(`${urls.on}/submit`, 'POST', {})).status, 200);
  assert.equal(fx.sent.length, 1);
  assert.equal((await call(`${urls.on}/threads/${tid}/reply`, 'POST', { body: 'More' })).status, 200);
  assert.equal((await call(`${urls.on}/threads/${tid}`, 'DELETE')).body.threads.length, 0);
  assert.equal((await call(`${urls.on}/threads/nope`, 'PUT', {})).status, 400);
  assert.equal((await call(`${urls.on}/threads`, 'GET')).status, 405);
  assert.equal((await call(urls.on, 'POST', {})).status, 405);
  assert.equal((await call(urls.off)).status, 501);
});

test('a thread in another checkout names its file from the session cwd (or absolutely)', async (t) => {
  const fx = fixture(t);
  const meta = { ...session, cwd: '/w/meta' };
  const r = await fx.reviews.create(meta, { ...anchor, root: '/w/meta/worktrees/api-fix', body: 'Hm?' });
  assert.equal(r.thread.display, 'worktrees/api-fix/src/a.ts');
  assert.match(fx.sent[0], /Review comment on worktrees\/api-fix\/src\/a\.ts:10-11:/);
  const outside = await fx.reviews.create(meta, { ...anchor, root: '/elsewhere/repo', body: 'Hm?', draft: true });
  assert.equal(outside.thread.display, '/elsewhere/repo/src/a.ts');
  await assert.rejects(fx.reviews.create(meta, { ...anchor, root: 'relative/x', body: 'x' }), { status: 400 });
  await assert.rejects(fx.reviews.create(meta, { ...anchor, root: '/a/../b', body: 'x' }), { status: 400 });
});
