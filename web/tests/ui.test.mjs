// Static UI selection (web/ui/dist or web.ui) and cache headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cacheControlFor, createHttpServer } from '../lib/app.mjs';
import { CLASSIC_UI, normalizeConfig, resolveUiDir } from '../lib/config.mjs';

const HOME = '/home/tester';

function tmpWebRoot(t, { built }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-web-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ui', 'dist', 'assets'), { recursive: true });
  if (built) {
    fs.writeFileSync(path.join(root, 'ui', 'dist', 'index.html'), '<p>new ui</p>');
    fs.writeFileSync(path.join(root, 'ui', 'dist', 'assets', 'index-R-dVrV7d.js'), 'console.log(1)');
  }
  return root;
}

test('resolveUiDir: ui/dist, built or not', (t) => {
  const built = tmpWebRoot(t, { built: true });
  assert.equal(resolveUiDir(null, { webRoot: built, home: HOME }), path.join(built, 'ui', 'dist'));
  const unbuilt = tmpWebRoot(t, { built: false });
  assert.equal(resolveUiDir(null, { webRoot: unbuilt, home: HOME }), path.join(unbuilt, 'ui', 'dist'), 'placeholder until built');
  assert.equal(resolveUiDir(null, { webRoot: null, home: HOME }), null);
});

test('resolveUiDir: explicit paths override, the retired "classic" means the default', (t) => {
  const built = tmpWebRoot(t, { built: true });
  assert.equal(resolveUiDir(CLASSIC_UI, { webRoot: built, home: HOME }), path.join(built, 'ui', 'dist'));
  assert.equal(resolveUiDir('~/my-ui', { webRoot: built, home: HOME }), `${HOME}/my-ui`);
  assert.equal(resolveUiDir('/srv/ui', { webRoot: built, home: HOME }), '/srv/ui');
});

test('normalizeConfig: web.ui / OVERMIND_WEB_UI pick the UI dir', (t) => {
  const built = tmpWebRoot(t, { built: true });
  const opts = (env = {}) => ({ env, home: HOME, webRoot: built });
  assert.equal(normalizeConfig({}, opts()).uiDir, path.join(built, 'ui', 'dist'));
  assert.equal(normalizeConfig({ web: { ui: 'classic' } }, opts()).uiDir, path.join(built, 'ui', 'dist'));
  assert.equal(normalizeConfig({ web: { ui: '/y' } }, opts()).uiDir, '/y');
  assert.equal(normalizeConfig({ web: { ui: '/y' } }, opts({ OVERMIND_WEB_UI: '/x' })).uiDir, '/x', 'env beats config');
});

test('cacheControlFor: hashed /assets/ files are immutable, the rest revalidates', () => {
  const immutable = 'public, max-age=31536000, immutable';
  assert.equal(cacheControlFor('/assets/index-R-dVrV7d.js'), immutable);
  assert.equal(cacheControlFor('/assets/index-DxY_12ab.css'), immutable);
  assert.equal(cacheControlFor('/assets/fonts/geist-Ab12Cd34.woff2'), immutable);
  for (const p of ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/app.js', '/style.css', '/assets/logo.svg', '/x/index-R-dVrV7d.js']) {
    assert.equal(cacheControlFor(p), 'no-cache', p);
  }
});

test('server: new UI index is no-cache, hashed assets immutable (also on 304)', async (t) => {
  const root = tmpWebRoot(t, { built: true });
  const uiDir = resolveUiDir(null, { webRoot: root, home: HOME });
  const server = createHttpServer({ handleApi: async () => ({ status: 404, body: { error: 'x' } }), uiDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const index = await fetch(`${base}/`);
  assert.equal(await index.text(), '<p>new ui</p>');
  assert.equal(index.headers.get('cache-control'), 'no-cache');

  const asset = await fetch(`${base}/assets/index-R-dVrV7d.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = asset.headers.get('etag');
  await asset.text();
  const again = await fetch(`${base}/assets/index-R-dVrV7d.js`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const missing = await fetch(`${base}/assets/index-00000000.js`);
  assert.equal(missing.status, 404, 'a stale hashed asset is a 404, not index.html');
  await missing.text();
});
