// Absolute file paths a session actually touched, read from its transcript: the `file_path` /
// `path` / `notebook_path` inputs of its tool calls (Read, Edit, Write, Grep, Glob, …) and, as
// a weaker hint, absolute paths printed in tool results. Shell commands count too: files a
// command writes (`> f`, `tee f`, resolved against a leading `cd <dir>`) as touched, other
// absolute paths in it as hints. lib/files.mjs uses them to resolve a
// relative mention ("Updated docs/x.md") that is relative to another repo than the cwd.
// A Codex row reads its rollout (the path discovery puts on the row) instead: the files its
// completed `FileChange` items changed and its `CommandExecution` commands (run in their own cwd).
// A pi row has no index yet.
// Parsed incrementally: each call reads only what the transcript grew by since the last one.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeHome, locateTranscript } from './transcript.mjs';

/** On the first read of a transcript, only its last this-many bytes are scanned. */
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;
/** Paths remembered per session (the oldest are dropped past this). */
export const MAX_TOUCHED = 2000;
const MAX_RESULT_PATHS = 50; // absolute paths taken from one tool_result
const MAX_SESSIONS = 200;
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
// An absolute path in free text: starts after whitespace / quote / line start, no spaces.
const ABS_IN_TEXT = /(?:^|[\s"'`(=:])(\/[^\s"'`()<>|;,*?]+)/g;

/** Tier: 2 = a tool input (the session worked on it), 1 = seen in a tool result. */
function add(state, p, tier) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || p.includes('\0') || /^\/(?:dev|proc)\//.test(p)) return;
  const clean = p.replace(/\/+$/, '');
  if (!clean) return;
  const prev = state.paths.get(clean);
  if (prev && prev.tier > tier) return; // a mere mention doesn't bump a file the session worked on
  const next = { seq: ++state.seq, tier: Math.max(tier, prev?.tier ?? 0) };
  state.paths.delete(clean); // re-insert: Map order = recency
  state.paths.set(clean, next);
  if (state.paths.size > MAX_TOUCHED) state.paths.delete(state.paths.keys().next().value);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

const unquote = (t) => t.replace(/^(['"])(.*)\1$/, '$2');
const TOKEN = String.raw`("[^"]*"|'[^']*'|[^\s;&|<>()]+)`;
const CD_RE = new RegExp(String.raw`(?:^|[;&|(]\s*|\s)cd\s+${TOKEN}`, 'g');
const WRITE_RE = new RegExp(String.raw`(?:[^<>&\d]|^)\d?>>?\s*${TOKEN}|\btee\s+(?:-a\s+)?${TOKEN}`, 'g');

/** `~/x` → $HOME/x, absolute stays, anything else → null. */
function absOf(t, home) {
  if (t.startsWith('~/')) return path.join(home, t.slice(2));
  return t.startsWith('/') ? path.normalize(t) : null;
}

/** A shell command: written files (tier 2, `cd`-relative too), absolute paths in it (tier 1). */
export function ingestCommand(state, cmd, home = os.homedir()) {
  if (typeof cmd !== 'string' || cmd.length > 100_000) return;
  let n = 0;
  for (const m of cmd.matchAll(ABS_IN_TEXT)) {
    add(state, m[1].replace(/[.:]+$/, ''), 1);
    if (++n >= MAX_RESULT_PATHS) break;
  }
  // The last `cd` before a redirect sets the dir its relative target is in (a good-enough read).
  const cds = [...cmd.matchAll(CD_RE)].map((m) => ({ at: m.index, dir: absOf(unquote(m[1]), home) }));
  for (const m of cmd.matchAll(WRITE_RE)) {
    const target = unquote(m[1] ?? m[2] ?? '');
    if (!target || target === '/dev/null' || target.startsWith('&') || target.startsWith('$')) continue;
    let abs = absOf(target, home);
    if (!abs && !target.startsWith('~')) {
      const cd = cds.filter((c) => c.at < m.index).pop();
      if (cd?.dir) abs = path.join(cd.dir, target);
    }
    if (abs) add(state, abs, 2);
  }
}

// ------------------------------------------------------------------ Codex rollouts

/** A Codex rollout line's completed item (`event_msg` / `item_completed`), or null. */
export function codexItem(line) {
  if (!line || !line.includes('"item_completed"')) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const item = entry?.type === 'event_msg' && entry.payload?.type === 'item_completed' ? entry.payload.item : null;
  return item && typeof item === 'object' ? item : null;
}

/** A Codex item's cwd (`file:///…` or a path) → an absolute path, else null. */
function codexCwd(cwd) {
  if (typeof cwd !== 'string') return null;
  let p = cwd;
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return null;
    }
  }
  return p.startsWith('/') && !p.includes("'") ? path.normalize(p) : null;
}

/** A `CommandExecution`'s script (`[shell, -lc, script]`), its cwd made a leading `cd` so relative writes resolve. */
export function codexCommand(item) {
  const argv = item?.command;
  let script = null;
  if (typeof argv === 'string') script = argv;
  else if (Array.isArray(argv) && argv.every((a) => typeof a === 'string')) {
    script = argv.length >= 3 && /^-l?c$/.test(argv[argv.length - 2]) ? argv[argv.length - 1] : argv.join(' ');
  }
  if (!script) return null;
  const cwd = codexCwd(item.cwd);
  return { script, text: cwd ? `cd '${cwd}' && ${script}` : script };
}

/**
 * The paths a completed Codex item touched → [{ path, tier }]: its `FileChange` targets (not
 * deletes) and the files its `CommandExecution` command wrote (tier 2), other absolute paths in
 * that command and its output (tier 1). One walk of the rollout's item shapes, shared with
 * lib/brief-extract.mjs (which keeps tier 2: what the session made).
 */
export function codexTouchedPaths(item, home = os.homedir()) {
  const st = { paths: new Map(), seq: 0 };
  if (item?.type === 'FileChange' && item.changes && typeof item.changes === 'object') {
    for (const [p, c] of Object.entries(item.changes)) if (c?.type !== 'delete') add(st, p, 2);
  } else if (item?.type === 'CommandExecution') {
    const cmd = codexCommand(item);
    if (cmd) ingestCommand(st, cmd.text, home);
    const out = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
    let n = 0;
    if (out.includes('/')) {
      for (const m of out.matchAll(ABS_IN_TEXT)) {
        add(st, m[1].replace(/[.:]+$/, ''), 1);
        if (++n >= MAX_RESULT_PATHS) break;
      }
    }
  }
  return [...st.paths].map(([p, v]) => ({ path: p, tier: v.tier }));
}

/** Feed one Codex rollout line. */
export function ingestCodexLine(state, line, home = os.homedir()) {
  const item = codexItem(line);
  if (item) for (const t of codexTouchedPaths(item, home)) add(state, t.path, t.tier);
}

/** Feed one JSONL line. */
export function ingestLine(state, line, home = os.homedir()) {
  if (!line || !line.includes('"tool_')) return; // cheap skip: only tool_use / tool_result lines matter
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
      for (const k of PATH_KEYS) add(state, block.input[k], 2);
      if (typeof block.input.command === 'string') ingestCommand(state, block.input.command, home);
      if (Array.isArray(block.input.edits)) for (const e of block.input.edits) if (e) for (const k of PATH_KEYS) add(state, e[k], 2);
    } else if (block.type === 'tool_result') {
      const text = textOf(block.content);
      if (!text || !text.includes('/')) continue;
      let n = 0;
      for (const m of text.matchAll(ABS_IN_TEXT)) {
        add(state, m[1].replace(/[.:]+$/, ''), 1);
        if (++n >= MAX_RESULT_PATHS) break;
      }
    }
  }
}

/**
 * @param {object} [opts]
 *   home       Claude's config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
 *   maxBytes   first-read scan cap (default MAX_SCAN_BYTES)
 *   locate     (cwd, sessionId) → transcript path | null (default lib/transcript.mjs)
 *   userHome   what `~` in shell commands means (default os.homedir())
 */
export function createTouchedIndex({ home = claudeHome(), maxBytes = MAX_SCAN_BYTES, locate, userHome = os.homedir() } = {}) {
  const findTranscript = locate ?? ((cwd, id) => locateTranscript(cwd, id, home));
  const states = new Map(); // sessionId → { file, offset, size, mtimeMs, seq, paths }

  async function read(file, start, end) {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async function refresh(session) {
    const id = session?.session_id;
    if (!id) return null;
    let st = states.get(id);
    // Codex: discovery names the file; Claude's is found from cwd + id. pi: no parser for its
    // tool calls yet, so no index (not its file read as a Claude one).
    if (session.harness === 'pi') return null;
    const codex = session.harness === 'codex';
    const file = st?.file ?? (codex ? (typeof session.transcript === 'string' && session.transcript) || null : await findTranscript(session.cwd ?? null, id));
    if (!file) return null;
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      states.delete(id);
      return null;
    }
    // Shrunk or replaced → start over.
    if (!st || stat.size < st.offset) {
      st = { file, offset: 0, size: 0, mtimeMs: 0, seq: 0, paths: new Map() };
      if (states.size >= MAX_SESSIONS) states.delete(states.keys().next().value);
      states.set(id, st);
    }
    if (stat.size === st.size && stat.mtimeMs === st.mtimeMs) return st;
    let start = st.offset;
    let skipPartial = false;
    if (start === 0 && stat.size > maxBytes) {
      start = stat.size - maxBytes;
      skipPartial = true;
    }
    if (stat.size > start) {
      const buf = await read(file, start, stat.size);
      let from = 0;
      if (skipPartial) {
        const nl = buf.indexOf(0x0a);
        from = nl === -1 ? buf.length : nl + 1;
      }
      const lastNl = buf.lastIndexOf(0x0a);
      const upto = lastNl >= from ? lastNl + 1 : from; // an unfinished last line waits for the next read
      const ingest = codex ? ingestCodexLine : ingestLine;
      for (const line of buf.subarray(from, upto).toString('utf8').split('\n')) ingest(st, line, userHome);
      st.offset = start + upto;
    }
    st.size = stat.size;
    st.mtimeMs = stat.mtimeMs;
    return st;
  }

  return {
    /**
     * → { version, paths: [abs], worked: [abs] } — tool inputs first, then result mentions; most
     * recent first within each; `worked`: the tool inputs alone (files the session read, edited
     * or wrote). `version` changes whenever the transcript grew. null without a transcript.
     */
    async get(session) {
      const st = await refresh(session).catch(() => null);
      if (!st) return null;
      const version = `${st.file}:${st.offset}`;
      if (st.list?.version !== version) {
        const all = [...st.paths.entries()].reverse();
        const worked = all.filter(([, v]) => v.tier === 2).map(([p]) => p);
        const paths = [...worked, ...all.filter(([, v]) => v.tier < 2).map(([p]) => p)];
        st.list = { version, paths, worked };
      }
      return st.list;
    },
  };
}
