// Uploads: name sanitizing, storage layout, size limit, cleanup, and the HTTP route served
// locally and streamed through a peer. Two real servers on ephemeral 127.0.0.1 ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createUploader, dayDir, sanitizeUploadName } from '../lib/uploads.mjs';

function tmpDir(t, prefix = 'overmind-uploads-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sanitizeUploadName keeps a safe basename + extension', () => {
  assert.equal(sanitizeUploadName('screenshot.png'), 'screenshot.png');
  assert.equal(sanitizeUploadName('Screen Shot 2026-09-26 at 10.00.00.png'), 'Screen-Shot-2026-09-26-at-10.00.00.png');
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeUploadName('..\\..\\win.ini'), 'win.ini');
  assert.equal(sanitizeUploadName('/abs/path/x.txt'), 'x.txt');
  assert.equal(sanitizeUploadName('..'), 'file');
  assert.equal(sanitizeUploadName('.bashrc'), 'bashrc');
  assert.equal(sanitizeUploadName('a\u0000b\u001b[31m.txt'), 'ab-31m.txt');
  assert.equal(sanitizeUploadName('$(rm -rf ~);`x`.sh'), 'rm-rf-x.sh');
  assert.equal(sanitizeUploadName('čćž résumé.pdf'), 'čćž-résumé.pdf');
  assert.equal(sanitizeUploadName(''), 'file');
  assert.equal(sanitizeUploadName(null), 'file');
  const long = sanitizeUploadName(`${'x'.repeat(300)}.tar.gz`);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('.gz'));
  assert.equal(sanitizeUploadName(`a.${'e'.repeat(40)}`).length <= 80, true, 'absurd extension is not kept as one');
});

test('normalizeConfig: web.uploads defaults, ~ expansion, validation', () => {
  const home = '/home/tester';
  assert.deepEqual(normalizeConfig({}, { env: {}, home }).uploads, {
    dir: '/home/tester/.local/share/overmind/uploads',
    maxMB: 100,
    retentionDays: 14,
  });
  const cfg = normalizeConfig({ web: { uploads: { dir: '~/drop', maxMB: 5, retentionDays: 0 } } }, { env: {}, home });
  assert.deepEqual(cfg.uploads, { dir: '/home/tester/drop', maxMB: 5, retentionDays: 0 });
  assert.throws(() => normalizeConfig({ web: { uploads: { dir: 'rel/dir' } } }, { env: {}, home }), /absolute/);
  assert.throws(() => normalizeConfig({ web: { uploads: { maxMB: 0 } } }, { env: {}, home }), /maxMB/);
  assert.throws(() => normalizeConfig({ web: { uploads: { retentionDays: -1 } } }, { env: {}, home }), /retentionDays/);
  assert.throws(() => normalizeConfig({ web: { uploads: 'x' } }, { env: {}, home }), /web\.uploads/);
});

test('cleanup removes day dirs older than retentionDays, nothing else', async (t) => {
  const dir = tmpDir(t);
  const now = new Date(2026, 8, 26, 12);
  for (const d of ['2026-09-01', '2026-09-11', '2026-09-12', '2026-09-26', 'keep-me']) {
    fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, d, 'f'), 'x');
  }
  fs.writeFileSync(path.join(dir, '2026-01-01'), 'a file, not a day dir');
  const up = createUploader({ dir, retentionDays: 14, now: () => now });
  const { removed } = await up.cleanup();
  assert.deepEqual(removed.sort(), ['2026-09-01', '2026-09-11']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-01-01', '2026-09-12', '2026-09-26', 'keep-me']);
  assert.deepEqual((await createUploader({ dir, retentionDays: 0, now: () => now }).cleanup()).removed, []);
  assert.deepEqual((await createUploader({ dir: path.join(dir, 'missing') }).cleanup()).removed, []);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

/** laptop + workstation servers, each with its own upload dir and a 1 KB limit. */
async function startPair(t, { maxBytes = 1024 } = {}) {
  const dirs = { laptop: tmpDir(t), workstation: tmpDir(t) };
  const handles = {};
  const urls = {};
  for (const name of ['laptop', 'workstation']) {
    const server = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(server);
    t.after(() => server.close());
  }
  let counter = 0;
  for (const name of ['laptop', 'workstation']) {
    const config = normalizeConfig(
      { self: name, hosts: { laptop: { web: urls.laptop }, workstation: { web: urls.workstation } } },
      { env: {}, home: '/home/tester' },
    );
    const uploader = createUploader({ dir: dirs[name], maxBytes, random: () => `r${String(++counter).padStart(5, '0')}` });
    const overmind = { localHost: async () => ({ name, ok: true, sessions: [] }), invalidate() {} };
    const api = createApi({ config, overmind, backend: {}, transcripts: {}, spawner: {}, uploader, warmOvermind: false });
    t.after(() => api.stop());
    handles[name] = api;
  }
  return { urls, dirs };
}

async function upload(url, body, type = 'application/octet-stream') {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': type }, body });
  return { status: res.status, body: await res.json() };
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((p) => fs.statSync(path.join(dir, p)).isFile());
}

test('POST /api/hosts/:self/uploads stores the body under <dir>/YYYY-MM-DD/', async (t) => {
  const { urls, dirs } = await startPair(t);
  const r = await upload(`${urls.laptop}/api/hosts/laptop/uploads?name=${encodeURIComponent('../My Shot.png')}`, 'PNGDATA', 'image/png');
  assert.equal(r.status, 200);
  assert.equal(r.body.host, 'laptop');
  assert.equal(r.body.size, 7);
  assert.match(r.body.name, /^r\d{5}-My-Shot\.png$/);
  assert.equal(r.body.path, path.join(dirs.laptop, dayDir(), r.body.name));
  assert.ok(path.isAbsolute(r.body.path));
  assert.equal(fs.readFileSync(r.body.path, 'utf8'), 'PNGDATA');

  const noName = await upload(`${urls.laptop}/api/hosts/laptop/uploads`, 'x');
  assert.match(noName.body.name, /-file$/);
  assert.equal((await fetch(`${urls.laptop}/api/hosts/laptop/uploads`)).status, 405);
  assert.equal((await upload(`${urls.laptop}/api/hosts/nowhere/uploads?name=a`, 'x')).status, 404);
});

test('uploads to a peer are streamed there and land in the peer dir', async (t) => {
  const { urls, dirs } = await startPair(t, { maxBytes: 1024 * 1024 });
  const payload = Buffer.alloc(300 * 1024, 7);
  const r = await upload(`${urls.laptop}/api/hosts/workstation/uploads?name=big.bin`, payload);
  assert.equal(r.status, 200);
  assert.equal(r.body.host, 'workstation');
  assert.equal(r.body.size, payload.length);
  assert.ok(r.body.path.startsWith(dirs.workstation));
  assert.ok(fs.readFileSync(r.body.path).equals(payload));
  assert.deepEqual(filesUnder(dirs.laptop), [], 'nothing stored on the proxying host');

  // A streamed (chunked, no content-length) body through the peer works too.
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('chunk-1 '));
      c.enqueue(new TextEncoder().encode('chunk-2'));
      c.close();
    },
  });
  const res = await fetch(`${urls.laptop}/api/hosts/workstation/uploads?name=s.txt`, { method: 'POST', body: stream, duplex: 'half' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(fs.readFileSync(body.path, 'utf8'), 'chunk-1 chunk-2');

  // ?local=1 never chains to another peer.
  assert.equal((await upload(`${urls.workstation}/api/hosts/laptop/uploads?local=1&name=x`, 'x')).status, 404);
});

test('size limit: 413 up front (content-length) and mid-stream, no partial file left', async (t) => {
  const { urls, dirs } = await startPair(t, { maxBytes: 1024 });
  const tooBig = Buffer.alloc(4096, 1);
  const r = await upload(`${urls.laptop}/api/hosts/laptop/uploads?name=big.bin`, tooBig);
  assert.equal(r.status, 413);
  assert.match(r.body.error, /too large/);

  const chunked = new ReadableStream({
    start(c) {
      for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(512));
      c.close();
    },
  });
  const res = await fetch(`${urls.laptop}/api/hosts/laptop/uploads?name=big2.bin`, { method: 'POST', body: chunked, duplex: 'half' });
  assert.equal(res.status, 413);

  const viaPeer = await upload(`${urls.laptop}/api/hosts/workstation/uploads?name=big.bin`, tooBig);
  assert.equal(viaPeer.status, 413, 'the peer 413 passes through');

  assert.deepEqual(filesUnder(dirs.laptop), []);
  assert.deepEqual(filesUnder(dirs.workstation), []);
  // Exactly at the limit is fine.
  assert.equal((await upload(`${urls.laptop}/api/hosts/laptop/uploads?name=ok.bin`, Buffer.alloc(1024))).status, 200);
});

test('concurrent uploads with the same name never clobber each other', async (t) => {
  const { urls, dirs } = await startPair(t);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => upload(`${urls.laptop}/api/hosts/laptop/uploads?name=same.txt`, `content-${i}`)),
  );
  const paths = results.map((r) => r.body.path);
  assert.equal(new Set(paths).size, 8);
  results.forEach((r, i) => assert.equal(fs.readFileSync(r.body.path, 'utf8'), `content-${i}`));
  assert.equal(filesUnder(dirs.laptop).length, 8);
});

test('a random-prefix collision picks another prefix (wx, no overwrite)', async (t) => {
  const dir = tmpDir(t);
  const seq = ['aaaaaa', 'aaaaaa', 'bbbbbb'];
  const up = createUploader({ dir, random: () => seq.shift() });
  const { Readable } = await import('node:stream');
  const req = (text) => Object.assign(Readable.from([Buffer.from(text)]), { headers: {}, complete: true });
  const a = await up.store(req('first'), 'n.txt');
  const b = await up.store(req('second'), 'n.txt');
  assert.match(a.name, /^aaaaaa-n\.txt$/);
  assert.match(b.name, /^bbbbbb-n\.txt$/);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'first');
});

test('/api/settings advertises uploads.maxMB', async (t) => {
  const { urls } = await startPair(t);
  const res = await fetch(`${urls.laptop}/api/settings`);
  assert.deepEqual((await res.json()).uploads, { maxMB: 100 });
});
