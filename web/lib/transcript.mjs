// Claude Code transcript reader: turns ~/.claude/projects/<cwd>/<session>.jsonl into a
// chat-like message list (user prompts + assistant text), dropping tool calls, tool
// results, thinking, hooks and bookkeeping entries.
import { createHash } from 'node:crypto';
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

/** Read at most the last `maxBytes` of a file, dropping a leading partial line. */
export async function readTail(file, maxBytes = MAX_TAIL_BYTES) {
  const stat = await fs.stat(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return { text, truncated: start > 0, size: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    await fh.close();
  }
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

/** Codex wraps its own context (AGENTS.md, environment, permissions) in user messages. */
function isCodexContext(text) {
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
      const body = textOfContent(p.content, p.role === 'user' ? 'input_text' : 'output_text').trim();
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

// ------------------------------------------------------------------ service

/**
 * Cached transcript reader. `messages(session, limit)` returns the last `limit` chat
 * messages of a `overmind list --json` session object ({ session_id, cwd }).
 */
export function createTranscriptReader({ home = claudeHome(), maxBytes = MAX_TAIL_BYTES, maxGrownBytes = MAX_GROWN_TAIL_BYTES } = {}) {
  const cache = new Map(); // sessionId -> { file, size, mtimeMs, bytes, messages, truncated }

  async function load(session, limit) {
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
    const enough = (d) => !d.truncated || d.messages.length >= limit || d.bytes >= maxGrownBytes;
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && enough(cached)) return cached;
    // A tail of `bytes` can hold only a few messages when tool results are huge: grow it until
    // it holds `limit` of them, reaches the file start, or hits the cap.
    let bytes = Math.max(maxBytes, cached?.bytes ?? 0);
    let fresh;
    for (;;) {
      const tail = await readTail(file, bytes);
      fresh = { file, size: tail.size, mtimeMs: tail.mtimeMs, bytes, truncated: tail.truncated, messages: PARSERS[harness](tail.text) };
      if (enough(fresh)) break;
      bytes = Math.min(bytes * 2, maxGrownBytes);
    }
    cache.set(id, fresh);
    return fresh;
  }

  return {
    async messages(session, limit = 60) {
      const data = await load(session, limit);
      if (!data) return null;
      const total = data.messages.length;
      const slice = limit > 0 ? data.messages.slice(-limit) : data.messages;
      return { messages: slice, total, truncated: data.truncated || slice.length < total, file: data.file, updatedAt: data.mtimeMs };
    },
  };
}
