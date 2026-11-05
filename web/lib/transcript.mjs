// Claude Code transcript reader: turns ~/.claude/projects/<cwd>/<session>.jsonl into a
// chat-like message list (user prompts + assistant text), dropping tool calls, tool
// results, thinking, hooks and bookkeeping entries.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { QUESTION_TOOL, normalizeQuestions, questionOutcome, questionsText } from './questions.mjs';

export const MAX_TAIL_BYTES = 6 * 1024 * 1024;
/** "Load older" grows the tail (doubling) up to this when it holds too few messages (screenshots bloat transcripts). */
export const MAX_GROWN_TAIL_BYTES = 64 * 1024 * 1024;

/** Mirror of the overmind CLI's `encode_cwd`: `/` and `.` become `-`. */
export function encodeCwd(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function transcriptPath(cwd, sessionId, home = claudeHome()) {
  return path.join(home, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

/** Find the transcript even when the session's cwd changed (worktrees, cd). */
export async function locateTranscript(cwd, sessionId, home = claudeHome()) {
  const direct = cwd ? transcriptPath(cwd, sessionId, home) : null;
  if (direct) {
    try {
      await fs.access(direct);
      return direct;
    } catch {
      /* fall through */
    }
  }
  const root = path.join(home, 'projects');
  let dirs = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

// ------------------------------------------------------------------ parsing

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function textOfContent(content, blockType = 'text') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === blockType && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function tag(text, name) {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return m ? m[1].trim() : null;
}

/** Classify one user-typed transcript entry. Returns null for entries not worth showing. */
export function classifyUserText(raw) {
  const text = raw.replace(SYSTEM_REMINDER_RE, '').trim();
  if (!text) return null;
  if (/^<(local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(text)) return null;
  // Slash commands and skills: `<command-name>` / `<command-message>` / `<command-args>` in either order.
  if (/^<command-(name|message)>/.test(text)) {
    const name = tag(text, 'command-name') ?? (tag(text, 'command-message') ? `/${tag(text, 'command-message')}` : '');
    const args = tag(text, 'command-args') ?? '';
    const shown = `${name}${args ? ` ${args}` : ''}`.trim();
    if (!shown) return null;
    return args ? { kind: 'command', text: shown, name, args } : { kind: 'command', text: shown, name };
  }
  // `! cmd` typed into Claude Code (its output is dropped like local-command stdout).
  if (text.startsWith('<bash-input>')) {
    const cmd = tag(text, 'bash-input') ?? '';
    return cmd ? { kind: 'command', text: `! ${cmd}`, name: '!', args: cmd } : null;
  }
  if (text.startsWith('<task-notification>')) {
    const summary = tag(text, 'summary') ?? 'Background task finished';
    return { kind: 'system', text: summary };
  }
  return { kind: 'user', text };
}

/**
 * Parse transcript JSONL text into ordered chat messages.
 *   { role: 'user'|'assistant'|'system', kind, text, ts, final? }
 * Assistant text blocks that end a turn (`stop_reason` != 'tool_use') are `final: true`;
 * interim narration between tool calls is `final: false`.
 * An AskUserQuestion call is `{ role: 'assistant', kind: 'question', id, questions, text }`
 * (`text`: a markdown fallback), plus `answers` or `declined: true` once it has a result.
 *
 * A prompt typed while Claude works is queued: `queue-operation` entries (enqueue / dequeue /
 * remove), then either a normal user entry (dequeued at the turn's end) or a `queued_command`
 * attachment (absorbed mid-turn). The attachment is a user message; prompts still in the queue
 * come last, `queued: true`.
 */
/** A Claude entry's `uuid` as the message's `ref`: where a branch is cut (lib/branch.mjs). */
const refOf = (entry) => (typeof entry.uuid === 'string' && entry.uuid ? { ref: entry.uuid } : {});

export function parseTranscript(text) {
  const out = [];
  let lastAssistantId = null;
  const asked = new Map(); // tool_use id -> its question message, until answered
  const queue = []; // { content, ts }, oldest first — task notifications too, for the FIFO dequeue
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) || null : null;

    if (entry.type === 'queue-operation') {
      if (entry.operation === 'enqueue') queue.push({ content: entry.content, ts });
      else if (entry.operation === 'dequeue') queue.shift();
      else if (entry.operation === 'remove') {
        const i = queue.findIndex((q) => q.content === entry.content);
        if (i >= 0) queue.splice(i, 1);
      }
      continue;
    }
    if (entry.type === 'attachment') {
      const a = entry.attachment;
      if (a?.type !== 'queued_command' || a.commandMode !== 'prompt' || (a.origin && a.origin.kind !== 'human')) continue;
      const classified = classifyUserText(textOfContent(a.prompt));
      if (!classified?.text?.trim()) continue;
      const { kind, ...rest } = classified;
      out.push({ role: kind === 'user' ? 'user' : 'system', kind, ...rest, ts });
      lastAssistantId = null;
      continue;
    }

    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;

    if (entry.type === 'user') {
      // A compaction writes its summary as a user entry, and a manual `/compact` also as plain text
      // just before it; the `<command-name>` entry after the summary is the one shown.
      if (entry.isMeta || entry.isCompactSummary || msg.content === '/compact') continue;
      if (asked.size && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          const q = b?.type === 'tool_result' ? asked.get(b.tool_use_id) : null;
          if (!q) continue;
          Object.assign(q, questionOutcome(q.questions, entry, b));
          asked.delete(b.tool_use_id);
        }
      }
      const raw = textOfContent(msg.content);
      if (!raw.trim()) continue; // pure tool_result
      const classified = classifyUserText(raw);
      if (!classified) continue;
      const { kind, ...rest } = classified;
      out.push({ role: kind === 'user' ? 'user' : 'system', kind, ...rest, ts, ...refOf(entry) });
      lastAssistantId = null;
      continue;
    }

    if (entry.type === 'assistant') {
      const body = textOfContent(msg.content).trim();
      if (body) {
        const final = msg.stop_reason !== 'tool_use';
        const prev = out[out.length - 1];
        // Streamed messages arrive as one JSONL line per block; glue blocks of the same
        // API message back together instead of showing them as separate bubbles.
        if (prev && prev.kind === 'assistant' && msg.id && msg.id === lastAssistantId) {
          prev.text = `${prev.text}\n\n${body}`;
          prev.final = prev.final || final;
          prev.ts = ts ?? prev.ts;
          if (entry.uuid) prev.ref = entry.uuid; // a branch from the bubble keeps all of it
        } else {
          out.push({ role: 'assistant', kind: 'assistant', text: body, ts, final, ...refOf(entry) });
        }
        lastAssistantId = msg.id ?? null;
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== 'tool_use' || b.name !== QUESTION_TOOL || !b.id) continue;
        const questions = normalizeQuestions(b.input);
        if (!questions) continue;
        const q = { role: 'assistant', kind: 'question', id: b.id, questions, text: questionsText(questions), ts, final: true, ...refOf(entry) };
        out.push(q);
        asked.set(b.id, q);
        lastAssistantId = null;
      }
    }
  }
  for (const q of queue) {
    const raw = textOfContent(q.content);
    if (raw.startsWith('<agent-message')) continue; // a subagent's hand-back, not something typed
    const classified = classifyUserText(raw);
    if (classified?.kind === 'user' && classified.text.trim()) out.push({ role: 'user', kind: 'user', text: classified.text, ts: q.ts, queued: true });
  }
  return out;
}

// ------------------------------------------------------------------ Codex and pi

/**
 * A Codex rollout line has no id of its own: a message's `ref` (what a branch is cut at, see
 * lib/branch.mjs) is a hash of its raw line, stable however much of the file was read.
 */
export function codexRef(line) {
  return `c-${createHash('sha1').update(line).digest('hex').slice(0, 16)}`;
}

/**
 * Text of a Codex `message` payload: a user's `input_text` parts, an assistant's `output_text`
 * ones. crates/overmind/src/core/stack.rs `codex_text` mirrors it: change them together.
 */
export function codexMessageText(payload) {
  return textOfContent(payload?.content, payload?.role === 'user' ? 'input_text' : 'output_text');
}

/**
 * Codex wraps its own context (AGENTS.md, environment, permissions) in user messages.
 * crates/overmind/src/core/stack.rs `is_codex_context` mirrors it: change them together.
 */
export function isCodexContext(text) {
  return text.startsWith('<') || text.startsWith('# AGENTS.md');
}

/**
 * Codex rollout JSONL (`~/.codex/sessions/…/rollout-*.jsonl`) → chat messages, same shape as
 * parseTranscript. Assistant text is `final` unless a tool call follows it within the turn.
 */
export function parseCodexTranscript(text) {
  const out = [];
  let lastAssistant = null; // the turn's latest assistant message, until a tool call or user turn
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const p = entry?.payload;
    if (!p || typeof p !== 'object') continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) || null : null;
    if (entry.type === 'response_item' && p.type === 'message') {
      const body = codexMessageText(p).trim();
      if (!body) continue;
      if (p.role === 'user') {
        if (isCodexContext(body)) continue;
        out.push({ role: 'user', kind: 'user', text: body, ts, ref: codexRef(line) });
        lastAssistant = null;
      } else if (p.role === 'assistant') {
        lastAssistant = { role: 'assistant', kind: 'assistant', text: body, ts, final: true, ref: codexRef(line) };
        out.push(lastAssistant);
      }
      continue;
    }
    if (entry.type === 'response_item' && /call$/.test(p.type ?? '') && lastAssistant) {
      lastAssistant.final = false; // narration before a tool call
      lastAssistant = null;
    }
  }
  return out;
}

/** pi session JSONL (`~/.pi/agent/sessions/<cwd>/*.jsonl`) → chat messages. */
export function parsePiTranscript(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'message') continue;
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) || null : null;
    const body = textOfContent(msg.content).trim();
    if (!body) continue;
    if (msg.role === 'user') out.push({ role: 'user', kind: 'user', text: body, ts });
    else if (msg.role === 'assistant') {
      out.push({ role: 'assistant', kind: 'assistant', text: body, ts, final: msg.stopReason !== 'toolUse' });
    }
  }
  return out;
}

const PARSERS = { claude: parseTranscript, codex: parseCodexTranscript, pi: parsePiTranscript };

/** The chat parser for a row's harness (Claude's for an unknown one). */
export function parserFor(harness) {
  return PARSERS[harness] ?? parseTranscript;
}

// ------------------------------------------------------------------ deltas (#37)

/** An unanswered question with more messages than this after it counts as settled (bandwidth only: see build()). */
export const QUESTION_CAP = 20;
/** The anchored span is re-anchored (a new generation) once it holds this many times its tail size. */
export const REANCHOR_FACTOR = 1.5;
/** Raw bytes before the cached size, compared on the next read: a mismatch = truncated and regrown, or rewritten. */
const PROBE_BYTES = 8 * 1024;
const CURSOR_RE = /^([0-9a-z.]{1,40}):(\d+):(\d+):([0-9a-f]{16}):(\d+)$/;

/**
 * The index of the first message a later transcript line could still change (`all.length` when
 * none): what a client may keep once it has it. Claude: the last bubble while it can still be
 * glued (`parseTranscript`'s streaming), an unanswered question (its tool_result adds `answers`)
 * unless more than QUESTION_CAP messages followed it, and the queued suffix. Codex: the last
 * reply (`final` flips on a tool call). pi: nothing.
 */
export function stableIndex(harness, all) {
  if (harness === 'pi') return all.length;
  const last = all.length - 1;
  if (harness === 'codex') return last >= 0 && all[last].kind === 'assistant' ? last : all.length;
  let firstQueued = all.findIndex((m) => m.queued);
  if (firstQueued < 0) firstQueued = all.length;
  let stable = firstQueued > 0 && all[firstQueued - 1].kind === 'assistant' ? firstQueued - 1 : firstQueued;
  for (let i = Math.max(0, firstQueued - 1 - QUESTION_CAP); i < stable; i++) {
    const m = all[i];
    if (m.kind === 'question' && !m.answers && !m.declined) {
      stable = i;
      break;
    }
  }
  return stable;
}

const feed = (h, all, from, to) => {
  for (let i = from; i < to; i++) h.update(JSON.stringify(all[i])).update('\n');
};
const digest16 = (h) => h.digest('hex').slice(0, 16);

// A generation is this process's nonce + a counter: never reused in-process (no A→B→A), and a
// restarted server cannot answer an old cursor as its own (the cursor is a resume token, #40).
const GEN_NONCE = randomBytes(8).toString('hex');
let genSeq = 0;
const newGen = () => `${GEN_NONCE}.${(++genSeq).toString(36)}`;

/**
 * A parsed message list → its delta bookkeeping: `stable`, the hash of what is below it
 * (`prefixHash`) and of the rest (`tailHash`). With `prev` (the same anchored span, read before)
 * the generation is kept only when everything below the previous `stable` is unchanged — any
 * mutation down there (a capped question answered late, a parser rule added later) mints a new
 * one, so a client never keeps a message the server changed.
 */
export function snapshotEntry(messages, { harness = 'claude', gen = null, truncated = false, prev = null } = {}) {
  const stable = stableIndex(harness, messages);
  let h = createHash('sha1');
  let i = 0;
  let keep = !!prev && stable >= prev.stable && messages.length >= prev.stable;
  if (keep) {
    feed(h, messages, 0, prev.stable);
    i = prev.stable;
    keep = digest16(h.copy()) === prev.prefixHash;
  }
  if (!keep) {
    h = createHash('sha1');
    i = 0;
  }
  feed(h, messages, i, stable);
  const tail = createHash('sha1');
  feed(tail, messages, stable, messages.length);
  return {
    messages,
    truncated,
    gen: keep ? prev.gen : (gen ?? newGen()),
    stable,
    prefixHash: digest16(h),
    tailHash: digest16(tail),
  };
}

function parseCursor(after) {
  const m = typeof after === 'string' ? CURSOR_RE.exec(after) : null;
  return m ? { gen: m[1], stable: Number(m[2]), total: Number(m[3]), tailHash: m[4], limit: Number(m[5]) } : null;
}

/**
 * One answer to a poll carrying `after` (the cursor of the previous answer; '' or null = none):
 * `full` (the last `limit` messages), "same" (`full: false`, `from === total`, no messages) or a
 * delta (`full: false`, the messages from `from` on — the client keeps what it has before `from`).
 * A cursor of another generation or limit, a gap longer than the window, or a window the client
 * could not rebuild (the total shrank) is answered full.
 */
export function sliceDelta(entry, { limit, after }) {
  const all = entry.messages;
  const total = all.length;
  const want = Math.max(0, total - limit);
  const cursor = `${entry.gen}:${entry.stable}:${total}:${entry.tailHash}:${limit}`;
  const c = parseCursor(after);
  let full = true;
  let from = want;
  if (c && c.gen === entry.gen && c.limit === limit) {
    if (c.stable === entry.stable && c.total === total && c.tailHash === entry.tailHash) {
      full = false;
      from = total;
    } else {
      // The client's numbers are not trusted past what it can hold and what is stable here.
      const f = Math.min(c.stable, c.total, entry.stable, total);
      // It holds [clientBase, c.total); keeping its messages below `f` must rebuild [want, total).
      const clientBase = Math.max(0, c.total - limit);
      if (total - f <= limit && (f <= want || clientBase <= want)) {
        full = false;
        from = f;
      }
    }
  }
  return { full, from, messages: all.slice(from), total, stable: entry.stable, cursor, truncated: entry.truncated || total > limit, all };
}

// ------------------------------------------------------------------ service

/**
 * Cached transcript reader. `messages(session, limit)` returns the last `limit` chat
 * messages of a `overmind list --json` session object ({ session_id, cwd }); `delta(session,
 * { limit, after })` answers a poll with only what changed since the cursor `after` (#37).
 *
 * A session's cache holds one anchored span `[startOffset, size)` of its file, parsed whole: a
 * file that only grew is re-read from the same `startOffset`, so message indices stay put (a
 * generation, `gen`, names that index space). Anything else — shrunk, replaced, rewritten in
 * place, a grown tail for a larger limit, a span past REANCHOR_FACTOR × its tail size — reads a
 * fresh tail under a new generation, and cursors of the old one are answered full.
 */
export function createTranscriptReader({ home = claudeHome(), maxBytes = MAX_TAIL_BYTES, maxGrownBytes = MAX_GROWN_TAIL_BYTES } = {}) {
  const cache = new Map(); // sessionId -> { file, ino, size, mtimeMs, startOffset, bytes, probe, messages, truncated, gen, stable, prefixHash, tailHash }
  const loading = new Map(); // sessionId -> the in-flight load: overlapping polls wait, then re-check
  const counters = { reads: 0, parses: 0 };

  /** Read `[startOf(size), size)` of the file as it is now. */
  async function readFrom(file, startOf) {
    const fh = await fs.open(file, 'r');
    try {
      const st = await fh.stat();
      const start = Math.min(st.size, Math.max(0, startOf(st.size)));
      const buf = Buffer.alloc(st.size - start);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, start + n);
        if (!bytesRead) break;
        n += bytesRead;
      }
      counters.reads += 1;
      return { buf: buf.subarray(0, n), start, size: start + n, mtimeMs: st.mtimeMs, ino: st.ino };
    } finally {
      await fh.close();
    }
  }

  function build(harness, file, read, { startOffset, bytes, prev }) {
    const span = read.buf.subarray(startOffset - read.start);
    counters.parses += 1;
    const messages = PARSERS[harness](span.toString('utf8'));
    const entry = snapshotEntry(messages, { harness, truncated: startOffset > 0, prev });
    const probe = Buffer.from(span.subarray(Math.max(0, span.length - PROBE_BYTES)));
    return { file, ino: read.ino, size: read.size, mtimeMs: read.mtimeMs, startOffset, bytes, probe, ...entry };
  }

  const enough = (d, limit) => !d.truncated || d.messages.length >= limit || d.bytes >= maxGrownBytes;

  /** A fresh tail under a new generation, grown (doubling) until it holds `limit` messages. */
  async function fromScratch(harness, file, limit, cached) {
    // A tail of `bytes` can hold only a few messages when tool results are huge: grow it until
    // it holds `limit` of them, reaches the file start, or hits the cap.
    let bytes = Math.max(maxBytes, cached?.bytes ?? 0);
    for (;;) {
      const read = await readFrom(file, (size) => size - bytes);
      let skip = 0;
      if (read.start > 0) {
        const nl = read.buf.indexOf(0x0a);
        skip = nl === -1 ? read.buf.length : nl + 1; // drop the leading partial line
      }
      const fresh = build(harness, file, read, { startOffset: read.start + skip, bytes, prev: null });
      if (enough(fresh, limit)) return fresh;
      bytes = Math.min(bytes * 2, maxGrownBytes);
    }
  }

  /** The cached span re-read from its anchor; null when it cannot continue the generation. */
  async function anchored(harness, file, cached) {
    const read = await readFrom(file, () => cached.startOffset);
    if (read.ino !== cached.ino || read.size < cached.size) return null;
    const end = cached.size - read.start;
    if (!read.buf.subarray(end - cached.probe.length, end).equals(cached.probe)) return null;
    if (read.size - cached.startOffset > REANCHOR_FACTOR * cached.bytes) return null;
    return build(harness, file, read, { startOffset: cached.startOffset, bytes: cached.bytes, prev: cached });
  }

  async function doLoad(session, limit) {
    const id = session.session_id;
    const harness = PARSERS[session.harness] ? session.harness : 'claude';
    const cached = cache.get(id);
    // Codex / pi: discovery names the file; Claude's is found from cwd + id.
    const file =
      harness === 'claude'
        ? (cached?.file ?? (await locateTranscript(session.cwd, id, home)))
        : typeof session.transcript === 'string' && session.transcript
          ? session.transcript
          : null;
    if (!file) return null;
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      cache.delete(id);
      return null;
    }
    let next = null;
    const same = cached && cached.file === file && cached.ino === stat.ino;
    const rewritten = !same || stat.size < cached.size || stat.mtimeMs < cached.mtimeMs || (stat.size === cached.size && stat.mtimeMs !== cached.mtimeMs);
    if (!rewritten && enough(cached, limit)) {
      if (stat.size === cached.size) return cached;
      next = await anchored(harness, file, cached);
      // The span can hold fewer than before (a queued prompt removed): grow it now, not next poll.
      if (next && !enough(next, limit)) next = null;
    }
    next ??= await fromScratch(harness, file, limit, cached);
    cache.set(id, next);
    return next;
  }

  /** One load per session at a time: a poll that overlaps another waits for it, then re-checks (usually: no read). */
  async function load(session, limit) {
    const id = session.session_id;
    while (loading.has(id)) await loading.get(id).catch(() => {});
    const p = doLoad(session, limit);
    loading.set(id, p);
    try {
      return await p;
    } finally {
      if (loading.get(id) === p) loading.delete(id);
    }
  }

  return {
    async messages(session, limit = 60) {
      const data = await load(session, limit);
      if (!data) return null;
      const total = data.messages.length;
      const slice = limit > 0 ? data.messages.slice(-limit) : data.messages;
      return { messages: slice, total, truncated: data.truncated || slice.length < total, file: data.file, updatedAt: data.mtimeMs };
    },
    /** `messages` for a poll that carries a cursor: see sliceDelta. `all` is the cached list (not for the wire). */
    async delta(session, { limit = 60, after = null } = {}) {
      const data = await load(session, limit);
      if (!data) return null;
      return { ...sliceDelta(data, { limit, after }), file: data.file, updatedAt: data.mtimeMs };
    },
    /** Reads and parses so far (tests: "an unchanged poll reads nothing"). */
    stats: () => ({ ...counters }),
  };
}
