import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  clampLines,
  findSession,
  resolveHost,
  sortSessions,
  statusRank,
  tailLines,
  validateKey,
  validateSendText,
} from '../lib/util.mjs';
import { resolveStaticPath, readJsonBody, contentTypeFor, HttpError } from '../lib/http.mjs';
import { createBackend, BackendError, createScriptProvider, ITERM_SCRIPT, parseScreen, SCREEN_FORMAT, TYPE_CHUNK, typeChunks } from '../lib/backends.mjs';
import { createOvermind, trimTitle, TITLE_MAX } from '../lib/overmind.mjs';
import { createOvermindCli } from '../lib/overmind-cli.mjs';
import { ensurePath, ensureUtf8Locale } from '../lib/config.mjs';

// ------------------------------------------------------------------ tailLines

test('tailLines takes the last N lines', () => {
  const text = 'a\nb\nc\nd\ne';
  assert.equal(tailLines(text, 2), 'd\ne');
  assert.equal(tailLines(text, 99), 'a\nb\nc\nd\ne');
});

test('tailLines trims trailing blank lines and per-line trailing whitespace', () => {
  const text = 'one   \ntwo\t\n\n   \n\n';
  assert.equal(tailLines(text, 100), 'one\ntwo');
});

test('tailLines counts from the last non-blank line (short output in a tall pane)', () => {
  const pane = `$ cmd\noutput${'\n'.repeat(40)}`;
  assert.equal(tailLines(pane, 10), '$ cmd\noutput');
  assert.equal(tailLines(pane, 1), 'output');
});

test('tailLines keeps interior blank lines', () => {
  assert.equal(tailLines('a\n\nb\n\n\n', 100), 'a\n\nb');
});

test('tailLines normalises CRLF and handles empty input', () => {
  assert.equal(tailLines('a\r\nb\r\n', 10), 'a\nb');
  assert.equal(tailLines('', 10), '');
  assert.equal(tailLines(undefined, 10), '');
});

test('tailLines slices after dropping the blank bottom, not before', () => {
  assert.equal(tailLines('x\ny\nz\n\n\n', 2), 'y\nz');
});

// ------------------------------------------------------------------ clampLines

test('clampLines defaults and clamps to 10..2000', () => {
  assert.equal(clampLines(undefined), 200);
  assert.equal(clampLines(null), 200);
  assert.equal(clampLines('abc'), 200);
  assert.equal(clampLines('1'), 10);
  assert.equal(clampLines('-5'), 10);
  assert.equal(clampLines('99999'), 2000);
  assert.equal(clampLines('30'), 30);
});

// ------------------------------------------------------------------ sorting

test('statusRank orders waiting > busy > idle > unknown', () => {
  assert.deepEqual(
    ['unknown', 'idle', 'busy', 'waiting'].map(statusRank).sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
  assert.equal(statusRank('bogus'), 3);
  assert.equal(statusRank(undefined), 3);
});

test('sortSessions: waiting, busy, idle, unknown, then updated_at desc', () => {
  const input = [
    { session_id: 'i1', status: 'idle', updated_at: 100 },
    { session_id: 'b1', status: 'busy', updated_at: 50 },
    { session_id: 'u1', status: 'weird', updated_at: 9999 },
    { session_id: 'w1', status: 'waiting', updated_at: 1 },
    { session_id: 'b2', status: 'busy', updated_at: 500 },
    { session_id: 'i2', status: 'idle', updated_at: 900 },
  ];
  assert.deepEqual(
    sortSessions(input).map((s) => s.session_id),
    ['w1', 'b2', 'b1', 'i2', 'i1', 'u1'],
  );
});

test('sortSessions does not mutate its input and tolerates junk', () => {
  const input = [{ status: 'idle' }, { status: 'waiting' }];
  const copy = [...input];
  sortSessions(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(sortSessions(undefined), []);
});

// ------------------------------------------------------------------ host resolution

const CFG = { self: 'laptop', peers: { workstation: 'http://workstation.example:7878' } };

test('resolveHost: self, peer, unknown', () => {
  assert.deepEqual(resolveHost('laptop', CFG), { kind: 'self' });
  assert.deepEqual(resolveHost('workstation', CFG), { kind: 'peer', url: 'http://workstation.example:7878' });
  assert.deepEqual(resolveHost('nope', CFG), { kind: 'unknown' });
  assert.deepEqual(resolveHost('', CFG), { kind: 'unknown' });
  assert.deepEqual(resolveHost(undefined, CFG), { kind: 'unknown' });
});

test('resolveHost ignores prototype pollution style names', () => {
  assert.deepEqual(resolveHost('toString', CFG), { kind: 'unknown' });
  assert.deepEqual(resolveHost('__proto__', CFG), { kind: 'unknown' });
});

// ------------------------------------------------------------------ session lookup

const SESSIONS = [
  { session_id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'one' },
  { session_id: 'aaaaaaaa-5555-6666-7878-888888888888', name: 'two' },
  { session_id: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'three' },
];

test('findSession matches exact id', () => {
  assert.equal(findSession(SESSIONS, SESSIONS[1].session_id).name, 'two');
});

test('findSession matches a unique prefix of >= 8 chars', () => {
  assert.equal(findSession(SESSIONS, 'bbbbbbbb').name, 'three');
  assert.equal(findSession(SESSIONS, 'aaaaaaaa-5').name, 'two');
});

test('findSession rejects ambiguous or too-short prefixes', () => {
  assert.equal(findSession(SESSIONS, 'aaaaaaaa'), null); // ambiguous
  assert.equal(findSession(SESSIONS, 'bbbbb'), null); // < 8 chars
  assert.equal(findSession(SESSIONS, 'zzzzzzzzzz'), null);
  assert.equal(findSession([], 'whatever'), null);
});

// ------------------------------------------------------------------ input validation

test('validateSendText enforces non-empty string <= 8000 chars', () => {
  assert.equal(validateSendText('hello').ok, true);
  assert.equal(validateSendText('multi\nline\ntext').ok, true, 'newlines are allowed');
  assert.equal(validateSendText('').ok, false);
  assert.equal(validateSendText('   ').ok, false);
  assert.equal(validateSendText(42).ok, false);
  assert.equal(validateSendText(undefined).ok, false);
  assert.equal(validateSendText('x'.repeat(8000)).ok, true);
  assert.equal(validateSendText('x'.repeat(8001)).ok, false);
});

test('validateKey allows only Enter and Escape', () => {
  assert.equal(validateKey('Enter').ok, true);
  assert.equal(validateKey('Escape').ok, true);
  assert.equal(validateKey('escape').ok, false);
  assert.equal(validateKey('C-c').ok, false);
  assert.equal(validateKey(undefined).ok, false);
});

// ------------------------------------------------------------------ static paths

const PUB = '/srv/overmind-web/public';

test('resolveStaticPath maps / to index.html', () => {
  assert.deepEqual(resolveStaticPath(PUB, '/'), { ok: true, file: path.join(PUB, 'index.html') });
  assert.deepEqual(resolveStaticPath(PUB, '/app.js'), { ok: true, file: path.join(PUB, 'app.js') });
  assert.deepEqual(resolveStaticPath(PUB, '/sub/dir/x.css'), { ok: true, file: path.join(PUB, 'sub/dir/x.css') });
});

test('resolveStaticPath rejects traversal, encoded traversal and null bytes', () => {
  for (const p of [
    '/../server.mjs',
    '/foo/../../server.mjs',
    '/%2e%2e/server.mjs',
    '/%2e%2e%2fserver.mjs',
    '/a/%2e%2e/%2e%2e/etc/passwd',
  ]) {
    const r = resolveStaticPath(PUB, p);
    assert.equal(r.ok, false, `expected rejection for ${p}`);
    assert.equal(r.status, 400);
  }
  assert.equal(resolveStaticPath(PUB, '/a\0b').ok, false);
  assert.equal(resolveStaticPath(PUB, '/%ZZ').ok, false);
  assert.equal(resolveStaticPath(PUB, 'relative').ok, false);
});

test('resolveStaticPath keeps files with dots in the name', () => {
  assert.equal(resolveStaticPath(PUB, '/manifest.webmanifest').ok, true);
  assert.equal(resolveStaticPath(PUB, '/a..b.js').ok, true);
});

test('contentTypeFor covers the formats the UI ships', () => {
  assert.match(contentTypeFor('x.html'), /^text\/html/);
  assert.match(contentTypeFor('x.js'), /javascript/);
  assert.match(contentTypeFor('x.css'), /^text\/css/);
  assert.match(contentTypeFor('x.json'), /^application\/json/);
  assert.match(contentTypeFor('x.webmanifest'), /manifest\+json/);
  assert.equal(contentTypeFor('x.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('x.png'), 'image/png');
  assert.equal(contentTypeFor('x.bin'), 'application/octet-stream');
});

// ------------------------------------------------------------------ body limit

function fakeRequest(chunks) {
  const stream = new PassThrough();
  queueMicrotask(() => {
    for (const c of chunks) stream.write(c);
    stream.end();
  });
  stream.destroy = () => stream.end();
  return stream;
}

test('readJsonBody parses an object body', async () => {
  const body = await readJsonBody(fakeRequest([JSON.stringify({ text: 'hi' })]));
  assert.deepEqual(body, { text: 'hi' });
});

test('readJsonBody treats an empty body as {}', async () => {
  assert.deepEqual(await readJsonBody(fakeRequest([''])), {});
});

test('readJsonBody rejects invalid JSON and non-objects with 400', async () => {
  await assert.rejects(() => readJsonBody(fakeRequest(['{nope'])), (e) => e.status === 400);
  await assert.rejects(() => readJsonBody(fakeRequest(['[1,2]'])), (e) => e.status === 400);
  await assert.rejects(() => readJsonBody(fakeRequest(['"str"'])), (e) => e.status === 400);
});

test('readJsonBody enforces the 64 KB limit with 413', async () => {
  const big = 'x'.repeat(70 * 1024);
  await assert.rejects(
    () => readJsonBody(fakeRequest([big])),
    (e) => e instanceof HttpError && e.status === 413,
  );
});

test('readJsonBody accepts a body just under the limit', async () => {
  const payload = JSON.stringify({ text: 'y'.repeat(60 * 1024) });
  const body = await readJsonBody(fakeRequest([payload]));
  assert.equal(body.text.length, 60 * 1024);
});

// ------------------------------------------------------------------ backends (mocked run)

function recorder(impl) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return impl ? impl(file, args, opts) : { stdout: '', stderr: '' };
  };
  return { calls, run };
}

const noSleep = async () => {};
const script = () => '/tmp/fake.applescript';

test('tmux peek uses capture-pane -p -J and tails the output', async () => {
  const { calls, run } = recorder(async () => ({ stdout: 'l1\nl2\nl3\n\n\n', stderr: '' }));
  const backend = createBackend({ run, tmux: '/opt/homebrew/bin/tmux', scriptPath: script, sleep: noSleep });
  const text = await backend.peek({ backend: 'tmux', handle: '%87' }, 30);
  assert.deepEqual(calls[0].args, ['capture-pane', '-p', '-J', '-t', '%87', '-S', '-30']);
  assert.equal(text, 'l1\nl2\nl3');
});

test('tmux send writes literal text (with --) then Enter separately', async () => {
  const { calls, run } = recorder();
  const backend = createBackend({ run, tmux: 'tmux', scriptPath: script, sleep: noSleep });
  await backend.send({ backend: 'tmux', handle: '%1' }, '-starts-with-dash');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['send-keys', '-t', '%1', '-l', '--', '-starts-with-dash']);
  assert.deepEqual(calls[1].args, ['send-keys', '-t', '%1', 'Enter']);
});

test('tmux send types a long line in pieces so Claude keeps all of it', async () => {
  const { calls, run } = recorder();
  const backend = createBackend({ run, tmux: 'tmux', scriptPath: script, sleep: noSleep });
  const text = 'tok-0123456789 é '.repeat(120);
  await backend.send({ backend: 'tmux', handle: '%1' }, text);
  const typed = calls.slice(0, -1);
  assert.ok(typed.length > 1);
  for (const c of typed) {
    assert.deepEqual(c.args.slice(0, 5), ['send-keys', '-t', '%1', '-l', '--']);
    assert.ok(Buffer.byteLength(c.args[5]) <= TYPE_CHUNK);
  }
  assert.equal(typed.map((c) => c.args[5]).join(''), text);
  assert.deepEqual(calls.at(-1).args, ['send-keys', '-t', '%1', 'Enter']);
});

test('tmux screen reads the pane state and its coloured rows', async () => {
  const { calls, run } = recorder(async (file, args) =>
    args[0] === 'display-message' ? { stdout: '80 3 4 2 1 1 0 0 0 1 1 0\n', stderr: '' } : { stdout: '\x1b[31mred\x1b[0m\n❯ 1. Yes\n', stderr: '' },
  );
  const backend = createBackend({ run, tmux: 'tmux', scriptPath: script, sleep: noSleep });
  const frame = await backend.screen({ backend: 'tmux', handle: '%9' });
  assert.deepEqual(calls[0].args, ['display-message', '-p', '-t', '%9', SCREEN_FORMAT]);
  assert.deepEqual(calls[1].args, ['capture-pane', '-p', '-e', '-N', '-t', '%9']);
  assert.deepEqual(frame, {
    cols: 80,
    rows: 3,
    cursor: { x: 4, y: 2, visible: true },
    altScreen: true,
    appCursor: false,
    mouse: { tracking: 'all', sgr: true, utf8: false },
    lines: ['\x1b[31mred\x1b[0m', '❯ 1. Yes', ''],
  });
});

test('screen is tmux-only (409 for iTerm)', async () => {
  const { run } = recorder();
  const backend = createBackend({ run, tmux: 'tmux', scriptPath: script, sleep: noSleep });
  await assert.rejects(backend.screen({ backend: 'iterm', handle: 'w0t0p0' }), (e) => e instanceof BackendError && e.status === 409);
});

test('parseScreen maps the mouse flags to a tracking mode', () => {
  assert.equal(parseScreen('80 24 0 0 1 0 1 1 0 0 0 0', '').mouse.tracking, 'click');
  assert.equal(parseScreen('80 24 0 0 1 0 1 0 1 0 0 0', '').mouse.tracking, 'drag');
  assert.equal(parseScreen('80 24 0 0 0 0 0 0 0 0 0 0', '').mouse.tracking, 'none');
  assert.equal(parseScreen('80 24 0 0 1 0 1 0 0 0 0 0', '').appCursor, true);
  assert.equal(parseScreen('80 24 0 0 0 0 0 0 0 0 0 0', 'a\nb\n').lines.length, 24);
});

test('tmux input sends the raw bytes as hex, chunked', async () => {
  const { calls, run } = recorder();
  const backend = createBackend({ run, tmux: 'tmux', scriptPath: script, sleep: noSleep });
  await backend.input({ backend: 'tmux', handle: '%1' }, '\x1b[<0;10;5M❯');
  assert.deepEqual(calls[0].args, ['send-keys', '-t', '%1', '-H', '1b', '5b', '3c', '30', '3b', '31', '30', '3b', '35', '4d', 'e2', '9d', 'af']);
  calls.length = 0;
  await backend.input({ backend: 'tmux', handle: '%1' }, 'x'.repeat(600));
  assert.deepEqual(calls.map((c) => c.args.length - 4), [256, 256, 88]);
});

test('typeChunks never splits a character', () => {
  assert.deepEqual(typeChunks('', 4), []);
  assert.deepEqual(typeChunks('abcé-fg', 4), ['abc', 'é-f', 'g']);
});

test('tmux send pastes a multi-line message so its newlines survive', async () => {
  const { calls, run } = recorder();
  const backend = createBackend({ run, tmux: 'tmux', scriptPath: script, sleep: noSleep });
  await backend.send({ backend: 'tmux', handle: '%1' }, 'line one\nline two');
  assert.equal(calls.length, 3);
  const [load, paste, enter] = calls;
  const buf = load.args[2];
  assert.deepEqual(load.args, ['load-buffer', '-b', buf, '-']);
  assert.equal(load.opts.input, 'line one\nline two');
  assert.deepEqual(paste.args, ['paste-buffer', '-p', '-r', '-d', '-b', buf, '-t', '%1']);
  assert.deepEqual(enter.args, ['send-keys', '-t', '%1', 'Enter']);
});

test('tmux keys sends the bare key name', async () => {
  const { calls, run } = recorder();
  const backend = createBackend({ run, tmux: 'tmux', scriptPath: script, sleep: noSleep });
  await backend.keys({ backend: 'tmux', handle: '%1' }, 'Escape');
  assert.deepEqual(calls[0].args, ['send-keys', '-t', '%1', 'Escape']);
});

test('iterm backend passes values as argv, never interpolated', async () => {
  const { calls, run } = recorder(async () => ({ stdout: 'hello\nworld\n', stderr: '' }));
  const backend = createBackend({ run, scriptPath: script, sleep: noSleep });
  const session = { backend: 'iterm', handle: 'ABC-123' };
  await backend.peek(session, 10);
  await backend.send(session, 'rm -rf "$(pwd)"');
  await backend.keys(session, 'Enter');
  await backend.keys(session, 'Escape');
  assert.deepEqual(calls.map((c) => c.args), [
    ['/tmp/fake.applescript', 'peek', 'ABC-123'],
    ['/tmp/fake.applescript', 'send', 'ABC-123', 'rm -rf "$(pwd)"'],
    ['/tmp/fake.applescript', 'enter', 'ABC-123'],
    ['/tmp/fake.applescript', 'escape', 'ABC-123'],
  ]);
  assert.ok(calls.every((c) => c.file === '/usr/bin/osascript'));
});

test('iterm closeIterm runs the close mode with the session id as argv', async () => {
  const { calls, run } = recorder(async () => ({ stdout: 'ok', stderr: '' }));
  const backend = createBackend({ run, scriptPath: script, sleep: noSleep });
  await backend.closeIterm({ backend: 'iterm', handle: 'ABC-123' });
  assert.deepEqual(calls.at(-1).args, ['/tmp/fake.applescript', 'close', 'ABC-123']);
  assert.match(ITERM_SCRIPT, /theMode is "close"/);
  await assert.rejects(() => backend.closeIterm({ backend: 'iterm', handle: '' }), (e) => e.status === 409);
});

test('unknown backend and missing handle are 409', async () => {
  const { run } = recorder();
  const backend = createBackend({ run, scriptPath: script, sleep: noSleep });
  await assert.rejects(
    () => backend.peek({ backend: 'unknown', handle: 'x' }, 10),
    (e) => e instanceof BackendError && e.status === 409,
  );
  await assert.rejects(
    () => backend.send({ backend: 'tmux', handle: '' }, 'hi'),
    (e) => e instanceof BackendError && e.status === 409,
  );
});

test('createScriptProvider writes the AppleScript once and reuses it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-web-test-'));
  try {
    const provider = createScriptProvider({ tmpdir: dir });
    const a = provider();
    const b = provider();
    assert.equal(a, b);
    assert.equal(fs.readFileSync(a, 'utf8'), ITERM_SCRIPT);
    assert.match(ITERM_SCRIPT, /on findSession\(theId\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ overmind discovery

const FAKE_LIST = JSON.stringify([
  { session_id: 'a', status: 'idle', updated_at: 2 },
  { session_id: 'b', status: 'waiting', updated_at: 1 },
]);

test('overmind sorts, tags host and caches for the TTL', async () => {
  let clock = 1000;
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { stdout: FAKE_LIST, stderr: '' };
  };
  const overmind = createOvermind({ cli: createOvermindCli({ run }), self: 'laptop', ttlMs: 2000, now: () => clock });
  const first = await overmind.localHost();
  assert.equal(first.ok, true);
  assert.equal(first.name, 'laptop');
  assert.deepEqual(first.sessions.map((s) => s.session_id), ['b', 'a']);
  assert.ok(first.sessions.every((s) => s.host === 'laptop'));

  clock += 500;
  await overmind.localHost();
  assert.equal(calls, 1, 'served from cache');

  clock += 2500;
  await overmind.localHost();
  assert.equal(calls, 2, 'cache expired');
});

test('trimTitle caps long first prompts for transport', () => {
  assert.equal(trimTitle('short'), 'short');
  assert.equal(trimTitle(null), null);
  assert.equal(trimTitle(undefined), null);
  const long = trimTitle('x'.repeat(TITLE_MAX + 50));
  assert.equal(long.length, TITLE_MAX + 1);
  assert.ok(long.endsWith('…'));
});

test('overmind trims session titles', async () => {
  const run = async () => ({ stdout: JSON.stringify([{ session_id: 'a', status: 'idle', title: 'y'.repeat(5000) }]), stderr: '' });
  const host = await createOvermind({ cli: createOvermindCli({ run }), self: 'laptop' }).localHost();
  assert.equal(host.sessions[0].title.length, TITLE_MAX + 1);
});

test('overmind passes context usage through untouched', async () => {
  const context = { used: 124000, window: 200000, pct: 62, model: 'claude-x' };
  const rows = [
    { session_id: 'a', status: 'idle', context },
    { session_id: 'b', status: 'idle', context: null },
  ];
  const run = async () => ({ stdout: JSON.stringify(rows), stderr: '' });
  const host = await createOvermind({ cli: createOvermindCli({ run }), self: 'laptop' }).localHost();
  const byId = Object.fromEntries(host.sessions.map((s) => [s.session_id, s]));
  assert.deepEqual(byId.a.context, context);
  assert.equal(byId.b.context, null);
});

test('overmind CLI is invoked as `<bin> list --json`', async () => {
  const calls = [];
  const cli = createOvermindCli({
    bin: '/opt/overmind/bin/overmind',
    run: async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: '[]', stderr: '' };
    },
  });
  assert.deepEqual(await cli.list(), []);
  assert.deepEqual(calls, [['/opt/overmind/bin/overmind', 'list', '--json']]);
});

test('overmind de-duplicates concurrent discovery', async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { stdout: FAKE_LIST, stderr: '' };
  };
  const overmind = createOvermind({ cli: createOvermindCli({ run }), self: 'laptop' });
  await Promise.all([overmind.localHost(), overmind.localHost(), overmind.localHost()]);
  assert.equal(calls, 1);
});

test('overmind never throws: garbled output, non-array and child errors', async () => {
  const garbled = createOvermind({ cli: createOvermindCli({ run: async () => ({ stdout: 'not json', stderr: '' }) }), self: 'l' });
  const g = await garbled.localHost();
  assert.equal(g.ok, false);
  assert.match(g.error, /non-JSON/);

  const notArray = createOvermind({ cli: createOvermindCli({ run: async () => ({ stdout: '{"a":1}', stderr: '' }) }), self: 'l' });
  assert.equal((await notArray.localHost()).ok, false);

  const boom = createOvermind({
    cli: createOvermindCli({
      bin: '/nope/overmind',
      run: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
    }),
    self: 'l',
  });
  const b = await boom.localHost();
  assert.equal(b.ok, false);
  assert.match(b.error, /overmind binary not found \(\/nope\/overmind\)/);
  assert.deepEqual(b.sessions, []);

  const timedOut = createOvermind({
    cli: createOvermindCli({
      run: async () => {
        throw Object.assign(new Error('killed'), { killed: true });
      },
    }),
    self: 'l',
  });
  assert.match((await timedOut.localHost()).error, /timed out/);

  const empty = createOvermind({ cli: createOvermindCli({ run: async () => ({ stdout: '   ', stderr: '' }) }), self: 'l' });
  const e = await empty.localHost();
  assert.equal(e.ok, true);
  assert.deepEqual(e.sessions, []);
});

// ------------------------------------------------------------------ path

test('ensurePath prepends the homebrew/local bins once', () => {
  const env = { PATH: '/usr/bin:/bin' };
  ensurePath(env);
  assert.match(env.PATH, /^\/opt\/homebrew\/bin:/);
  const once = env.PATH;
  ensurePath(env);
  assert.equal(env.PATH, once, 'idempotent');
});

test('ensureUtf8Locale gives children a UTF-8 locale, keeping one that is already set', () => {
  assert.equal(ensureUtf8Locale({}).LC_CTYPE, 'en_US.UTF-8');
  assert.equal(ensureUtf8Locale({ LANG: 'hr_HR.UTF-8' }).LC_CTYPE, undefined);
  assert.equal(ensureUtf8Locale({ LC_ALL: 'C' }).LC_ALL, 'en_US.UTF-8');
});

test('etagMatches: exact, weak/strong, lists and *', async () => {
  const { etagMatches } = await import('../lib/app.mjs');
  const tag = 'W/"1a-2b"';
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches('"1a-2b"', tag), true);
  assert.equal(etagMatches('W/"x", W/"1a-2b"', tag), true);
  assert.equal(etagMatches('*', tag), true);
  assert.equal(etagMatches('W/"other"', tag), false);
  assert.equal(etagMatches(undefined, tag), false);
});
