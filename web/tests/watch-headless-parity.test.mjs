// The watcher's headless filter (lib/watch.mjs isHeadless) mirrors the CLI's (core/discovery.rs:
// HEADLESS_ENTRYPOINTS, is_headless and the `kind != "interactive"` skip). Keep them in step: a drift
// costs only extra lists one way, but hides a real session's registry events the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HEADLESS_ENTRYPOINTS, isHeadless } from '../lib/watch.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(repo, 'crates/overmind/src/core/discovery.rs'), 'utf8');

test('the same headless entrypoints as discovery.rs', () => {
  const list = src.match(/const HEADLESS_ENTRYPOINTS[^=]*=\s*\[([\s\S]*?)\];/)?.[1];
  assert.ok(list, 'HEADLESS_ENTRYPOINTS not found in discovery.rs');
  const rust = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...HEADLESS_ENTRYPOINTS].sort(), rust.sort());
});

test('the same rules as is_headless and the kind skip', () => {
  const body = src.match(/fn is_headless\(entrypoint: &str\) -> bool \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'is_headless not found in discovery.rs');
  assert.match(body, /HEADLESS_ENTRYPOINTS\.contains\(&entrypoint\)\s*\|\|\s*entrypoint\.starts_with\("sdk-"\)/, 'is_headless changed: update lib/watch.mjs');
  assert.match(src, /reg\.kind\.as_deref\(\)\.is_some_and\(\|k\| k != "interactive"\)/, 'the kind skip changed: update lib/watch.mjs');
  assert.equal(isHeadless({ kind: 'interactive', entrypoint: 'sdk-new' }), true, 'sdk- prefix');
  assert.equal(isHeadless({ kind: 'print', entrypoint: 'cli' }), true, 'kind other than interactive');
  assert.equal(isHeadless({ kind: 'interactive', entrypoint: 'claude-vscode' }), false, 'unknown entrypoints are kept');
  assert.equal(isHeadless({ entrypoint: 'cli' }), false, 'no kind: kept');
});
