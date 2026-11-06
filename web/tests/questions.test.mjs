import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import {
  answerSteps,
  codexPatchPreview,
  normalizeQuestions,
  parseCodexScreenPrompt,
  parseScreenPrompt,
  questionOutcome,
  screenPromptParser,
  screenShowsPrompt,
  validateAnswer,
} from '../lib/questions.mjs';

const qs = normalizeQuestions({
  questions: [
    { question: 'Which pets do you like?', header: 'Pets', multiSelect: true, options: [{ label: 'Dog' }, { label: 'Cat' }, { label: 'Fish' }] },
    { question: 'Which city?', header: 'City', multiSelect: false, options: [{ label: 'Paris', description: 'FR' }, { label: 'Rome' }, { label: 'Oslo' }] },
  ],
});
const keys = (steps) => steps.map((s) => s.key ?? `"${s.text}"`).join(' ');

test('normalizeQuestions keeps question, header, multiSelect and labelled options', () => {
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[1].options[0], { label: 'Paris', description: 'FR' });
  assert.equal(qs[0].multiSelect, true);
  assert.equal(normalizeQuestions({}), null);
  assert.equal(normalizeQuestions({ questions: [{ question: 'Q', options: [] }] }), null);
});

test('answerSteps: single-select picks by arrows, a lone question needs no review', () => {
  const one = [qs[1]];
  assert.equal(keys(answerSteps(one, [{ options: [0], text: null }])), 'Enter');
  assert.equal(keys(answerSteps(one, [{ options: [2], text: null }])), 'Down Down Enter');
  assert.equal(keys(answerSteps(one, [{ options: [], text: 'Zagreb' }])), 'Down Down Down "Zagreb" Enter');
});

test('answerSteps: multi-select toggles, types, moves to Next; 2+ questions end on the review', () => {
  const steps = answerSteps(qs, [
    { options: [0, 2], text: 'hamster' },
    { options: [], text: 'Zagreb, obviously' },
  ]);
  assert.equal(
    keys(steps),
    ['Enter Down Down Enter Down "hamster" Down Enter', 'Down Down Down "Zagreb, obviously" Enter', 'Enter'].join(' '),
  );
  assert.equal(keys(answerSteps(qs, [{ options: [1], text: null }, { options: [1], text: null }])), 'Down Enter Down Down Down Enter Down Enter Enter');
});

test('validateAnswer enforces one pick for single-select, at least one for multi', () => {
  assert.equal(validateAnswer({ answers: [{ options: [0] }] }, qs).ok, false, 'one entry per question');
  assert.equal(validateAnswer({ answers: [{ options: [] }, { options: [0] }] }, qs).ok, false, 'multi needs something');
  assert.equal(validateAnswer({ answers: [{ options: [0] }, { options: [0, 1] }] }, qs).ok, false, 'single takes one');
  assert.equal(validateAnswer({ answers: [{ options: [0] }, { options: [0], text: 'x' }] }, qs).ok, false, 'single: option or text');
  assert.equal(validateAnswer({ answers: [{ options: [3] }, { options: [0] }] }, qs).ok, false, 'unknown option');
  assert.equal(validateAnswer({ answers: [{ text: 'a\nb' }, { options: [0] }] }, qs).ok, false, 'one line');
  assert.deepEqual(validateAnswer({ answers: [{ options: [2, 0, 2] }, { text: ' Zagreb ' }] }, qs), {
    ok: true,
    answers: [
      { options: [0, 2], text: null },
      { options: [], text: 'Zagreb' },
    ],
  });
});

test('questionOutcome: answers in question order, or declined', () => {
  const entry = { toolUseResult: { answers: { 'Which city?': 'Rome', 'Which pets do you like?': 'Dog, Fish' } } };
  assert.deepEqual(questionOutcome(qs, entry, { type: 'tool_result' }), { answers: ['Dog, Fish', 'Rome'] });
  assert.deepEqual(questionOutcome(qs, { toolUseResult: 'User rejected tool use' }, { is_error: true }), { declined: true });
});

test('screenShowsPrompt wants the first question, the cursor on option 1 and the prompt footer', () => {
  const screen = '←  ☐ Pets  ☐ City  ✔ Submit  →\nWhich pets do you\nlike?\n❯ 1. [ ] Dog\n  2. [ ] Cat\nEnter to select · Tab/Arrow keys to navigate';
  assert.equal(screenShowsPrompt(screen, qs), true);
  assert.equal(screenShowsPrompt(screen.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.'), qs), false);
  assert.equal(screenShowsPrompt('Which city?\n❯ 1. Paris\nEnter to select', qs), false);
  assert.equal(screenShowsPrompt('❯ ', qs), false);
});

// Screens as Claude Code 2.1.310 draws them (tmux capture-pane, trailing blanks trimmed).
const RULE = '─'.repeat(40);
const singleScreen = [
  '⏺ The command ran and printed hi.',
  RULE,
  ' ☐ Color',
  '',
  'Pick a color?',
  '',
  '❯ 1. Red',
  '     Choose red',
  '  2. Blue',
  '     Choose blue',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
const multiScreen = (nuts = ' ', cursor = 1) => [
  RULE,
  '←  ☒ Fruit  ☐ Toppings  ✔ Submit  →',
  '',
  'Pick toppings?',
  '',
  `${cursor === 1 ? '❯' : ' '} 1. [${nuts}] Nuts`,
  '         Add nuts',
  '  2. [ ] Honey',
  '         Add honey',
  '  3. [ ] Type something',
  `${cursor === 4 ? '❯' : ' '}    Submit`,
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');
const quotedScreen = [
  '⏺ Before sending I need your call.',
  RULE,
  '←  ☐ Login  ☐ Message  ✔ Submit  →',
  '',
  '│ Testers log in with an email and a password from the local db. How',
  '│ do they get the password?',
  '│',
  '│ Options:',
  '│ - an item',
  '',
  '❯ 1. Keep the old one',
  '     Passwords stay as they are. The thread',
  "     says 'ask the owner'.",
  '  2. Set a shared one',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');
const reviewScreen = [
  RULE,
  '←  ☒ Fruit  ☒ Toppings  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  ' ● Pick a fruit?',
  '   → Apple',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
].join('\n');

test('parseScreenPrompt: a single-select question, without its "Type something" row', () => {
  const p = parseScreenPrompt(singleScreen);
  assert.match(p.id, /^screen:[0-9a-f]{12}$/);
  assert.equal(p.untouched, true);
  assert.deepEqual(p.questions, [
    { question: 'Pick a color?', header: '', multiSelect: false, options: [{ label: 'Red', description: 'Choose red' }, { label: 'Blue', description: 'Choose blue' }] },
  ]);
  assert.equal(keys(answerSteps(p.questions, [{ options: [1], text: null }])), 'Down Enter');
  assert.equal(parseScreenPrompt(singleScreen).id, p.id, 'the id is stable');
});

test('parseScreenPrompt: a multi-select tab; touched once anything is checked or the cursor moved', () => {
  const p = parseScreenPrompt(multiScreen());
  assert.equal(p.questions[0].question, 'Pick toppings?');
  assert.equal(p.questions[0].multiSelect, true);
  assert.deepEqual(p.questions[0].options.map((o) => o.label), ['Nuts', 'Honey']);
  assert.equal(p.untouched, true);
  assert.equal(parseScreenPrompt(multiScreen('✔')).untouched, false);
  assert.equal(parseScreenPrompt(multiScreen(' ', 4)).untouched, false);
  assert.equal(parseScreenPrompt(multiScreen('✔')).id, p.id, 'same question, same id');
});

test('parseScreenPrompt: quoted long questions rejoin their wrapped lines, keep paragraphs and lists', () => {
  const p = parseScreenPrompt(quotedScreen);
  assert.equal(p.questions[0].question, 'Testers log in with an email and a password from the local db. How do they get the password?\n\nOptions:\n- an item');
  assert.deepEqual(p.questions[0].options[0], { label: 'Keep the old one', description: "Passwords stay as they are. The thread says 'ask the owner'." });
  assert.equal(p.questions[0].options.length, 2);
});

test('parseScreenPrompt: the review screen is a pick between Submit and Cancel, no typing', () => {
  const p = parseScreenPrompt(reviewScreen);
  const q = p.questions[0];
  assert.equal(q.noOther, true);
  assert.equal(q.question, 'Review your answers\n● Pick a fruit?\n→ Apple\nReady to submit your answers?');
  assert.deepEqual(q.options.map((o) => o.label), ['Submit answers', 'Cancel']);
  assert.equal(validateAnswer({ answers: [{ text: 'x' }] }, p.questions).ok, false);
  assert.equal(keys(answerSteps(p.questions, validateAnswer({ answers: [{ options: [0] }] }, p.questions).answers)), 'Enter');
});

test('parseScreenPrompt: no prompt on screen → null', () => {
  assert.equal(parseScreenPrompt(''), null);
  assert.equal(parseScreenPrompt('⏺ Done.\n❯ 1. not a prompt\n'), null);
  assert.equal(parseScreenPrompt(singleScreen.replace(/\nEnter to select.*$/, '')), null, 'no footer');
});

// ------------------------------------------------------------------ Codex's approval menu
// Captured from Codex 0.166 (paths replaced): a plain menu, and a sub-agent's request shown in
// the parent with a wrapped reason, a two-line `$ cmd` and a wrapped option 2.
const codexScreen = fs.readFileSync(new URL('./fixtures/codex-approval.txt', import.meta.url), 'utf8');
const codexChild = fs.readFileSync(new URL('./fixtures/codex-approval-child.txt', import.meta.url), 'utf8');

test('the Codex approval menu parses: command, reason, options without hotkeys, option 2 secondary', () => {
  const p = parseCodexScreenPrompt(codexScreen);
  assert.match(p.id, /^screen:[0-9a-f]{12}$/);
  assert.equal(p.untouched, true);
  const [q] = p.questions;
  assert.equal(q.header, 'Approval');
  assert.equal(q.noOther, true);
  assert.equal(q.multiSelect, false);
  assert.equal(q.question, 'Would you like to run the following command?\n$ printf hi > hello.txt\nReason: Allow creating hello.txt containing hi in this directory?');
  assert.deepEqual(
    q.options.map((o) => o.label),
    ['Yes, proceed', "Yes, and don't ask again for commands that start with `printf hi > hello.txt`", 'No, and tell Codex what to do differently'],
  );
  assert.equal(q.options[1].secondary, true);
  assert.match(q.options[1].description, /permanent allow rule for commands starting with `printf hi > hello.txt`/);
  assert.equal(q.options[0].secondary, undefined);
  // Down × index + Enter, like any single pick.
  assert.deepEqual(answerSteps(p.questions, [{ options: [2], text: null }]).map((s) => s.key), ['Down', 'Down', 'Enter']);
  assert.equal(screenPromptParser('codex'), parseCodexScreenPrompt);
  assert.equal(screenPromptParser('claude'), parseScreenPrompt);
  assert.equal(screenPromptParser('pi'), null);
});

test("a sub-agent's request: wrapped reason, two-line command, wrapped option 2", () => {
  const [q] = parseCodexScreenPrompt(codexChild).questions;
  assert.equal(
    q.question,
    'Would you like to run the following command?\nThread: Agent (01a1a7b1)\n$ git worktree add ~/Code/project/worktrees/project-perf-38\n-b perf-38 main\nReason: May I create the isolated worktree and branch for the approved issue #38 implementation?',
  );
  assert.equal(q.options[1].label, "Yes, and don't ask again for commands that start with `git worktree add`");
  assert.equal(q.options.length, 3);
});

test('a heredoc with numbered lines stays in the command; the options are the menu\'s', () => {
  const screen = fs.readFileSync(new URL('./fixtures/codex-approval-heredoc.txt', import.meta.url), 'utf8');
  const p = parseCodexScreenPrompt(screen);
  const [q] = p.questions;
  assert.equal(q.question, 'Would you like to run the following command?\n$ cat > notes.md <<EOF\n1. first\n2. second\nEOF\nReason: Allow writing notes.md?');
  assert.deepEqual(
    q.options.map((o) => o.label),
    ['Yes, proceed', "Yes, and don't ask again for commands that start with `cat`", 'No, and tell Codex what to do differently'],
  );
  assert.equal(p.untouched, true);
  // The cursor moved to option 2: option 1 has no ›, its `Yes,` still anchors the menu.
  const moved = screen.replace('› 1. Yes', '  1. Yes').replace('  2. Yes, and', '› 2. Yes, and');
  assert.equal(parseCodexScreenPrompt(moved).questions[0].options.length, 3);
  assert.equal(parseCodexScreenPrompt(moved).untouched, false);
});

test('the cursor off option 1 is touched; the composer › is not the cursor; no menu → null', () => {
  const moved = codexScreen.replace('› 1. Yes', '  1. Yes').replace('  2. Yes, and', '› 2. Yes, and');
  assert.equal(parseCodexScreenPrompt(moved).untouched, false);
  assert.equal(parseCodexScreenPrompt(moved).id, parseCodexScreenPrompt(codexScreen).id, 'same menu, same id');
  assert.match(codexScreen, /› create a file/, 'the composer line above uses › too');
  assert.equal(parseCodexScreenPrompt('✔ You approved codex to run printf hi > hello.txt this time\n• Working (2s • esc to interrupt)\n› Ask Codex to do anything'), null);
  assert.equal(parseCodexScreenPrompt(codexScreen.replace('Press enter to confirm or esc to cancel', '')), null, 'no footer');
  assert.equal(parseCodexScreenPrompt(''), null);
});

// ------------------------------------------------------------------ patch and MCP menus (#34 phase 5)
// Captured from Codex 0.166 against a mock model (paths replaced): an apply_patch outside the
// sandbox, the same at 90 columns (each Destination path hard-wrapped), an MCP tool call, and the
// MCP menu at 90 columns (option 3's description wraps).
const codexPatch = fs.readFileSync(new URL('./fixtures/codex-approval-patch.txt', import.meta.url), 'utf8');
const codexPatchWrapped = fs.readFileSync(new URL('./fixtures/codex-approval-patch-wrapped.txt', import.meta.url), 'utf8');
const codexMcp = fs.readFileSync(new URL('./fixtures/codex-approval-mcp.txt', import.meta.url), 'utf8');
const codexMcpNarrow = fs.readFileSync(new URL('./fixtures/codex-approval-mcp-narrow.txt', import.meta.url), 'utf8');

test('the Codex patch menu: its files (relative to the cwd), three options, "these files" secondary', () => {
  const p = parseCodexScreenPrompt(codexPatch, { cwd: '/work/project' });
  assert.equal(p.kind, 'patch');
  assert.equal(p.untouched, true);
  assert.equal(p.cursorAt, 0);
  const [q] = p.questions;
  assert.equal(q.header, 'Edit approval');
  assert.equal(q.noOther, true);
  assert.equal(q.question, 'Would you like to make the following edits?\nFiles:\n  a.txt\n  new.txt');
  assert.deepEqual(p.files, ['/work/project/a.txt', '/work/project/new.txt']);
  assert.deepEqual(
    q.options.map((o) => o.label),
    ['Yes, proceed', "Yes, and don't ask again for these files", 'No, and tell Codex what to do differently'],
  );
  assert.equal(q.options[1].secondary, true);
  assert.match(q.options[1].description, /these files.*rest of this session/);
  assert.equal(q.options[0].secondary, undefined);
  assert.deepEqual(answerSteps(p.questions, [{ options: [1], text: null }]).map((s) => s.key), ['Down', 'Enter']);
  // Without a cwd the paths stay absolute; the id does not depend on the cwd.
  const abs = parseCodexScreenPrompt(codexPatch);
  assert.equal(abs.questions[0].question, 'Would you like to make the following edits?\nFiles:\n  /work/project/a.txt\n  /work/project/new.txt');
  assert.equal(abs.id, p.id);
});

test('a patch menu at 90 columns: each Destination path joined back from its hard-wrapped lines', () => {
  const p = parseCodexScreenPrompt(codexPatchWrapped);
  const root = '/work/project-with-a-rather-long-name/checkouts/feature-branch-approval-cards-p5';
  assert.deepEqual(p.files, [`${root}/a.txt`, `${root}/added.md`, `${root}/src/deeply/nested/module_with_long_name.rs`]);
  assert.equal(p.questions[0].options.length, 3);
});

test('another patch, other files or another request: another card', () => {
  const p = parseCodexScreenPrompt(codexPatch, { request: 'call_1' });
  assert.notEqual(parseCodexScreenPrompt(codexPatch, { request: 'call_2' }).id, p.id);
  assert.notEqual(parseCodexScreenPrompt(codexPatch.replace('/work/project/new.txt', '/work/project/other.txt'), { request: 'call_1' }).id, p.id);
});

test('the Codex MCP menu: server, tool and the arguments it shows; four options, two secondary', () => {
  const p = parseCodexScreenPrompt(codexMcp);
  assert.equal(p.kind, 'mcp');
  assert.equal(p.untouched, true);
  const [q] = p.questions;
  assert.equal(q.header, 'MCP approval');
  assert.equal(q.question, 'Allow the tiny MCP server to run tool "write_note"?\npath: /work/project/notes/a-rather-long-directory-name/with-a-n...\ntext: hi from mcp');
  assert.deepEqual(q.options.map((o) => o.label), ['Allow', 'Allow for this session', 'Always allow', 'Cancel']);
  assert.equal(q.options[0].description, 'Run the tool and continue');
  assert.equal(q.options[1].secondary, true);
  assert.equal(q.options[2].secondary, true);
  assert.match(q.options[2].description, /config\.toml.*tiny\.write_note|tiny\.write_note.*config\.toml/);
  assert.equal(q.options[3].secondary, undefined);
  assert.deepEqual(answerSteps(p.questions, [{ options: [3], text: null }]).map((s) => s.key), ['Down', 'Down', 'Down', 'Enter']);
});

test('the MCP menu at 90 columns: a wrapped option description stays with its option; the cursor is read', () => {
  const p = parseCodexScreenPrompt(codexMcpNarrow);
  assert.deepEqual(p.questions[0].options.map((o) => o.label), ['Allow', 'Allow for this session', 'Always allow', 'Cancel']);
  const moved = codexMcpNarrow.replace('  › 1. Allow   ', '    1. Allow   ').replace('    2. Allow for', '  › 2. Allow for');
  const m = parseCodexScreenPrompt(moved);
  assert.equal(m.untouched, false);
  assert.equal(m.cursorAt, 1);
  assert.equal(m.id, p.id, 'same menu, same id');
  assert.equal(parseCodexScreenPrompt(codexMcp.replace('enter to submit | esc to cancel', '')), null, 'no footer');
  assert.equal(
    parseCodexScreenPrompt('• Called tiny.write_note\n  └ wrote /work/project/note.txt\n• done.\n› Ask Codex to do anything'),
    null,
  );
});

test("a patch card's diff preview is the pending call's patch — only when its files are the menu's", () => {
  const line = (o) => JSON.stringify(o);
  const started = line({ type: 'event_msg', payload: { type: 'task_started' } });
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n+patched\n*** Add File: new.txt\n+new file\n*** End Patch\n';
  const direct = line({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: patch } });
  const viaExec = line({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: `text(await tools.apply_patch(${JSON.stringify(patch)}));\n` } });
  const out1 = line({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } });
  const files = ['/work/project/a.txt', '/work/project/new.txt'];
  const want = '*** Update File: a.txt\n@@\n alpha\n+patched\n*** Add File: new.txt\n+new file';
  assert.equal(codexPatchPreview([started, direct].join('\n'), files, '/work/project'), want);
  assert.equal(codexPatchPreview([started, viaExec].join('\n'), files, '/work/project'), want, "code mode's tools.apply_patch(\"…\")");
  assert.equal(codexPatchPreview([started, direct, out1].join('\n'), files, '/work/project'), null, 'answered: not pending');
  assert.equal(codexPatchPreview([started, direct].join('\n'), ['/work/project/a.txt'], '/work/project'), null, 'other files: not this menu');
  assert.equal(codexPatchPreview([direct, started].join('\n'), files, '/work/project'), null, 'an earlier turn');
  assert.equal(codexPatchPreview([started, direct].join('\n'), files, '/work/project', 'c1'), want, 'the row names this call');
  assert.equal(codexPatchPreview([started, direct].join('\n'), files, '/work/project', 'c9'), null, 'the row names another call');
  assert.equal(codexPatchPreview([started, direct].join('\n'), files, '/work/project', 'hook-1'), want, "a hook stamp names no call: the files decide");
  const long = `*** Begin Patch\n*** Add File: new.txt\n${Array.from({ length: 100 }, (_, i) => `+line ${i}`).join('\n')}\n*** End Patch\n`;
  const big = codexPatchPreview([started, line({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c3', name: 'apply_patch', input: long } })].join('\n'), ['/work/project/new.txt'], '/work/project');
  assert.equal(big.split('\n').length, 61);
  assert.match(big, /… 41 more lines$/);
});
