// Side questions from the diff reviewer: "what does this do?" about a selection, answered without
// touching the session's thread. The question runs as `claude -p --resume <id> --fork-session
// --no-session-persistence` in the session's cwd: a throwaway fork that sees the whole
// conversation, writes no transcript, and has read-only tools. Nothing is typed into the
// session and nothing is stored: an ask lives in memory on the session's host while it runs and
// for a while after (`ttlMs`), and the UI polls it.
//
// Without a session (a PR reviewed on its own), the same runs fresh in a checkout of the repo.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { langOf, rangeLabel } from './reviews.mjs';

export const MAX_QUESTION = 4000;
/** Lines of selected code quoted (the rest is elided). */
export const MAX_CODE_LINES = 120;
/** Extra context (a PR's title and description) is cut here. */
export const MAX_CONTEXT = 8000;
const ASK_ID_RE = /^q-[0-9a-f]{8,16}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Read-only: the fork may look around the checkout, never change it. */
export const ASK_TOOLS = ['Read', 'Grep', 'Glob'];

export class AskError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const validAskId = (id) => typeof id === 'string' && ASK_ID_RE.test(id);

/**
 * The prompt: the selection (file, lines, the code fenced), the question, and the rule that this
 * is a side question. `context`: optional text before it (a PR's title and description).
 */
export function askPrompt({ question, display, path: file, side, start, end, code, context = '', readGit = false }) {
  const q = typeof question === 'string' ? question.trim() : '';
  if (!q) throw new AskError('a question is required', 400);
  if (q.length > MAX_QUESTION) throw new AskError(`the question is longer than ${MAX_QUESTION} characters`, 400);
  const parts = [
    readGit
      ? 'A side question from the code reviewer. Answer it briefly and directly. Do not change anything; read the code with your read-only tools and the read-only git commands below.'
      : 'A side question from the code reviewer. Answer it briefly and directly. Do not change any files, do not run commands, and do not continue or mention the main task — this answer is not part of the conversation.',
  ];
  if (typeof context === 'string' && context.trim()) parts.push(context.trim().slice(0, MAX_CONTEXT));
  const hasRange = typeof file === 'string' && file && Number.isInteger(start) && Number.isInteger(end);
  if (hasRange) {
    const lines = Array.isArray(code) ? code.filter((l) => typeof l === 'string') : [];
    const shown = lines.length > MAX_CODE_LINES ? [...lines.slice(0, MAX_CODE_LINES), `… (${lines.length - MAX_CODE_LINES} more lines)`] : lines;
    const fence = shown.some((l) => l.includes('```')) ? '````' : '```';
    parts.push(`About ${rangeLabel({ display, path: file, side, start, end })}:`);
    if (shown.length) parts.push(`${fence}${langOf(file)}\n${shown.join('\n')}\n${fence}`);
  }
  parts.push(`Question: ${q}`);
  return parts.join('\n\n');
}

/**
 * One `claude -p` stream-json line → what it adds to the ask: { text?, newMessage?, activity?,
 * result?, error?, costUsd? }; null when it adds nothing.
 */
export function readStreamLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (m?.type === 'stream_event') {
    const ev = m.event;
    if (ev?.type === 'message_start') return { newMessage: true };
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') return { text: ev.delta.text };
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') return { activity: ev.content_block.name ?? 'a tool' };
    return null;
  }
  if (m?.type === 'result') {
    const out = { costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null };
    if (m.is_error || (m.subtype && m.subtype !== 'success')) out.error = typeof m.result === 'string' && m.result ? m.result : `claude stopped (${m.subtype ?? 'error'})`;
    else out.result = typeof m.result === 'string' ? m.result : '';
    return out;
  }
  return null;
}

/**
 * @param {object} deps
 *   bin        the claude binary
 *   spawn      child_process.spawn (tests pass a fake)
 *   ttlMs      a finished ask is forgotten this long after it ends
 *   timeoutMs  a running ask is killed after this
 *   maxRunning asks running at once on this host
 *   model      optional --model for every ask (default: the claude default)
 */
export function createAsks({ bin = 'claude', spawn = nodeSpawn, ttlMs = 30 * 60 * 1000, timeoutMs = 5 * 60 * 1000, maxRunning = 3, model = null, now = () => Date.now() } = {}) {
  const asks = new Map(); // id → { ask (public), child, timer }

  const prune = () => {
    const t = now();
    for (const [id, a] of asks) if (a.ask.status !== 'running' && t - (a.ask.endedAt ?? t) > ttlMs) asks.delete(id);
  };
  const running = () => [...asks.values()].filter((a) => a.ask.status === 'running').length;
  const view = (a) => ({ ...a.ask });

  /**
   * Start an ask. `resume`: the session id to fork (null: a fresh run). `cwd`: where it runs —
   * for a fork, the session's cwd (claude finds the transcript by it).
   * → the ask: { id, status: running, text: '', question, label, startedAt }
   */
  function start({ cwd, resume = null, prompt, question, label = null, tools = ASK_TOOLS }) {
    prune();
    if (typeof cwd !== 'string' || !cwd) throw new AskError('no working directory to ask in', 409);
    if (resume != null && !SESSION_ID_RE.test(resume)) throw new AskError('invalid session id', 400);
    if (running() >= maxRunning) throw new AskError(`${maxRunning} side questions are already running — wait for one`, 429);
    const id = `q-${randomBytes(6).toString('hex')}`;
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--allowedTools', ...tools];
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume, '--fork-session');
    const ask = { id, status: 'running', question, label, text: '', activity: null, error: null, costUsd: null, forked: Boolean(resume), startedAt: now(), endedAt: null };
    const entry = { ask, child: null, timer: null };
    asks.set(id, entry);

    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      ask.status = 'error';
      ask.error = `could not start claude: ${err?.message ?? err}`;
      ask.endedAt = now();
      return view(entry);
    }
    entry.child = child;
    let buf = '';
    let stderr = '';
    let sawMessage = false;
    const finish = (status, error = null) => {
      if (ask.status !== 'running') return;
      ask.status = status;
      if (error) ask.error = error;
      ask.activity = null;
      ask.endedAt = now();
      clearTimeout(entry.timer);
    };
    const onLine = (line) => {
      const r = readStreamLine(line);
      if (!r) return;
      if (r.newMessage) {
        if (sawMessage && ask.text && !ask.text.endsWith('\n\n')) ask.text += '\n\n';
        sawMessage = true;
      }
      if (r.text) {
        ask.text += r.text;
        ask.activity = null;
      }
      if (r.activity) ask.activity = r.activity;
      if ('costUsd' in r) ask.costUsd = r.costUsd;
      if (r.error) finish('error', r.error);
      else if ('result' in r) {
        // The final answer alone, without the "let me look" in between.
        if (r.result.trim()) ask.text = r.result;
        finish('done');
      }
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (err) => finish('error', `claude failed: ${err?.message ?? err}`));
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf);
      buf = '';
      if (ask.status === 'running') {
        const why = stderr.trim().split('\n').pop() || `claude exited with code ${code}`;
        finish(code === 0 && ask.text ? 'done' : 'error', code === 0 && ask.text ? null : why);
      }
    });
    child.stdin?.on?.('error', () => {});
    child.stdin?.end(prompt);
    entry.timer = setTimeout(() => {
      if (ask.status !== 'running') return;
      finish('error', `no answer within ${Math.round(timeoutMs / 1000)}s`);
      child.kill?.('SIGTERM');
    }, timeoutMs);
    entry.timer.unref?.();
    return view(entry);
  }

  function get(id) {
    prune();
    const a = asks.get(id);
    if (!a) throw new AskError('no such side question (they are forgotten after a while)', 404);
    return view(a);
  }

  function cancel(id) {
    const a = asks.get(id);
    if (!a) throw new AskError('no such side question', 404);
    if (a.ask.status === 'running') {
      a.ask.status = 'cancelled';
      a.ask.activity = null;
      a.ask.endedAt = now();
      clearTimeout(a.timer);
      a.child?.kill?.('SIGTERM');
    }
    asks.delete(id);
    return { id, cancelled: true };
  }

  return { start, get, cancel };
}
