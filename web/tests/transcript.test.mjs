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
