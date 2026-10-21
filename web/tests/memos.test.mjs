// Voice memos: segments stored then transcribed, finish → titled markdown, retry, rename, delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { cleanTitle, createMemos, memoPrompt, parseMemo, setMetaLine, slugify } from '../lib/memos.mjs';

function audioReq(body, type = 'audio/webm;codecs=opus') {
  const req = Readable.from([Buffer.from(body)]);
  req.headers = { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) };
  return req;
}

function setup({ fail = new Set(), title = 'Kickoff s Markom o API-ju' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-memos-'));
  const calls = { transcribe: [], ask: 0 };
  const transcriber = {
    async transcribeAudio(audio, type, prompt) {
      calls.transcribe.push({ audio: audio.toString(), type, prompt });
      if (fail.has(audio.toString())) throw new Error('OpenAI down');
      return { text: `text of ${audio.toString()}` };
    },
  };
  const ask = async () => {
    calls.ask++;
    return `"${title}"\n`;
  };
  const memos = createMemos({ dir: path.join(root, 'memos'), audioDir: path.join(root, 'audio'), transcriber, ask });
  return { root, memos, calls, fail };
}

const REC = 'rec-20261015-abcd';
const START = new Date(2026, 9, 15, 14, 32).getTime();

test('slugify, cleanTitle, parseMemo', () => {
  assert.equal(slugify('Kickoff s Đurom: API v2, čšž!'), 'kickoff-s-durom-api-v2-csz');
  assert.equal(cleanTitle('Title: "Plan za Q4."\nmore'), 'Plan za Q4');
  assert.equal(cleanTitle('  \n'), '');
  const { meta, body } = parseMemo('---\ntitle: "a: b \\"c\\""\nstatus: done\n---\n\nhello\n');
  assert.deepEqual(meta, { title: 'a: b "c"', status: 'done' });
  assert.equal(body.trim(), 'hello');
  assert.match(setMetaLine('---\ntitle: "x"\n---\nbody', 'title', '"y"'), /^---\ntitle: "y"\n---\nbody$/);
});

test('segments are stored, transcribed with the previous tail as context, finished into a titled memo', async () => {
  const { memos, calls } = setup();
  const r0 = await memos.putSegment(REC, 0, audioReq('seg0'));
  assert.deepEqual(r0, { stored: true, transcribed: true, chars: 'text of seg0'.length });
  await memos.putSegment(REC, 1, audioReq('seg1', 'audio/mp4'));
  assert.match(calls.transcribe[1].prompt, /text of seg0$/);
  assert.equal(calls.transcribe[1].type, 'audio/mp4');

  const memo = await memos.finish(REC, { segments: 2, startedAt: START, durationMs: 125_000 });
  assert.equal(memo.id, '2026-10-15-kickoff-s-markom-o-api-ju');
  assert.equal(memo.title, 'Kickoff s Markom o API-ju');
  assert.equal(memo.durationSec, 125);
  assert.equal(memo.status, 'done');
  assert.equal(memo.transcript, 'text of seg0\n\ntext of seg1');
  const file = fs.readFileSync(memo.path, 'utf8');
  assert.match(file, /^---\ntitle: "Kickoff s Markom o API-ju"\ncreated: 2026-10-15T14:32:00[+-]\d\d:\d\d\nduration: "2:05"\nrecording: rec-20261015-abcd\nstatus: done\n---\n/);

  // Finishing again (a retried request) updates the same file, no second title call.
  const again = await memos.finish(REC, { segments: 2, startedAt: START, durationMs: 125_000 });
  assert.equal(again.id, memo.id);
  assert.equal(calls.ask, 1);
  assert.equal((await memos.list()).memos.length, 1);
});

test('a failed segment keeps its audio; the memo is partial until a retry transcribes it', async () => {
  const { memos, fail } = setup();
  fail.add('seg1');
  await memos.putSegment(REC, 0, audioReq('seg0'));
  const r1 = await memos.putSegment(REC, 1, audioReq('seg1'));
  assert.equal(r1.stored, true);
  assert.equal(r1.transcribed, false);
  const memo = await memos.finish(REC, { segments: 2, startedAt: START, durationMs: 1000 });
  assert.equal(memo.status, 'partial');
  assert.match(memo.transcript, /Segment 2 of 2 is not transcribed yet: OpenAI down/);
  assert.doesNotMatch(memo.preview, /⚠/);

  fail.clear();
  const fixed = await memos.retry(memo.id);
  assert.equal(fixed.id, memo.id);
  assert.equal(fixed.status, 'done');
  assert.equal(fixed.transcript, 'text of seg0\n\ntext of seg1');
});

test('finish refuses a recording with a segment missing', async () => {
  const { memos } = setup();
  await memos.putSegment(REC, 1, audioReq('seg1'));
  await assert.rejects(memos.finish(REC, { segments: 2 }), (err) => err.status === 409);
  await assert.rejects(async () => memos.finish('../etc', { segments: 1 }), (err) => err.status === 400);
  await assert.rejects(memos.putSegment(REC, 0, audioReq('x', 'application/json')), (err) => err.status === 415);
});

test('rename keeps the body, delete removes the memo and its audio; foreign notes are not listed', async () => {
  const { root, memos } = setup();
  await memos.putSegment(REC, 0, audioReq('seg0'));
  const memo = await memos.finish(REC, { segments: 1, startedAt: START, durationMs: 1000 });
  fs.appendFileSync(memo.path, '\n## My notes\nkeep me\n');
  const renamed = await memos.rename(memo.id, '  New: "title"  ');
  assert.equal(renamed.title, 'New: "title"');
  assert.match(renamed.transcript, /keep me/);
  fs.writeFileSync(path.join(root, 'memos', 'other.md'), '# not a memo\n');
  assert.deepEqual((await memos.list()).memos.map((m) => m.id), [memo.id]);
  await memos.remove(memo.id);
  assert.equal(fs.existsSync(memo.path), false);
  assert.equal(fs.existsSync(path.join(root, 'audio', REC)), false);
  await assert.rejects(memos.get(memo.id), (err) => err.status === 404);
});

test('no title model (or no speech) → a date title', async () => {
  const { memos } = setup({ title: '' });
  await memos.putSegment(REC, 0, audioReq('seg0'));
  const memo = await memos.finish(REC, { segments: 1, startedAt: START, durationMs: 1000 });
  assert.equal(memo.title, 'Memo 2026-10-15 14:32');
  assert.equal(memo.id, '2026-10-15-memo-14-32');
});

test('the vocabulary steers every segment\'s transcription', async () => {
  assert.match(memoPrompt(['Claude', ' beads ', '']), /Pojmovi: Claude, beads\.$/);
  assert.ok(memoPrompt(Array(500).fill('term')).length < 1700, 'capped');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-memos-'));
  const prompts = [];
  const transcriber = { transcribeAudio: async (a, t, prompt) => (prompts.push(prompt), { text: 'x' }) };
  const memos = createMemos({ dir: path.join(root, 'm'), audioDir: path.join(root, 'a'), transcriber, vocabulary: ['Productive'] });
  await memos.putSegment(REC, 0, audioReq('seg0'));
  assert.match(prompts[0], /Pojmovi: Productive\./);
});
