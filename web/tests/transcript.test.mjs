import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUserText, createTranscriptReader, encodeCwd, transcriptPath, parseCodexTranscript, parsePiTranscript, parseTranscript } from '../lib/transcript.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const line = (obj) => JSON.stringify(obj);
const user = (content, extra = {}) => line({ type: 'user', timestamp: '2026-09-18T18:01:52.017Z', message: { role: 'user', content }, ...extra });
const asst = (content, { id = 'msg_1', stop = 'end_turn' } = {}) =>
  line({ type: 'assistant', timestamp: '2026-09-18T18:01:57.000Z', message: { id, role: 'assistant', content, stop_reason: stop } });

test('encodeCwd mirrors the overmind CLI (slashes and dots become dashes)', () => {
  assert.equal(encodeCwd('/home/user/Code/project'), '-home-user-Code-project');
  assert.equal(encodeCwd('/tmp/a.b/c'), '-tmp-a-b-c');
});

test('parseTranscript keeps user prompts and assistant text, drops tools/thinking/meta', () => {
  const jsonl = [
    user('Hello there'),
    asst([{ type: 'thinking', thinking: 'hmm' }], { stop: 'tool_use' }),
    asst([{ type: 'text', text: 'Working on it.' }], { stop: 'tool_use' }),
    asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], { stop: 'tool_use' }),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }]),
    asst([{ type: 'text', text: 'Done.' }], { id: 'msg_2' }),
    user('meta stuff', { isMeta: true }),
    line({ type: 'attachment', attachment: {} }),
    line({ type: 'system', subtype: 'hook' }),
    'not json',
  ].join('\n');
  const out = parseTranscript(jsonl);
  assert.deepEqual(
    out.map((m) => [m.role, m.text, m.final ?? null]),
    [
      ['user', 'Hello there', null],
      ['assistant', 'Working on it.', false],
      ['assistant', 'Done.', true],
    ],
  );
  assert.equal(typeof out[0].ts, 'number');
});

test('parseTranscript glues streamed blocks of one API message and skips sidechains', () => {
  const jsonl = [
    user('q'),
    asst([{ type: 'text', text: 'part one' }], { id: 'same', stop: 'tool_use' }),
    asst([{ type: 'text', text: 'part two' }], { id: 'same', stop: 'end_turn' }),
    line({ type: 'assistant', isSidechain: true, message: { id: 'side', role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
  ].join('\n');
  const out = parseTranscript(jsonl);
  assert.equal(out.length, 2);
  assert.equal(out[1].text, 'part one\n\npart two');
  assert.equal(out[1].final, true);
});

test('parseTranscript shows a compaction once: no summary, one /compact', () => {
  const jsonl = [
    user('Hello there'),
    asst([{ type: 'text', text: 'Done.' }]),
    user('/compact'),
    line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
    user('This session is being continued from a previous conversation.', { isCompactSummary: true }),
    user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
    user('Next'),
  ].join('\n');
  assert.deepEqual(
    parseTranscript(jsonl).map((m) => [m.role, m.kind, m.text]),
    [
      ['user', 'user', 'Hello there'],
      ['assistant', 'assistant', 'Done.'],
      ['system', 'command', '/compact'],
      ['user', 'user', 'Next'],
    ],
  );
});

test('classifyUserText handles commands, task notifications, local-command noise and reminders', () => {
  assert.deepEqual(classifyUserText('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'), { kind: 'command', text: '/model opus', name: '/model', args: 'opus' });
  assert.deepEqual(classifyUserText('<command-message>p-dev:overview</command-message>\n<command-name>/p-dev:overview</command-name>\n<command-args>onboard me https://example.com/pull/1</command-args>'), {
    kind: 'command',
    text: '/p-dev:overview onboard me https://example.com/pull/1',
    name: '/p-dev:overview',
    args: 'onboard me https://example.com/pull/1',
  });
  assert.deepEqual(classifyUserText('<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'), { kind: 'command', text: '/clear', name: '/clear' });
  assert.deepEqual(classifyUserText('<bash-input> git status</bash-input>'), { kind: 'command', text: '! git status', name: '!', args: 'git status' });
  assert.equal(classifyUserText('<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'), null);
  assert.deepEqual(classifyUserText('<task-notification>\n<task-id>x</task-id>\n<summary>Agent "Build" finished</summary>\n</task-notification>'), { kind: 'system', text: 'Agent "Build" finished' });
  assert.equal(classifyUserText('<local-command-caveat>Caveat: ...</local-command-caveat>'), null);
  assert.equal(classifyUserText('<local-command-stdout>ok</local-command-stdout>'), null);
  assert.equal(classifyUserText('<system-reminder>ignore me</system-reminder>'), null);
  assert.deepEqual(classifyUserText('<system-reminder>ctx</system-reminder>\nReal question?'), { kind: 'user', text: 'Real question?' });
});

test('parseTranscript turns AskUserQuestion into a question message with its outcome', () => {
  const input = { questions: [{ question: 'Merge it?', header: 'Merge', multiSelect: false, options: [{ label: 'Yes', description: 'squash' }, { label: 'No' }] }] };
  const jsonl = [
    asst([{ type: 'text', text: 'Before I go on:' }], { id: 'msg_q', stop: 'tool_use' }),
    asst([{ type: 'tool_use', id: 'tq1', name: 'AskUserQuestion', input }], { id: 'msg_q', stop: 'tool_use' }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tq1', content: 'answered' }] }, toolUseResult: { questions: input.questions, answers: { 'Merge it?': 'Yes' } } }),
    asst([{ type: 'tool_use', id: 'tq2', name: 'AskUserQuestion', input }], { id: 'msg_r', stop: 'tool_use' }),
    user([{ type: 'tool_result', tool_use_id: 'tq2', content: 'rejected', is_error: true }]),
    asst([{ type: 'tool_use', id: 'tq3', name: 'AskUserQuestion', input }], { id: 'msg_s', stop: 'tool_use' }),
  ].join('\n');
  const out = parseTranscript(jsonl);
  assert.deepEqual(
    out.map((m) => [m.kind, m.id ?? null]),
    [['assistant', null], ['question', 'tq1'], ['question', 'tq2'], ['question', 'tq3']],
  );
  assert.deepEqual(out[1].answers, ['Yes']);
  assert.equal(out[1].questions[0].options[0].description, 'squash');
  assert.match(out[1].text, /\*\*Merge: Merge it\?\*\*\n- Yes\n- No/);
  assert.equal(out[2].declined, true);
  assert.equal(out[3].answers, undefined, 'still pending');
  assert.equal(out[3].declined, undefined);
});

test('parseCodexTranscript: prompts and replies, Codex context dropped, narration before a tool call not final', () => {
  const j = (o) => JSON.stringify(o);
  const msg = (role, type, text) => j({ timestamp: '2026-10-11T19:50:53.000Z', type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } });
  const text = [
    j({ type: 'session_meta', payload: { id: 'c1', cwd: '/w' } }),
    msg('developer', 'input_text', 'You are Codex'),
    msg('user', 'input_text', '# AGENTS.md instructions for /w'),
    msg('user', 'input_text', '<environment_context>x</environment_context>'),
    msg('user', 'input_text', 'fix the bug'),
    msg('assistant', 'output_text', 'Looking at it.'),
    j({ type: 'response_item', payload: { type: 'function_call', name: 'exec' } }),
    msg('assistant', 'output_text', 'Fixed.'),
    j({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');
  const m = parseCodexTranscript(text);
  assert.deepEqual(
    m.map((x) => [x.role, x.text, x.final]),
    [
      ['user', 'fix the bug', undefined],
      ['assistant', 'Looking at it.', false],
      ['assistant', 'Fixed.', true],
    ],
  );
});

test('parsePiTranscript: user and assistant text; a tool-call stop is not final', () => {
  const j = (o) => JSON.stringify(o);
  const text = [
    j({ type: 'session', id: 'p1', cwd: '/w' }),
    j({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    j({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'checking' }], stopReason: 'toolUse' } }),
    j({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'out' }] } }),
    j({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }),
  ].join('\n');
  assert.deepEqual(
    parsePiTranscript(text).map((x) => [x.role, x.text, x.final]),
    [
      ['user', 'hi', undefined],
      ['assistant', 'checking', false],
      ['assistant', 'done', true],
    ],
  );
});

test('the reader reads a Codex / pi session from the transcript path discovery gave it', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overmind-tr-'));
  const file = path.join(dir, 's.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'yo' }] } }) + '\n');
  const r = createTranscriptReader({ home: dir });
  const got = await r.messages({ session_id: 'p1', cwd: '/w', harness: 'pi', transcript: file });
  assert.equal(got.messages[0].text, 'yo');
  assert.equal(await r.messages({ session_id: 'p2', cwd: '/w', harness: 'pi', transcript: null }), null);
});

test('parseTranscript shows queued prompts: absorbed mid-turn in place, still waiting last', () => {
  const q = (operation, content, extra = {}) => line({ type: 'queue-operation', operation, timestamp: '2026-01-01T00:00:00Z', ...(content == null ? {} : { content }), ...extra });
  const absorbed = (prompt, origin = { kind: 'human' }) =>
    line({ type: 'attachment', timestamp: '2026-01-01T00:00:01Z', attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin } });
  const jsonl = [
    user('Start'),
    q('enqueue', 'first'),
    q('enqueue', '<task-notification><summary>done</summary></task-notification>'),
    q('remove', 'first', { reason: 'absorbed_mid_turn' }),
    absorbed('first'),
    absorbed('from a peer', { kind: 'peer' }),
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'note', commandMode: 'task-notification' } }),
    q('dequeue'),
    q('enqueue', 'second'),
    q('enqueue', '<agent-message from="x">hand-back</agent-message>'),
    q('enqueue', 'third'),
    q('dequeue'),
    user('second'),
    asst([{ type: 'text', text: 'Working.' }], { stop: 'tool_use' }),
  ].join('\n');
  const out = parseTranscript(jsonl);
  assert.deepEqual(
    out.map((m) => [m.role, m.text, m.queued ?? false]),
    [
      ['user', 'Start', false],
      ['user', 'first', false],
      ['user', 'second', false],
      ['assistant', 'Working.', false],
      ['user', 'third', true],
    ],
  );
  assert.equal(typeof out.at(-1).ts, 'number');
});

test('the reader grows the tail when huge tool results leave too few messages for the limit', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'overmind-tr-'));
  const file = transcriptPath('/w', 'g1', home);
  mkdirSync(path.dirname(file), { recursive: true });
  const blob = user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(2000) }]);
  writeFileSync(file, [user('the first prompt'), blob, blob, blob, user('latest')].join('\n') + '\n');
  const r = createTranscriptReader({ home, maxBytes: 1000, maxGrownBytes: 1 << 20 });
  const session = { session_id: 'g1', cwd: '/w' };
  const one = await r.messages(session, 1);
  assert.deepEqual([one.messages.map((m) => m.text), one.truncated], [['latest'], true]);
  const all = await r.messages(session, 60);
  assert.deepEqual([all.messages.map((m) => m.text), all.truncated], [['the first prompt', 'latest'], false]);
  const capped = createTranscriptReader({ home, maxBytes: 1000, maxGrownBytes: 4000 });
  assert.equal((await capped.messages(session, 60)).truncated, true);
});

// ------------------------------------------------------------------ deltas (#37)

import { QUESTION_CAP, sliceDelta, snapshotEntry, stableIndex } from '../lib/transcript.mjs';
import { appendFileSync, renameSync, truncateSync, utimesSync, statSync } from 'node:fs';

const said = (text, extra = {}) => ({ role: 'assistant', kind: 'assistant', text, final: true, ...extra });
const typed = (text, extra = {}) => ({ role: 'user', kind: 'user', text, ...extra });
const asking = (id, extra = {}) => ({ role: 'assistant', kind: 'question', id, questions: [], text: '?', ...extra });

test('stableIndex: the first message a later line could still change', () => {
  const cases = [
    ['empty', 'claude', [], 0],
    ['last assistant bubble can still grow', 'claude', [typed('a'), said('b')], 1],
    ['a user line settles everything', 'claude', [typed('a'), said('b'), typed('c')], 3],
    ['an open question stays volatile', 'claude', [typed('a'), asking('q1'), typed('c')], 1],
    ['an answered question is settled', 'claude', [typed('a'), asking('q1', { answers: ['x'] }), typed('c')], 3],
    ['a declined question is settled', 'claude', [asking('q1', { declined: true }), typed('c')], 2],
    [`an open question with more than ${QUESTION_CAP} after it counts as settled`, 'claude', [asking('q1'), ...Array.from({ length: QUESTION_CAP + 1 }, (_, i) => typed(`u${i}`))], QUESTION_CAP + 2],
    [`…exactly ${QUESTION_CAP} after it is still volatile`, 'claude', [asking('q1'), ...Array.from({ length: QUESTION_CAP }, (_, i) => typed(`u${i}`))], 0],
    ['the queued suffix, and the bubble before it', 'claude', [typed('a'), said('b'), typed('q', { queued: true })], 1],
    ['the queued suffix after a user line', 'claude', [typed('a'), typed('q', { queued: true }), typed('r', { queued: true })], 1],
    ['codex: the last assistant message (final may flip)', 'codex', [typed('a'), said('b')], 1],
    ['codex: a user turn settles it', 'codex', [typed('a'), said('b'), typed('c')], 3],
    ['pi: append-only', 'pi', [typed('a'), said('b')], 2],
  ];
  for (const [name, harness, list, want] of cases) assert.equal(stableIndex(harness, list), want, name);
});

test('sliceDelta: full without a cursor, same for an equal cursor, a delta from the older stable', () => {
  const list = [typed('a'), said('b'), typed('c'), said('d')];
  const e1 = snapshotEntry(list, { gen: 'aaaaaaaa' });
  const first = sliceDelta(e1, { limit: 60, after: '' });
  assert.deepEqual([first.full, first.from, first.messages.length, first.total, first.stable], [true, 0, 4, 4, 3]);
  const legacy = sliceDelta(e1, { limit: 60, after: null });
  assert.equal(legacy.full, true);
  const same = sliceDelta(e1, { limit: 60, after: first.cursor });
  assert.deepEqual([same.full, same.from, same.messages], [false, 4, []]);
  const e2 = snapshotEntry([...list.slice(0, 3), said('d, longer'), typed('e')], { gen: 'aaaaaaaa' });
  const d = sliceDelta(e2, { limit: 60, after: first.cursor });
  assert.deepEqual([d.full, d.from, d.messages.map((m) => m.text)], [false, 3, ['d, longer', 'e']]);
  for (const bad of ['garbage', 'bbbbbbbb:3:4:0123456789abcdef:60', first.cursor.replace(/:60$/, ':200'), `${first.cursor}:x`]) {
    assert.equal(sliceDelta(e2, { limit: 60, after: bad }).full, true, bad);
  }
  // A cursor claiming a higher stable than it could hold is clamped to its own total, never trusted.
  const greedy = first.cursor.replace(/^(\w+):3:/, '$1:9:');
  const g = sliceDelta(e2, { limit: 60, after: greedy });
  assert.deepEqual([g.full, g.from], [false, 4]);
});

test('sliceDelta: a gap longer than the window, or a window that would have to reach back, is full', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => typed(`m${i}`));
  const e1 = snapshotEntry(many(10), { gen: 'aaaaaaaa' });
  const c = sliceDelta(e1, { limit: 5, after: '' });
  assert.deepEqual([c.from, c.messages.length, c.truncated], [5, 5, true]);
  const e2 = snapshotEntry(many(16), { gen: 'aaaaaaaa' });
  const gap = sliceDelta(e2, { limit: 5, after: c.cursor });
  assert.deepEqual([gap.full, gap.from, gap.messages.length], [true, 11, 5]);
  // Queue removal: total shrinks below the client's window → it could not rebuild it.
  const q = snapshotEntry([...many(10), typed('x', { queued: true }), typed('y', { queued: true })], { gen: 'aaaaaaaa' });
  const qc = sliceDelta(q, { limit: 5, after: '' });
  const removed = snapshotEntry([...many(10), typed('y', { queued: true })], { gen: 'aaaaaaaa' });
  const r = sliceDelta(removed, { limit: 5, after: qc.cursor });
  assert.equal(r.full, true);
  assert.deepEqual(r.messages.map((m) => m.text), ['m6', 'm7', 'm8', 'm9', 'y']);
});

/** A Claude transcript in a temp HOME, written line by line. */
function claudeFixture(id = 'd1') {
  const home = mkdtempSync(path.join(os.tmpdir(), 'overmind-delta-'));
  const file = transcriptPath('/w', id, home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  const add = (...lines) => appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return { home, file, add, session: { session_id: id, cwd: '/w' } };
}
const toolResult = (id = 't') => user([{ type: 'tool_result', tool_use_id: id, content: 'out' }]);
const askLine = (id, msg = `msg_${id}`) =>
  asst([{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: 'Pick?', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] } }], { id: msg, stop: 'tool_use' });
const answerLine = (id) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { questions: [{ question: 'Pick?' }], answers: { 'Pick?': 'A' } } });

/** What a client holds after merging `body` onto `held` (the UI's merge rule, mirrored). */
function merge(held, body, limit) {
  if (!held || body.full) return { list: body.messages.slice(), total: body.total };
  const base = held.total - held.list.length;
  const keep = held.list.slice(0, Math.max(0, body.from - base));
  return { list: keep.concat(body.messages).slice(-limit), total: body.total };
}

test('reader deltas: every poll merges to what a full fetch of the same cache returns', async () => {
  const f = claudeFixture();
  const r = createTranscriptReader({ home: f.home });
  const limit = 6;
  let held = null;
  let cursor = '';
  const kinds = [];
  const poll = async () => {
    const body = await r.delta(f.session, { limit, after: cursor });
    held = merge(held, body, limit);
    cursor = body.cursor;
    const full = await r.messages(f.session, limit);
    assert.deepEqual(held.list, full.messages, `after ${kinds.length} polls`);
    kinds.push(body.full ? 'full' : body.messages.length ? 'delta' : 'same');
    return body;
  };
  f.add(user('first'), asst([{ type: 'text', text: 'one' }], { id: 'm1' }));
  await poll();
  f.add(toolResult(), toolResult());
  const quiet = await poll();
  assert.deepEqual([quiet.full, quiet.messages], [false, []], 'tool-result lines change no message');
  f.add(user('second'));
  const u = await poll();
  assert.deepEqual([u.from, u.messages.map((m) => m.text)], [1, ['one', 'second']], 'the settled reply is re-sent once');
  for (const part of ['a', 'b', 'c']) {
    f.add(asst([{ type: 'text', text: part }], { id: 'm2', stop: 'tool_use' }));
    const s = await poll();
    assert.equal(s.messages.at(-1).text, ['a', 'b', 'c'].slice(0, ['a', 'b', 'c'].indexOf(part) + 1).join('\n\n'));
    assert.equal(s.stable, 3);
  }
  f.add(askLine('q1'));
  await poll();
  for (let i = 0; i < 3; i++) f.add(user(`more ${i}`));
  await poll();
  f.add(answerLine('q1'));
  const answered = await poll();
  assert.equal(answered.full, false, 'within the cap the question is still in the delta');
  assert.deepEqual(answered.messages[0].answers, ['A']);
  for (let i = 0; i < 10; i++) f.add(user(`burst ${i}`), asst([{ type: 'text', text: `r${i}` }], { id: `b${i}` }));
  const gap = await poll();
  assert.equal(gap.full, true, 'more new messages than the window');
  f.add(user('x'));
  const same = await poll();
  const reads = r.stats().reads;
  const again = await r.delta(f.session, { limit, after: same.cursor });
  assert.deepEqual([again.full, again.messages, r.stats().reads], [false, [], reads], 'unchanged: no read');
  assert.ok(kinds.includes('same') && kinds.includes('delta'));
});

test('reader deltas: a question answered 25 messages later (below stable) re-anchors → full', async () => {
  const f = claudeFixture();
  const r = createTranscriptReader({ home: f.home });
  f.add(user('go'), askLine('q9'));
  for (let i = 0; i < 25; i++) f.add(user(`while waiting ${i}`));
  const before = await r.delta(f.session, { limit: 60, after: '' });
  assert.equal(before.stable, 27, 'the question past the cap counts as settled');
  f.add(answerLine('q9'));
  const after = await r.delta(f.session, { limit: 60, after: before.cursor });
  assert.equal(after.full, true, 'the prefix hash caught the mutation');
  assert.notEqual(after.cursor.split(':')[0], before.cursor.split(':')[0], 'a new generation');
  assert.deepEqual(after.messages.find((m) => m.id === 'q9').answers, ['A']);
});

test('reader deltas: truncate, replace, same-size rewrite and truncate-then-regrow each start a new generation', async () => {
  const f = claudeFixture();
  const r = createTranscriptReader({ home: f.home });
  f.add(user('one'), user('two'), user('three'));
  const gen = (b) => b.cursor.split(':')[0];
  let prev = await r.delta(f.session, { limit: 60, after: '' });
  const expectFull = async (what) => {
    const b = await r.delta(f.session, { limit: 60, after: prev.cursor });
    assert.equal(b.full, true, what);
    assert.notEqual(gen(b), gen(prev), what);
    prev = b;
    return b;
  };
  truncateSync(f.file, 0);
  writeFileSync(f.file, `${user('one')}\n`);
  assert.deepEqual((await expectFull('shrunk')).messages.map((m) => m.text), ['one']);

  const tmp = `${f.file}.new`;
  writeFileSync(tmp, `${user('one')}\n${user('replaced')}\n`);
  renameSync(tmp, f.file);
  assert.deepEqual((await expectFull('new inode')).messages.map((m) => m.text), ['one', 'replaced']);

  const size = statSync(f.file).size;
  writeFileSync(f.file, `${user('one')}\n${user('REPLACED')}\n`);
  assert.equal(statSync(f.file).size, size);
  const t = new Date(Date.now() + 5000);
  utimesSync(f.file, t, t);
  assert.deepEqual((await expectFull('same size, new mtime')).messages.map((m) => m.text), ['one', 'REPLACED']);

  // Truncated to a shorter prefix and regrown past the old size before the next poll.
  writeFileSync(f.file, `${user('one')}\n${user('a different, longer second prompt')}\n`);
  const t2 = new Date(Date.now() + 10000);
  utimesSync(f.file, t2, t2);
  assert.deepEqual((await expectFull('probe mismatch')).messages.map((m) => m.text), ['one', 'a different, longer second prompt']);
});

test('reader deltas: a grown tail (limit 500) bumps the generation once; the re-anchor threshold too', async () => {
  const f = claudeFixture();
  const blob = user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(400) }]);
  for (let i = 0; i < 6; i++) f.add(user(`p${i}`), blob);
  const r = createTranscriptReader({ home: f.home, maxBytes: 1000, maxGrownBytes: 1 << 20 });
  const small = await r.delta(f.session, { limit: 2, after: '' });
  assert.equal(small.truncated, true);
  const big = await r.delta(f.session, { limit: 500, after: '' });
  assert.notEqual(big.cursor.split(':')[0], small.cursor.split(':')[0]);
  assert.equal(big.total, 6);
  const again = await r.delta(f.session, { limit: 500, after: big.cursor });
  assert.deepEqual([again.full, again.messages], [false, []], 'enough now: no second bump');

  const g = createTranscriptReader({ home: f.home, maxBytes: 1000, maxGrownBytes: 1000 });
  let b = await g.delta(f.session, { limit: 60, after: '' });
  const startGen = b.cursor.split(':')[0];
  f.add(user('small'));
  b = await g.delta(f.session, { limit: 60, after: b.cursor });
  assert.deepEqual([b.full, b.messages.map((m) => m.text)], [false, ['small']], 'within 1.5 × maxBytes: anchored');
  f.add(blob, blob);
  b = await g.delta(f.session, { limit: 60, after: b.cursor });
  assert.equal(b.full, true, 'past 1.5 × maxBytes: re-anchored');
  assert.notEqual(b.cursor.split(':')[0], startGen);
});

test('reader deltas: the anchored span keeps indices while the file grows past maxBytes', async () => {
  const f = claudeFixture();
  for (let i = 0; i < 10; i++) f.add(user(`p${i} ${'y'.repeat(80)}`));
  const r = createTranscriptReader({ home: f.home, maxBytes: 600, maxGrownBytes: 600 });
  const a = await r.delta(f.session, { limit: 60, after: '' });
  f.add(user('next'));
  const b = await r.delta(f.session, { limit: 60, after: a.cursor });
  assert.deepEqual([b.full, b.from, b.total], [false, a.total, a.total + 1], 'today a re-slice would have shifted every index');
});

test('reader deltas: concurrent polls after an append coalesce into one read', async () => {
  const f = claudeFixture();
  f.add(user('one'));
  const r = createTranscriptReader({ home: f.home });
  const first = await r.delta(f.session, { limit: 60, after: '' });
  f.add(user('two'));
  const reads = r.stats().reads;
  const [x, y] = await Promise.all([r.delta(f.session, { limit: 60, after: first.cursor }), r.delta(f.session, { limit: 60, after: first.cursor })]);
  assert.equal(r.stats().reads - reads, 1);
  assert.deepEqual(x.messages, y.messages);
  assert.equal(x.cursor, y.cursor);
  assert.deepEqual(x.messages.map((m) => m.text), ['two']);
});

test('reader deltas: Codex (last reply volatile) and pi (append-only) through the same reader', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overmind-delta-'));
  const j = (o) => JSON.stringify(o);
  const cx = path.join(dir, 'rollout.jsonl');
  const cmsg = (role, type, text) => j({ type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } });
  writeFileSync(cx, `${cmsg('user', 'input_text', 'fix it')}\n${cmsg('assistant', 'output_text', 'Looking.')}\n`);
  const r = createTranscriptReader({ home: dir });
  const cs = { session_id: 'c1', cwd: '/w', harness: 'codex', transcript: cx };
  const c1 = await r.delta(cs, { limit: 60, after: '' });
  assert.equal(c1.stable, 1);
  appendFileSync(cx, `${j({ type: 'response_item', payload: { type: 'function_call', name: 'exec' } })}\n`);
  const c2 = await r.delta(cs, { limit: 60, after: c1.cursor });
  assert.deepEqual([c2.full, c2.from, c2.messages[0].final], [false, 1, false], 'the flipped final is re-sent');

  const pi = path.join(dir, 'pi.jsonl');
  const pmsg = (role, text) => j({ type: 'message', message: { role, content: [{ type: 'text', text }] } });
  writeFileSync(pi, `${pmsg('user', 'hi')}\n`);
  const ps = { session_id: 'p1', cwd: '/w', harness: 'pi', transcript: pi };
  const p1 = await r.delta(ps, { limit: 60, after: '' });
  appendFileSync(pi, `${pmsg('assistant', 'yo')}\n`);
  const p2 = await r.delta(ps, { limit: 60, after: p1.cursor });
  assert.deepEqual([p2.full, p2.from, p2.messages.map((m) => m.text)], [false, 1, ['yo']]);
});
