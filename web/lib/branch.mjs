// Branch a session at one of its messages: a new session whose history is the conversation up
// to and including that message, the source left as it is (like pi's /fork, for Claude Code and
// Codex). Each chat message carries a `ref` (lib/transcript.mjs) naming where to cut.
//
// - Same agent: the transcript is copied, cut, under a new session id, and the new session
//   resumes it (`claude --resume <id>`, `codex resume <id>`) — tool calls and all.
//   Claude: entries are a tree (`uuid` / `parentUuid`); the copy is the chain from the message
//   up to the root (a compaction boundary ends the chain, as it ends Claude's context).
//   Codex: a rollout is linear; the copy is every line through the message's turn.
// - Other agent: the conversation (prompts and replies, no tool calls) is written to a markdown
//   file the new session is told to read as its own history.
//
// Branching from a *prompt* (a user message) cuts just before it and sends it again as the new
// session's first prompt (editable: `prompt`), so the new agent / model answers it. Branching
// from a *reply* cuts after it; `prompt`, when given, is the first message of the new session.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MODEL_ID_RE } from './config.mjs';
import { sanitizeName } from './spawn.mjs';
import { claudeHome, codexRef, encodeCwd, locateTranscript, parseCodexTranscript, parseTranscript } from './transcript.mjs';

/** The agents a branch can come from or go to. */
export const BRANCH_HARNESSES = ['claude', 'codex'];
const LABELS = { claude: 'Claude Code', codex: 'Codex' };
const REF_RE = /^[A-Za-z0-9-]{1,64}$/;
/** A re-sent prompt can be as long as the original; past this it goes in a file anyway. */
const MAX_BRANCH_PROMPT = 100_000;

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

const httpError = (message, status) => Object.assign(new Error(message), { status });

export function validateBranchRequest(body, source) {
  const errors = [];
  const ref = typeof body?.ref === 'string' ? body.ref : '';
  if (!REF_RE.test(ref)) errors.push('ref is required (a message ref from …/messages)');
  let harness = source;
  if (body?.harness != null && body.harness !== '') {
    if (!BRANCH_HARNESSES.includes(body.harness)) errors.push(`harness must be one of ${BRANCH_HARNESSES.join(', ')}`);
    else harness = body.harness;
  }
  let model = '';
  if (body?.model != null && body.model !== '') {
    if (typeof body.model !== 'string' || !MODEL_ID_RE.test(body.model)) errors.push('model must be 1-100 chars of letters, digits, . _ [ ] / : or -');
    else model = body.model;
  }
  let prompt = null;
  if (body?.prompt != null) {
    if (typeof body.prompt !== 'string') errors.push('prompt must be a string');
    else if (body.prompt.length > MAX_BRANCH_PROMPT) errors.push(`prompt too long (max ${MAX_BRANCH_PROMPT} chars)`);
    else prompt = body.prompt;
  }
  const name = body?.name ? sanitizeName(body.name) : '';
  if (body?.name && !name) errors.push('name must have letters or digits');
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, ref, harness, model, prompt, name };
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push({ line, entry: JSON.parse(line) });
    } catch {
      /* a torn last line while the agent writes */
    }
  }
  return out;
}

/** Text of a Claude/Codex content array (or string), text blocks only. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b.text === 'string' && /text$/.test(b.type ?? 'text'))
    .map((b) => b.text)
    .join('\n');
}

// ------------------------------------------------------------------ Claude

/**
 * Cut a Claude transcript at entry `ref`. → `{ lines, role, text }`: the entries of the chain
 * root → message (→ its parent, for a prompt), oldest first, unchanged apart from `sessionId`.
 */
export function cutClaude(text, ref, newId) {
  const rows = parseLines(text);
  const byUuid = new Map();
  for (const r of rows) if (typeof r.entry.uuid === 'string') byUuid.set(r.entry.uuid, r);
  const target = byUuid.get(ref);
  if (!target || target.entry.isSidechain) throw httpError('no such message in this session', 404);
  const e = target.entry;
  const role = e.type === 'user' ? 'user' : e.type === 'assistant' ? 'assistant' : null;
  if (!role) throw httpError('only a prompt or a reply can be branched from', 400);
  const chain = [];
  const seen = new Set();
  for (let at = role === 'user' ? e.parentUuid : ref; at && !seen.has(at); at = byUuid.get(at)?.entry.parentUuid) {
    seen.add(at);
    const r = byUuid.get(at);
    if (!r) break; // the chain runs out of this file (shouldn't): keep what is here
    chain.push(r);
  }
  chain.reverse();
  const keep = new Set(chain.map((r) => r.entry.uuid));
  // Bookkeeping without a uuid that belongs to a kept message (file-history snapshots) or to the
  // whole session (the recorded system prompt: `api-request*`, permission mode) comes along;
  // titles, names and the last-prompt pointer are the source's, not the branch's.
  const SKIP = new Set(['custom-title', 'agent-name', 'last-prompt', 'summary', 'queue-operation']);
  const lines = [];
  for (const r of rows) {
    const x = r.entry;
    if (typeof x.uuid === 'string') {
      if (!keep.has(x.uuid)) continue;
    } else if (SKIP.has(x.type)) continue;
    else if (typeof x.messageId === 'string' && !keep.has(x.messageId)) continue;
    const copy = { ...x };
    if ('sessionId' in copy) copy.sessionId = newId;
    if ('session_id' in copy) copy.session_id = newId;
    lines.push(copy);
  }
  // Never end on a tool call without its result: the API would reject the resumed history.
  const last = lines.findLast((x) => typeof x.uuid === 'string');
  if (last?.type === 'assistant' && Array.isArray(last.message?.content) && last.message.content.some((b) => b?.type === 'tool_use')) {
    last.message = { ...last.message, content: last.message.content.filter((b) => b?.type !== 'tool_use'), stop_reason: 'end_turn' };
  }
  return { lines: lines.map((x) => JSON.stringify(x)), role, text: role === 'user' ? textOf(e.message?.content) : '' };
}

// ------------------------------------------------------------------ Codex

/**
 * Cut a Codex rollout at the message line whose `codexRef` is `ref`. A reply keeps the rest of
 * its turn's bookkeeping (up to the next message or turn start); a prompt cuts just before it.
 */
export function cutCodex(text, ref, newId) {
  const rows = text.split('\n').filter((l) => l.trim());
  const at = rows.findIndex((l) => codexRef(l) === ref);
  if (at < 0) throw httpError('no such message in this session', 404);
  let entry;
  try {
    entry = JSON.parse(rows[at]);
  } catch {
    throw httpError('no such message in this session', 404);
  }
  const role = entry?.payload?.role;
  if (role !== 'user' && role !== 'assistant') throw httpError('only a prompt or a reply can be branched from', 400);
  let end = at; // exclusive
  if (role === 'assistant') {
    end = at + 1;
    for (; end < rows.length; end += 1) {
      let x;
      try {
        x = JSON.parse(rows[end]);
      } catch {
        continue;
      }
      const p = x?.payload ?? {};
      if (x.type === 'response_item') break;
      if (x.type === 'event_msg' && /^(user_message|task_started|turn_started)$/.test(p.type ?? '')) break;
    }
  } else {
    // A prompt's own `event_msg user_message` (and turn start) may come just before it.
    while (end > 0) {
      let x;
      try {
        x = JSON.parse(rows[end - 1]);
      } catch {
        break;
      }
      if (x?.type === 'event_msg' && /^(user_message|task_started|turn_started)$/.test(x.payload?.type ?? '')) end -= 1;
      else break;
    }
  }
  const lines = rows.slice(0, end).map((l, i) => {
    if (i > 0) return l;
    const head = JSON.parse(l);
    if (head?.type !== 'session_meta') throw httpError('not a Codex rollout (no session_meta)', 422);
    return JSON.stringify({ ...head, payload: { ...head.payload, id: newId } });
  });
  return { lines, role, text: role === 'user' ? textOf(entry.payload.content) : '' };
}

// ------------------------------------------------------------------ other agent

/** The conversation up to the cut as markdown, for an agent that can't read the source's format. */
export function conversationMarkdown(messages, { source, cwd }) {
  const parts = [`# Conversation branched from a ${LABELS[source] ?? source} session`, '', `Working directory: \`${cwd}\``, ''];
  for (const m of messages) {
    if (m.kind !== 'user' && m.kind !== 'assistant' && m.kind !== 'question') continue;
    parts.push(m.kind === 'user' ? '## User' : '## Assistant', '', m.text.trim(), '');
  }
  return parts.join('\n');
}

export function handoffPrompt({ file, source, prompt }) {
  const head =
    `This session continues a conversation branched from a ${LABELS[source] ?? source} session. ` +
    `Read ${file} first: it is the conversation so far (tool calls and their output left out). ` +
    'Treat it as your own history and carry on from its last message.';
  return prompt?.trim() ? `${head}\n\nMy next message:\n\n${prompt}` : `${head} Then say you are ready and wait for my next message.`;
}

// ------------------------------------------------------------------ service

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

/**
 * `spawner`: lib/spawn.mjs (its `spawn` takes `resume`); `tmuxHasSession` for a free name.
 * `branch(session, request)` → `{ source, ref, harness, sessionId, transcript, handoff, spawn }`.
 */
export function createBrancher({ spawner, home = claudeHome(), codex = codexHome(), promptDir = path.join(os.homedir(), '.claude', 'fleet-prompts'), now = () => new Date(), newId = randomUUID } = {}) {
  async function freeName(base) {
    const root = (sanitizeName(base) || 'branch').slice(0, 34);
    for (let i = 1; i < 50; i += 1) {
      const name = i === 1 ? root : `${root}-${i}`;
      if (!(await spawner.tmuxHasSession(name))) return name;
    }
    throw httpError('no free tmux session name for the branch', 409);
  }

  async function sourceFile(session, harness) {
    const file =
      harness === 'claude'
        ? await locateTranscript(session.cwd, session.session_id, home)
        : typeof session.transcript === 'string' && session.transcript
          ? session.transcript
          : null;
    if (!file) throw httpError('transcript not found for this session', 404);
    return file;
  }

  async function branch(session, body) {
    const source = session.harness || 'claude';
    if (!BRANCH_HARNESSES.includes(source)) throw httpError(`branching works for ${BRANCH_HARNESSES.map((h) => LABELS[h]).join(' and ')} sessions`, 409);
    const req = validateBranchRequest(body, source);
    if (!req.ok) throw httpError(req.error, 400);
    if (!session.cwd) throw httpError('the session has no working directory', 409);
    const file = await sourceFile(session, source);
    const text = await fs.readFile(file, 'utf8');
    const name = await freeName(req.name || `${session.name || path.basename(session.cwd)}-branch`);
    const when = now();
    let resume = null;
    let transcript = null;
    let handoff = null;
    let prompt;

    if (req.harness === source) {
      const id = newId();
      const cut = source === 'claude' ? cutClaude(text, req.ref, id) : cutCodex(text, req.ref, id);
      prompt = cut.role === 'user' ? (req.prompt?.trim() ? req.prompt : cut.text) : (req.prompt ?? '');
      if (source === 'claude') {
        transcript = path.join(home, 'projects', encodeCwd(session.cwd), `${id}.jsonl`);
      } else {
        const d = when;
        const dir = path.join(codex, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
        transcript = path.join(dir, `rollout-${stamp(d)}-${id}.jsonl`);
      }
      await fs.mkdir(path.dirname(transcript), { recursive: true });
      await fs.writeFile(transcript, `${cut.lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
      if (source === 'codex') {
        // Codex names threads from its index; the branch shows under its own name.
        const entry = { id, thread_name: name, updated_at: when.toISOString() };
        await fs.appendFile(path.join(codex, 'session_index.jsonl'), `${JSON.stringify(entry)}\n`).catch(() => {});
      }
      resume = id;
    } else {
      const messages = source === 'claude' ? parseTranscript(text) : parseCodexTranscript(text);
      const at = messages.findIndex((m) => m.ref === req.ref);
      if (at < 0) throw httpError('no such message in this session', 404);
      const target = messages[at];
      if (target.kind !== 'user' && target.kind !== 'assistant' && target.kind !== 'question') throw httpError('only a prompt or a reply can be branched from', 400);
      const isPrompt = target.kind === 'user';
      const upTo = messages.slice(0, isPrompt ? at : at + 1);
      const next = isPrompt ? (req.prompt?.trim() ? req.prompt : target.text) : (req.prompt ?? '');
      handoff = path.join(promptDir, `${stamp(when)}-${name}-branch.md`);
      await fs.mkdir(promptDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(handoff, conversationMarkdown(upTo, { source, cwd: session.cwd }), { mode: 0o600 });
      prompt = handoffPrompt({ file: handoff, source, prompt: next });
    }

    const spawn = await spawner.spawn({ name, dir: session.cwd, prompt, nameGiven: true, model: req.model, harness: req.harness, resume });
    return { source: { id: session.session_id, harness: source, transcript: file }, ref: req.ref, harness: req.harness, sessionId: resume, transcript, handoff, spawn };
  }

  return { branch };
}
