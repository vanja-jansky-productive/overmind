import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCodexTools, decodePsArgs, etimeSeconds, parseLsofCwd, parsePs, rolloutCommands, shellScript, toolTargets } from '../lib/codex-tools.mjs';

const line = (o) => JSON.stringify(o);
const T0 = Date.parse('2026-11-06T08:45:42.000Z');
const started = (ts = '2026-11-06T08:45:42.000Z') => line({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started' } });
const exec = (input, ts = '2026-11-06T08:45:42.209Z') => line({ timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input } });

test("rolloutCommands: every script the current turn asked to run, with when — from every call shape Codex 0.166 writes", () => {
  const text = [
    started('2026-11-06T08:40:00.000Z'),
    exec('await tools.exec_command({cmd:"an earlier turn"});', '2026-11-06T08:40:01.000Z'),
    started(),
    exec('const r=await tools.exec_command({cmd:"sleep 61; echo done61",sandbox_permissions:"require_escalated"});text(r.output);\n'),
    exec('await tools.exec_command({"cmd": `printf \'a\\nb\'`}); await tools.exec_command({cmd:\'npm test\'})'),
    line({ timestamp: '2026-11-06T08:45:43.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cargo build' }) } }),
    line({ timestamp: '2026-11-06T08:45:43.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'c3', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'make'] }) } }),
    line({ timestamp: '2026-11-06T08:45:44.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'ls -la'] } } }),
    line({ type: 'response_item', payload: { type: 'function_call', call_id: 'c4', name: 'exec_command', arguments: JSON.stringify({ cmd: 'no timestamp' }) } }),
  ].join('\n');
  assert.deepEqual(rolloutCommands(text), [
    { cmd: 'sleep 61; echo done61', atMs: T0 + 209 },
    { cmd: "printf 'a\nb'", atMs: T0 + 209 },
    { cmd: 'npm test', atMs: T0 + 209 },
    { cmd: 'cargo build', atMs: T0 + 1000 },
    { cmd: 'make', atMs: T0 + 1000 },
    { cmd: 'ls -la', atMs: T0 + 2000 },
  ], "an earlier turn's commands are not this turn's: a dev server it started is left running");
  // A tail that starts mid-turn (no turn start in it): what it has.
  assert.deepEqual(rolloutCommands(exec('await tools.exec_command({cmd:"x"})')), [{ cmd: 'x', atMs: T0 + 209 }]);
  // An interrupt (the close's Escape) does not start a turn: the aborted turn's commands stay.
  const aborted = line({ timestamp: '2026-11-06T08:46:00.000Z', type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } });
  assert.deepEqual(rolloutCommands([started(), exec('await tools.exec_command({cmd:"x"})'), aborted].join('\n')), [{ cmd: 'x', atMs: T0 + 209 }]);
  assert.deepEqual(rolloutCommands('garbage\n'), []);
});

test('ps parsing: etime forms, octal-escaped newlines, shells only', () => {
  assert.equal(etimeSeconds('00:03'), 3);
  assert.equal(etimeSeconds('01:02:03'), 3723);
  assert.equal(etimeSeconds('2-00:00:01'), 172801);
  assert.ok(Number.isNaN(etimeSeconds('x')));
  assert.equal(decodePsArgs('zsh -c sleep 3\\012echo "a  b"'), 'zsh -c sleep 3\necho "a  b"');
  const rows = parsePs('  101     1   101   01:00 /bin/zsh -c sleep 61; echo done61\nbad line\n', 1_000_000);
  assert.deepEqual(rows, [{ pid: 101, ppid: 1, pgid: 101, startMs: 940_000, args: '/bin/zsh -c sleep 61; echo done61' }]);
  assert.equal(shellScript('/bin/zsh -c sleep 61; echo done61'), 'sleep 61; echo done61');
  assert.equal(shellScript('/bin/bash -lc make'), 'make');
  assert.equal(shellScript('-zsh -c x'), 'x');
  assert.equal(shellScript('node -c x'), null);
  assert.equal(shellScript('/bin/zsh'), null);
  assert.deepEqual([...parseLsofCwd('p101\nfcwd\nn/work/project\np102\nfcwd\nn/elsewhere\n')], [[101, '/work/project'], [102, '/elsewhere']]);
});

// The live trees (docs/codex-findings.md §6). Embedded mode: pane → codex TUI (500) → the turn's
// `zsh -c …` (600) → sleep (601), the code-mode host and an MCP server; an older identical command
// of this pane (650), one in another checkout (660). A second embedded pane in the SAME checkout
// (TUI 800) runs the identical command (810) and a dev server (820). A process outside (900).
const NOW = T0 + 60_000;
const ps = (pid, ppid, pgid, startMs, args) => ({ pid, ppid, pgid, startMs, args });
const ROWS = [
  ps(499, 1, 499, T0 - 600_000, '/opt/homebrew/bin/tmux -L omtest new-session'),
  ps(500, 499, 500, T0 - 300_000, '/opt/codex/bin/codex -a on-request -s read-only'),
  ps(511, 500, 500, T0 - 300_000, '/opt/codex/bin/codex-code-mode-host'),
  ps(512, 500, 512, T0 - 300_000, 'node /work/tinymcp.mjs'),
  ps(600, 500, 600, T0 + 1_000, '/bin/zsh -c sleep 61; echo done61'),
  ps(601, 600, 600, T0 + 1_010, 'sleep 61'),
  ps(650, 500, 650, T0 - 120_000, '/bin/zsh -c sleep 61; echo done61'),
  ps(660, 500, 660, T0 + 2_000, '/bin/zsh -c npm test'),
  ps(800, 499, 800, T0 - 200_000, '/opt/codex/bin/codex'),
  ps(810, 800, 810, T0 + 2_000, '/bin/zsh -c sleep 61; echo done61'),
  ps(811, 810, 810, T0 + 2_010, 'sleep 61'),
  ps(820, 800, 820, T0 + 3_000, '/bin/zsh -lc npm run dev'),
  ps(900, 1, 900, T0 + 1_000, '/bin/zsh -c sleep 61; echo done61'),
];
const CWD = { 600: '/work/project', 650: '/work/project', 660: '/work/other', 810: '/work/project', 820: '/work/project/web', 900: '/work/project' };
const CALLS = [{ cmd: 'sleep 61; echo done61', atMs: T0 + 209 }, { cmd: 'npm test', atMs: T0 + 209 }, { cmd: 'npm run dev', atMs: T0 + 209 }];
const cwdOf = (pid) => CWD[pid] ?? null;

test("toolTargets (embedded mode): the TUI's own shells this turn asked for, and what they started — never another pane's", () => {
  const t = toolTargets({ rows: ROWS, root: 500, calls: CALLS, cwd: '/work/project', cwdOf });
  assert.deepEqual(t.leaders, [600], '650 started before the call, 660 runs in another checkout, 810/820 are the other pane\'s, 900 is outside');
  assert.deepEqual(t.pids, [600, 601]);
  // Closing the other pane in the same checkout: only its own.
  assert.deepEqual(toolTargets({ rows: ROWS, root: 800, calls: CALLS, cwd: '/work/project', cwdOf }).pids, [810, 811, 820]);
  // Never the code-mode host or an MCP server, even when a command matches its args.
  assert.deepEqual(toolTargets({ rows: ROWS, root: 500, calls: [{ cmd: '/work/tinymcp.mjs', atMs: T0 - 600_000 }], cwd: '/work/project', cwdOf: () => '/work/project' }).pids, []);
  // The same script asked for twice this turn: its earliest call is the bound.
  const twice = toolTargets({ rows: ROWS, root: 500, calls: [{ cmd: 'sleep 61; echo done61', atMs: T0 - 130_000 }, ...CALLS], cwd: '/work/project', cwdOf });
  assert.deepEqual(twice.leaders, [600, 650]);
  // An unknown cwd, no calls, a bad root: nothing.
  assert.deepEqual(toolTargets({ rows: ROWS, root: 500, calls: CALLS, cwd: '/work/project' }).pids, []);
  assert.deepEqual(toolTargets({ rows: ROWS, root: 500, calls: [], cwd: '/work/project', cwdOf }).pids, []);
  assert.deepEqual(toolTargets({ rows: ROWS, root: 1, calls: CALLS, cwd: '/work/project', cwdOf }).pids, []);
  // A row whose cwd is `/` narrows nothing: never a match by cwd.
  assert.deepEqual(toolTargets({ rows: ROWS, root: 500, calls: CALLS, cwd: '/', cwdOf }).pids, []);
});

test('toolTargets (daemon mode): nothing — the daemon serves every pane, so its shells are never told apart; Codex ends them itself', () => {
  // The review's topology: pane A's TUI (200) started the daemon (300), which also serves pane B
  // (TUI 210). B runs `npm test` (400) and a dev server (500) in A's checkout; A asked for both
  // commands earlier. Closing A must touch neither.
  const m = 60_000;
  const rows = [
    ps(100, 1, 100, T0 - 60 * m, '-zsh'),
    ps(200, 100, 200, T0 - 59 * m, '/opt/homebrew/bin/codex'),
    ps(300, 200, 200, T0 - 59 * m, '/opt/homebrew/bin/codex app-server'),
    ps(110, 1, 110, T0 - 50 * m, '-zsh'),
    ps(210, 110, 210, T0 - 50 * m, '/opt/homebrew/bin/codex'),
    ps(400, 300, 400, T0 - 1 * m, '/bin/zsh -lc npm test'),
    ps(401, 400, 400, T0 - 1 * m, 'node jest'),
    ps(500, 300, 500, T0 - 2 * m, '/bin/zsh -lc npm run dev'),
  ];
  const calls = [{ cmd: 'npm test', atMs: T0 - 30 * m }, { cmd: 'npm run dev', atMs: T0 - 40 * m }];
  const at = (pid) => ({ 400: '/repo', 500: '/repo/web' })[pid] ?? null;
  assert.deepEqual(toolTargets({ rows, root: 200, calls, cwd: '/repo', cwdOf: at }), { leaders: [], pids: [] });
});

test('createCodexTools: one ps and one lsof for the candidates; a reused pid is never "alive"', async () => {
  const calls = [];
  const etime = (ms) => {
    const s = Math.round(ms / 1000);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  let psOut = ROWS.map((r) => `${r.pid} ${r.ppid} ${r.pgid} ${etime(NOW - r.startMs)} ${r.args}`).join('\n');
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'ps') return { stdout: psOut };
    if (bin === 'lsof') return { stdout: args.at(-1).split(',').map((p) => `p${p}\nfcwd\nn${CWD[p] ?? '/x'}`).join('\n') };
    throw new Error('unexpected');
  };
  const rollout = [started(), exec('await tools.exec_command({cmd:"sleep 61; echo done61"})')].join('\n');
  const tools = createCodexTools({ run, readTail: () => rollout, now: () => NOW });
  const row = { harness: 'codex', pid: 500, cwd: '/work/project', transcript: '/r.jsonl' };
  const found = await tools.find(row);
  assert.deepEqual(found.leaders, [600]);
  assert.deepEqual(found.groups, [600], 'it leads its own process group');
  assert.deepEqual(found.pids.sort(), [600, 601]);
  assert.deepEqual(calls.map((c) => c[0]), ['ps', 'lsof']);
  assert.deepEqual(calls[1].slice(1), ['-a', '-d', 'cwd', '-Fpn', '-p', '600'], 'only the TUI\'s own shells this turn asked for');
  assert.deepEqual((await tools.alive(found)).map((r) => r.pid).sort(), [600, 601]);
  psOut = psOut.replace(/^601 .*$/m, '601 1 601 00:01 /usr/bin/other');
  assert.deepEqual((await tools.alive(found)).map((r) => r.pid), [600], 'pid 601 now runs something else');
  // Not Codex, no transcript, nothing matching: no ps at all for the first two.
  calls.length = 0;
  assert.deepEqual((await tools.find({ ...row, harness: 'claude' })).pids, []);
  assert.deepEqual((await tools.find({ ...row, transcript: null })).pids, []);
  assert.deepEqual(calls, []);
  // ps failing: nothing found, never an error out of a close.
  const broken = createCodexTools({ run: async () => { throw new Error('ps: boom'); }, readTail: () => rollout, now: () => NOW });
  assert.deepEqual((await broken.find(row)).pids, []);
});
