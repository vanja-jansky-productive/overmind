// Claude's built-in model picker lives in three places: the CLI (core::harness::CLAUDE_FAMILIES),
// the web server (lib/config.mjs DEFAULT_MODELS) and the UI (ui/src/lib/models.ts). Keep them in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MODELS } from '../lib/config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function rustModels() {
  const src = fs.readFileSync(path.join(repo, 'crates/overmind/src/core/harness.rs'), 'utf8');
  const table = src.match(/pub const CLAUDE_FAMILIES[^=]*=\s*\[([\s\S]*?)\];/)?.[1];
  assert.ok(table, 'CLAUDE_FAMILIES not found in harness.rs');
  const rows = [...table.matchAll(/\("([a-z]+)",\s*"([^"]+)",\s*\((\d+),\s*(?:Some\((\d+)\)|None)\)\)/g)];
  return [
    { id: '', label: 'Default' },
    ...rows.map(([, id, label, major, minor]) => ({ id, label: `${label} ${minor == null ? major : `${major}.${minor}`}` })),
  ];
}

function uiModels() {
  const src = fs.readFileSync(path.join(repo, 'web/ui/src/lib/models.ts'), 'utf8');
  const list = src.match(/export const DEFAULT_MODELS[^=]*=\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(list, 'DEFAULT_MODELS not found in models.ts');
  return [...list.matchAll(/\{\s*id:\s*'([^']*)',\s*label:\s*'([^']*)'\s*\}/g)].map(([, id, label]) => ({ id, label }));
}

test('the CLI, server and UI offer the same built-in Claude models', () => {
  assert.deepEqual(DEFAULT_MODELS, rustModels());
  assert.deepEqual(uiModels(), DEFAULT_MODELS);
});

test('the built-in Claude picker offers aliases, so it always starts the newest model', () => {
  assert.deepEqual(DEFAULT_MODELS.map((m) => m.id), ['', 'fable', 'opus', 'sonnet', 'haiku']);
});
