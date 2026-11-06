import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCodexTools, decodePsArgs, etimeSeconds, parseLsofCwd, parsePs, rolloutCommands, shellScript, toolTargets } from '../lib/codex-tools.mjs';

const line = (o) => JSON.stringify(o);
const T0 = Date.parse('2026-11-06T08:45:42.000Z');
const started = (ts = '2026-11-06T08:45:42.000Z') => line({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started' } });
const exec = (input, ts = '2026-11-06T08:45:42.209Z') => line({ timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input } });

test('rolloutCommands: every script the rollout asked to run, with when — from every call shape Codex 0.166 writes', () => {
  const ts = (iso) => Date.parse(iso);
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
    { cmd: 'an earlier turn', atMs: ts('2026-11-06T08:40:01.000Z') },
    { cmd: 'sleep 61; echo done61', atMs: T0 + 209 },
    { cmd: "printf 'a\nb'", atMs: T0 + 209 },
    { cmd: 'npm test', atMs: T0 + 209 },
    { cmd: 'cargo build', atMs: T0 + 1000 },
    { cmd: 'make', atMs: T0 + 1000 },
    { cmd: 'ls -la', atMs: T0 + 2000 },
  ]);
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

// The live tree (docs/codex-findings.md §6): pane → codex TUI (500) → app-server daemon (510) →
// [code-mode host, an MCP server, the turn's `zsh -c …` (600) → sleep (601)], plus another pane's
// tool (700) under the same daemon, an older one of this pane (650), and a process outside (900).
const NOW = T0 + 60_000;
const ps = (pid, ppid, pgid, startMs, args) => ({ pid, ppid, pgid, startMs, args });
const ROWS = [
  ps(499, 1, 499, T0 - 600_000, '/opt/homebrew/bin/tmux -L omtest new-session'),
  ps(500, 499, 500, T0 - 300_000, '/opt/codex/bin/codex -a on-request -s read-only'),
  ps(510, 500, 510, T0 - 300_000, '/home/.codex/packages/app-server-daemon/bin/codex app-server --listen unix:// --managed-daemon'),
  ps(511, 510, 510, T0 - 300_000, '/home/.codex/packages/app-server-daemon/bin/codex-code-mode-host'),
  ps(512, 510, 512, T0 - 300_000, 'node /work/tinymcp.mjs'),
  ps(600, 510, 600, T0 + 1_000, '/bin/zsh -c sleep 61; echo done61'),
  ps(601, 600, 600, T0 + 1_010, 'sleep 61'),
  ps(650, 510, 650, T0 - 120_000, '/bin/zsh -c sleep 61; echo done61'),
  ps(700, 510, 700, T0 + 2_000, '/bin/zsh -c sleep 61; echo done61'),
  ps(701, 510, 701, T0 + 2_000, '/bin/zsh -c npm run dev'),
  ps(900, 1, 900, T0 + 1_000, '/bin/zsh -c sleep 61; echo done61'),
];
const CWD = { 600: '/work/project', 650: '/work/project', 700: '/work/other', 701: '/work/project', 900: '/work/project' };
const CALLS = [{ cmd: 'sleep 61; echo done61', atMs: T0 + 209 }];

test("toolTargets: the turn's own shell and what it started, nothing else in or outside the pane's tree", () => {
  const t = toolTargets({ rows: ROWS, root: 500, calls: CALLS, cwd: '/work/project', cwdOf: (pid) => CWD[pid] ?? null });
  assert.deepEqual(t.leaders, [600], '650 started before the call, 700 runs in another checkout, 701 is not a command it asked for, 900 is outside the tree');
  assert.deepEqual(t.pids.sort(), [600, 601]);
  // Never the daemon, the code-mode host or an MCP server, even when a command matches its args.
  const odd = toolTargets({ rows: ROWS, root: 500, calls: [{ cmd: '/work/tinymcp.mjs', atMs: T0 - 600_000 }], cwd: '/work/project', cwdOf: () => '/work/project' });
  assert.deepEqual(odd.pids, []);
  // The same script asked for earlier too: its earliest call is the bound (650 is that one's).
  const twice = toolTargets({ rows: ROWS, root: 500, calls: [{ cmd: 'sleep 61; echo done61', atMs: T0 - 130_000 }, ...CALLS], cwd: '/work/project', cwdOf: (pid) => CWD[pid] ?? null });
  assert.deepEqual(twice.leaders, [600, 650]);
  // An unknown cwd, no calls, a bad root: nothing.
  assert.deepEqual(toolTargets({ rows: ROWS, root: 500, calls: CALLS, cwd: '/work/project' }).pids, []);
  assert.deepEqual(toolTargets({ rows: ROWS, root: 500, calls: [], cwd: '/work/project', cwdOf: () => '/work/project' }).pids, []);
  assert.deepEqual(toolTargets({ rows: ROWS, root: 1, calls: CALLS, cwd: '/', cwdOf: () => '/' }).pids, []);
  // A daemon another pane started is not in this pane's tree: its tools are left alone.
  const other = ROWS.map((r) => (r.pid === 510 ? { ...r, ppid: 1 } : r));
  assert.deepEqual(toolTargets({ rows: other, root: 500, calls: CALLS, cwd: '/work/project', cwdOf: (pid) => CWD[pid] ?? null }).pids, []);
  // Embedded mode: the TUI itself is the parent.
  const embedded = [ROWS[1], ps(620, 500, 620, T0 + 500, '/bin/bash -lc cargo build'), ps(621, 620, 620, T0 + 600, 'cargo build')];
  assert.deepEqual(
    toolTargets({ rows: embedded, root: 500, calls: [{ cmd: 'cargo build', atMs: T0 }], cwd: '/work/project', cwdOf: () => '/work/project/sub' }).pids.sort(),
    [620, 621],
  );
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
  assert.deepEqual(calls[1].slice(1), ['-a', '-d', 'cwd', '-Fpn', '-p', '600,700']);
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
