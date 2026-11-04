// Side questions: the prompt, the stream-json reader, an ask's life (fork args, streamed text,
// the final answer, errors, cancel, the running cap) and the routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { askPrompt, createAsks, readStreamLine } from '../lib/asks.mjs';

const SID = 'aaaaaaaa-0000-0000-0000-000000000001';

/** A fake child process: emit stream-json lines, then close. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { written: '', on() {}, end(s) { this.written = s; } };
  child.killed = null;
  child.kill = (sig) => { child.killed = sig; };
  child.line = (obj) => child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  return child;
}

function fixture() {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = fakeChild();
    calls.push({ bin, args, opts, child });
    return child;
  };
  let clock = 1_000_000;
  const asks = createAsks({ bin: 'claude', spawn, now: () => clock, ttlMs: 1000, maxRunning: 2 });
  return { asks, calls, tick: (ms) => (clock += ms) };
}

const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

test('askPrompt: the selection fenced, the question, the side-question rule', () => {
  const p = askPrompt({ question: ' Why BigInt? ', display: 'src/x.ts', path: 'src/x.ts', side: 'new', start: 3, end: 4, code: ['const a = 1n', 'const b = 2n'] });
  assert.match(p, /side question/i);
  assert.match(p, /About src\/x\.ts:3-4:/);
  assert.match(p, /```ts\nconst a = 1n\nconst b = 2n\n```/);
  assert.match(p, /Question: Why BigInt\?$/);
  assert.throws(() => askPrompt({ question: '  ' }), { status: 400 });
  assert.throws(() => askPrompt({ question: 'x'.repeat(5000) }), { status: 400 });
  // No selection: just the question; context goes before it.
  const q = askPrompt({ question: 'What is this PR for?', context: 'PR acme/api#1: Fix rounding' });
  assert.doesNotMatch(q, /About/);
  assert.match(q, /PR acme\/api#1/);
});

test('readStreamLine: text deltas, tool use, the result, errors, junk', () => {
  assert.deepEqual(readStreamLine(JSON.stringify(delta('hi'))), { text: 'hi' });
  assert.deepEqual(readStreamLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } })), { newMessage: true });
  assert.deepEqual(readStreamLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } })), { activity: 'Read' });
  assert.deepEqual(readStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 })), { costUsd: 0.01, result: 'done' });
  assert.equal(readStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })).error, 'claude stopped (error_max_turns)');
  assert.equal(readStreamLine('not json'), null);
  assert.equal(readStreamLine(JSON.stringify({ type: 'system', subtype: 'init' })), null);
});

test('an ask forks the session read-only, streams text, ends with the final answer', () => {
  const fx = fixture();
  const a = fx.asks.start({ cwd: '/w/app', resume: SID, prompt: 'P', question: 'Q?', label: 'x.ts:3' });
  assert.equal(a.status, 'running');
  const { args, opts, child } = fx.calls[0];
  assert.equal(opts.cwd, '/w/app');
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 3), ['--resume', SID, '--fork-session']);
  for (const flag of ['-p', '--no-session-persistence', '--include-partial-messages']) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 4), ['Read', 'Grep', 'Glob']);
  assert.equal(child.stdin.written, 'P');

  child.line({ type: 'stream_event', event: { type: 'message_start' } });
  child.line(delta('Let me look'));
  child.line({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } });
  assert.equal(fx.asks.get(a.id).activity, 'Read');
  child.line({ type: 'stream_event', event: { type: 'message_start' } });
  child.line(delta('Because '));
  // A line split across chunks.
  child.stdout.emit('data', JSON.stringify(delta('cents.')).slice(0, 20));
  child.stdout.emit('data', `${JSON.stringify(delta('cents.')).slice(20)}\n`);
  assert.equal(fx.asks.get(a.id).text, 'Let me look\n\nBecause cents.');
  child.line({ type: 'result', subtype: 'success', result: 'Because cents.', total_cost_usd: 0.02 });
  const done = fx.asks.get(a.id);
  assert.equal(done.status, 'done');
  assert.equal(done.text, 'Because cents.');
  assert.equal(done.costUsd, 0.02);
  assert.equal(done.forked, true);
  child.emit('close', 0);
  assert.equal(fx.asks.get(a.id).status, 'done');
  // Forgotten after the TTL.
  fx.tick(5000);
  assert.throws(() => fx.asks.get(a.id), { status: 404 });
});

test('without a session it runs fresh; failures, cancel and the running cap', () => {
  const fx = fixture();
  const fresh = fx.asks.start({ cwd: '/w/repo', prompt: 'P', question: 'Q' });
  assert.ok(!fx.calls[0].args.includes('--resume'));
  assert.equal(fresh.forked, false);
  const b = fx.asks.start({ cwd: '/w/repo', prompt: 'P', question: 'Q' });
  assert.throws(() => fx.asks.start({ cwd: '/w/repo', prompt: 'P', question: 'Q' }), { status: 429 });
  // Exit without a result: the stderr's last line.
  fx.calls[0].child.stderr.emit('data', 'boom\nNo conversation found\n');
  fx.calls[0].child.emit('close', 1);
  const failed = fx.asks.get(fresh.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'No conversation found');
  // Cancel kills it and forgets it.
  assert.deepEqual(fx.asks.cancel(b.id), { id: b.id, cancelled: true });
  assert.equal(fx.calls[1].child.killed, 'SIGTERM');
  assert.throws(() => fx.asks.get(b.id), { status: 404 });
  assert.throws(() => fx.asks.start({ cwd: '', prompt: 'P', question: 'Q' }), { status: 409 });
  assert.throws(() => fx.asks.start({ cwd: '/w', resume: 'bad id!', prompt: 'P', question: 'Q' }), { status: 400 });
});

test('HTTP: …/ask starts a fork in the session cwd, /asks/:id polls and cancels, 501 without asks', async (t) => {
  const fx = fixture();
  const config = normalizeConfig({ self: 'laptop' }, { env: {}, home: '/home/tester' });
  const session = { session_id: SID, cwd: '/w/meta', status: 'idle', backend: 'tmux' };
  const overmind = { localHost: async () => ({ name: 'laptop', ok: true, sessions: [session] }) };
  const base = {};
  for (const [k, asks] of [['on', fx.asks], ['off', null]]) {
    const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, asks, warmOvermind: false });
    t.after(() => api.stop());
    const server = createHttpServer({ handleApi: api, uiDir: null });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    base[k] = `http://127.0.0.1:${server.address().port}/api/hosts/laptop`;
    t.after(() => server.close());
  }
  const call = async (u, method = 'GET', body) => {
    const res = await fetch(u, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const anchor = { root: '/w/meta/worktrees/api', path: 'src/x.ts', side: 'new', start: 2, end: 3, code: ['a', 'b'], question: 'Why?' };
  const r = await call(`${base.on}/sessions/aaaaaaaa/ask`, 'POST', anchor);
  assert.equal(r.status, 200);
  assert.equal(r.body.ask.status, 'running');
  assert.equal(r.body.ask.label, 'src/x.ts:2–3');
  assert.equal(fx.calls[0].opts.cwd, '/w/meta');
  // The file is named from the session cwd.
  assert.match(fx.calls[0].child.stdin.written, /About worktrees\/api\/src\/x\.ts:2-3:/);
  fx.calls[0].child.line({ type: 'result', subtype: 'success', result: 'Because.' });
  const polled = await call(`${base.on}/asks/${r.body.ask.id}`);
  assert.equal(polled.body.ask.text, 'Because.');
  assert.equal((await call(`${base.on}/asks/${r.body.ask.id}`, 'DELETE')).body.cancelled, true);
  assert.equal((await call(`${base.on}/asks/nope`)).status, 400);
  assert.equal((await call(`${base.on}/sessions/aaaaaaaa/ask`, 'POST', { ...anchor, question: ' ' })).status, 400);
  assert.equal((await call(`${base.on}/sessions/aaaaaaaa/ask`)).status, 405);
  assert.equal((await call(`${base.off}/sessions/aaaaaaaa/ask`, 'POST', anchor)).status, 501);
});
