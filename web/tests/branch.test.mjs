import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBrancher, cutClaude, cutCodex, validateBranchRequest } from '../lib/branch.mjs';
import { launchCommand } from '../lib/spawn.mjs';
import { codexRef, encodeCwd, parseCodexTranscript, parseTranscript } from '../lib/transcript.mjs';

const j = (o) => JSON.stringify(o);
const text = (t) => [{ type: 'text', text: t }];

// Two turns, then a branch the user abandoned (`u3x` hangs off `a1` too), plus bookkeeping.
const claudeLines = [
  j({ type: 'custom-title', customTitle: 'source', sessionId: 'S' }),
  j({ type: 'api-request', id: 'r1', sessionId: 'S' }),
  j({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'S', message: { role: 'user', content: 'first question' } }),
  j({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'S', message: { id: 'm1', role: 'assistant', content: text('first answer') } }),
  j({ type: 'user', uuid: 'u3x', parentUuid: 'a1', sessionId: 'S', message: { role: 'user', content: 'abandoned' } }),
  j({ type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'S', message: { role: 'user', content: 'second question' } }),
  j({ type: 'file-history-snapshot', messageId: 'u2', snapshot: {} }),
  j({ type: 'assistant', uuid: 'a2t', parentUuid: 'u2', sessionId: 'S', message: { id: 'm2', role: 'assistant', content: text('let me look') } }),
  j({ type: 'assistant', uuid: 'a2u', parentUuid: 'a2t', sessionId: 'S', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
  j({ type: 'user', uuid: 'r2', parentUuid: 'a2u', sessionId: 'S', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
  j({ type: 'assistant', uuid: 'a3', parentUuid: 'r2', sessionId: 'S', message: { id: 'm3', role: 'assistant', content: text('second answer') } }),
  j({ type: 'last-prompt', leafUuid: 'a3', sessionId: 'S' }),
].join('\n');

test('messages carry the ref a branch is cut at', () => {
  const msgs = parseTranscript(claudeLines);
  assert.deepEqual(
    msgs.map((m) => [m.kind, m.ref]),
    [
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u3x'],
      ['user', 'u2'],
      ['assistant', 'a2t'],
      ['assistant', 'a3'],
    ],
  );
});

test('cutClaude keeps the chain root → reply, a new session id, and the bookkeeping of kept entries', () => {
  const cut = cutClaude(claudeLines, 'a3', 'NEW');
  const rows = cut.lines.map((l) => JSON.parse(l));
  assert.equal(cut.role, 'assistant');
  assert.deepEqual(
    rows.map((r) => r.uuid ?? r.type),
    ['api-request', 'u1', 'a1', 'u2', 'file-history-snapshot', 'a2t', 'a2u', 'r2', 'a3'],
  );
  assert.ok(rows.every((r) => !('sessionId' in r) || r.sessionId === 'NEW'));
});

test('cutClaude from a prompt stops before it and hands its text back', () => {
  const cut = cutClaude(claudeLines, 'u2', 'NEW');
  assert.equal(cut.role, 'user');
  assert.equal(cut.text, 'second question');
  assert.deepEqual(
    cut.lines.map((l) => JSON.parse(l)).map((r) => r.uuid ?? r.type),
    ['api-request', 'u1', 'a1'],
  );
});

test('cutClaude never ends on a tool call without its result', () => {
  const cut = cutClaude(claudeLines, 'a2u', 'NEW');
  const last = JSON.parse(cut.lines.at(-1));
  assert.equal(last.uuid, 'a2u');
  assert.deepEqual(last.message.content, []);
  assert.throws(() => cutClaude(claudeLines, 'nope', 'NEW'), /no such message/);
});

const codexLines = [
  j({ type: 'session_meta', payload: { id: 'C', cwd: '/w' } }),
  j({ type: 'event_msg', payload: { type: 'task_started' } }),
  j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q1' }] } }),
  j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] } }),
  j({ type: 'event_msg', payload: { type: 'task_complete' } }),
  j({ type: 'event_msg', payload: { type: 'task_started' } }),
  j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q2' }] } }),
  j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a2' }] } }),
];

test('cutCodex: a reply keeps its turn, a prompt cuts before its turn', () => {
  const [q1, a1, q2] = parseCodexTranscript(codexLines.join('\n'));
  assert.equal(a1.ref, codexRef(codexLines[3]));
  const after = cutCodex(codexLines.join('\n'), a1.ref, 'NEW');
  assert.equal(after.lines.length, 5);
  assert.equal(JSON.parse(after.lines[0]).payload.id, 'NEW');
  const before = cutCodex(codexLines.join('\n'), q2.ref, 'NEW');
  assert.equal(before.lines.length, 5); // through task_complete, not the next task_started
  assert.equal(before.text, 'q2');
  assert.equal(cutCodex(codexLines.join('\n'), q1.ref, 'NEW').lines.length, 1);
});

test('launchCommand resumes a branch', () => {
  assert.equal(launchCommand({ harness: 'claude', name: 'b', model: 'opus', resume: 'id1', prompt: 'go' }), "claude --model 'opus' -n 'b' --resume 'id1' 'go'");
  assert.equal(launchCommand({ launcher: 'codex', harness: 'codex', name: 'b', resume: 'id2' }), "codex resume 'id2'");
});

test('validateBranchRequest', () => {
  assert.equal(validateBranchRequest({}, 'claude').ok, false);
  assert.equal(validateBranchRequest({ ref: 'u1', harness: 'pi' }, 'claude').ok, false);
  assert.deepEqual(validateBranchRequest({ ref: 'u1', harness: 'codex', model: 'gpt-6' }, 'claude'), { ok: true, ref: 'u1', harness: 'codex', model: 'gpt-6', effort: '', prompt: null, name: '', title: '' });
  assert.equal(validateBranchRequest({ ref: 'u1', harness: 'codex', model: 'gpt-6-luna', effort: 'max' }, 'claude').effort, 'max');
  assert.match(validateBranchRequest({ ref: 'u1', effort: 'Max!' }, 'claude').error, /effort must be/);
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overmind-branch-'));
  const home = path.join(root, 'claude');
  const codex = path.join(root, 'codex');
  const cwd = path.join(root, 'w');
  await fs.mkdir(path.join(home, 'projects', encodeCwd(cwd)), { recursive: true });
  await fs.writeFile(path.join(home, 'projects', encodeCwd(cwd), 'S.jsonl'), claudeLines);
  const spawned = [];
  const spawner = {
    tmuxHasSession: async (n) => n === 'src-branch',
    spawn: async (o) => (spawned.push(o), { name: o.name, tmuxSession: o.name }),
  };
  const brancher = createBrancher({ spawner, home, codex, promptDir: path.join(root, 'prompts'), newId: () => 'NEW', now: () => new Date(2026, 9, 21, 9, 5, 7) });
  return { root, home, codex, cwd, spawned, brancher };
}

test('a same-agent branch writes the cut transcript and resumes it', async () => {
  const t = await setup();
  const r = await t.brancher.branch({ session_id: 'S', harness: 'claude', cwd: t.cwd, name: 'src' }, { ref: 'u2', model: 'haiku' });
  assert.equal(r.sessionId, 'NEW');
  assert.equal(r.transcript, path.join(t.home, 'projects', encodeCwd(t.cwd), 'NEW.jsonl'));
  assert.equal((await fs.readFile(r.transcript, 'utf8')).trim().split('\n').length, 3);
  assert.deepEqual(t.spawned[0], { name: 'src-branch-2', title: '', dir: t.cwd, prompt: 'second question', nameGiven: true, model: 'haiku', effort: '', harness: 'claude', resume: 'NEW' });
  await fs.rm(t.root, { recursive: true });
});

test('a cross-agent branch hands the conversation over in a file', async () => {
  const t = await setup();
  const r = await t.brancher.branch({ session_id: 'S', harness: 'claude', cwd: t.cwd, name: 'src' }, { ref: 'a1', harness: 'codex', prompt: 'now you' });
  assert.equal(r.sessionId, null);
  const md = await fs.readFile(r.handoff, 'utf8');
  assert.match(md, /## User\n\nfirst question/);
  assert.match(md, /## Assistant\n\nfirst answer/);
  assert.doesNotMatch(md, /second question/);
  const s = t.spawned[0];
  assert.equal(s.harness, 'codex');
  assert.equal(s.resume, null);
  assert.ok(s.prompt.includes(r.handoff) && s.prompt.endsWith('now you'));
  await fs.rm(t.root, { recursive: true });
});

test('a pi session cannot be branched', async () => {
  const t = await setup();
  await assert.rejects(t.brancher.branch({ session_id: 'P', harness: 'pi', cwd: t.cwd }, { ref: 'x' }), (e) => e.status === 409);
  await fs.rm(t.root, { recursive: true });
});
