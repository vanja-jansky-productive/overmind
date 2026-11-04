// Review notes on someone's pull request, made in the diff reviewer with no session behind it:
// anchored like a review thread (path, side, start–end, the selected code) but kept in Overmind,
// for a session spawned later to work through ("Hand to a session"). Any one of them can also
// go straight to GitHub as a PR review comment, as the host's `gh` login.
//
// Storage: one JSON file per PR under `<state>/overmind/pr-notes/<owner>__<repo>__<n>.json` on the
// host that has the clone (dir 0700, files 0600, atomic temp + rename).
//
// A note answers in the shape of a review thread (status: draft, one entry, no replies), so the
// reviewer renders both the same way; `posted` says where it went on GitHub.
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const MAX_BODY = 8000;
export const MAX_CODE_LINES = 60;
const MAX_NOTES = 300;
const NOTE_ID_RE = /^c-[0-9a-f]{6,12}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export class NoteError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const validNoteId = (id) => typeof id === 'string' && NOTE_ID_RE.test(id);
export const validPrName = (s) => typeof s === 'string' && NAME_RE.test(s) && s !== '.' && s !== '..';

function checkAnchor(a) {
  const p = a?.path;
  if (typeof p !== 'string' || !p || p.length > 1000 || path.isAbsolute(p) || p.split('/').includes('..')) throw new NoteError('invalid path', 400);
  if (a.side !== 'new' && a.side !== 'old') throw new NoteError('side must be new or old', 400);
  if (!Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 1 || a.end < a.start) throw new NoteError('invalid line range', 400);
}

function checkBody(body) {
  const b = typeof body === 'string' ? body.trim() : '';
  if (!b) throw new NoteError('a comment is required', 400);
  if (b.length > MAX_BODY) throw new NoteError(`the comment is longer than ${MAX_BODY} characters`, 400);
  return b;
}

/** A stored note → the reviewer's thread shape. */
export function noteThread(n) {
  return {
    id: n.id,
    root: n.root ?? null,
    path: n.path,
    side: n.side,
    start: n.start,
    end: n.end,
    code: n.code,
    base: n.base ?? null,
    status: 'draft',
    resolved: Boolean(n.resolved),
    reviewId: null,
    createdAt: n.createdAt,
    entries: [{ body: n.body, sentAt: null, state: 'draft', replies: [] }],
    posted: n.posted ?? null,
  };
}

/** The notes as a prompt for a session that checks the PR out: each with its file, lines and code. */
export function notesPrompt(notes, { summary = '' } = {}) {
  const parts = ['My review notes on this PR — go through them one by one: check each against the code, tell me what you think, and say which ones should become comments on the PR.'];
  if (summary.trim()) parts.push(summary.trim());
  for (const [i, n] of notes.entries()) {
    const lines = n.start === n.end ? `${n.start}` : `${n.start}-${n.end}`;
    const code = (n.code ?? []).slice(0, MAX_CODE_LINES);
    const fence = code.some((l) => l.includes('```')) ? '````' : '```';
    parts.push(`${i + 1}. ${n.path}:${lines}${n.side === 'old' ? ' (removed lines)' : ''}${n.posted ? ' — already posted on GitHub' : ''}\n${code.length ? `${fence}\n${code.join('\n')}\n${fence}\n` : ''}${n.body}`);
  }
  return parts.join('\n\n');
}

/**
 * @param {object} deps
 *   dir   where the per-PR files live
 *   gh    async (args, opts) → { stdout } — `gh` (posting a note)
 */
export function createPrNotes({ dir, gh = null, now = () => Date.now(), randomId = () => randomBytes(4).toString('hex') }) {
  const fileOf = ({ owner, repo, number }) => {
    if (!validPrName(owner) || !validPrName(repo) || !Number.isInteger(number) || number <= 0) throw new NoteError('invalid pull request', 400);
    return path.join(dir, `${owner.toLowerCase()}__${repo.toLowerCase()}__${number}.json`);
  };
  const locks = new Map();
  const locked = async (file, fn) => {
    const prev = locks.get(file) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    locks.set(file, prev.then(() => mine));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(file) === mine) locks.delete(file);
    }
  };
  async function load(file) {
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      return Array.isArray(data?.notes) ? data.notes : [];
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }
  async function save(file, notes) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ notes }, null, 1), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }
  const state = (notes) => ({ threads: notes.map(noteThread), reviews: [], drafts: notes.filter((n) => !n.posted).length });

  async function list(pr) {
    return state(await load(fileOf(pr)));
  }

  async function create(pr, body) {
    checkAnchor(body);
    const text = checkBody(body.body);
    const file = fileOf(pr);
    return locked(file, async () => {
      const notes = await load(file);
      if (notes.length >= MAX_NOTES) throw new NoteError(`a PR keeps at most ${MAX_NOTES} notes`, 409);
      const code = Array.isArray(body.code) ? body.code.filter((l) => typeof l === 'string').slice(0, 400) : [];
      const note = {
        id: `c-${randomId()}`,
        root: typeof body.root === 'string' ? body.root : null,
        path: body.path,
        side: body.side,
        start: body.start,
        end: body.end,
        code,
        base: typeof body.base === 'string' ? body.base : null,
        body: text,
        resolved: false,
        createdAt: now(),
        posted: null,
      };
      notes.push(note);
      await save(file, notes);
      return { ...state(notes), thread: noteThread(note) };
    });
  }

  async function update(pr, id, patch) {
    const file = fileOf(pr);
    return locked(file, async () => {
      const notes = await load(file);
      const n = notes.find((x) => x.id === id);
      if (!n) throw new NoteError('no such note', 404);
      if (patch?.body != null) {
        if (n.posted) throw new NoteError('this note is on GitHub already — edit it there', 409);
        n.body = checkBody(patch.body);
      }
      if (typeof patch?.resolved === 'boolean') n.resolved = patch.resolved;
      await save(file, notes);
      return { ...state(notes), thread: noteThread(n) };
    });
  }

  async function remove(pr, id) {
    const file = fileOf(pr);
    return locked(file, async () => {
      const notes = await load(file);
      const next = notes.filter((x) => x.id !== id);
      if (next.length === notes.length) throw new NoteError('no such note', 404);
      await save(file, next);
      return state(next);
    });
  }

  /** The notes not on GitHub yet, oldest first (a session's prompt). */
  async function pending(pr) {
    return (await load(fileOf(pr))).filter((n) => !n.resolved);
  }

  /**
   * Post one note as a PR review comment on its lines at `headOid` (the PR's head as diffed).
   * GitHub numbers lines like the diff: RIGHT = the new side, LEFT = the old one.
   */
  async function post(pr, id, { headOid }) {
    if (typeof gh !== 'function') throw new NoteError('posting needs `gh` on this host', 501);
    if (typeof headOid !== 'string' || !/^[0-9a-f]{40}$/.test(headOid)) throw new NoteError('the PR head is unknown — reload the diff', 409);
    const file = fileOf(pr);
    return locked(file, async () => {
      const notes = await load(file);
      const n = notes.find((x) => x.id === id);
      if (!n) throw new NoteError('no such note', 404);
      if (n.posted) throw new NoteError('this note is on GitHub already', 409);
      const side = n.side === 'old' ? 'LEFT' : 'RIGHT';
      const args = ['api', '-X', 'POST', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`, '-f', `body=${n.body}`, '-f', `commit_id=${headOid}`, '-f', `path=${n.path}`, '-F', `line=${n.end}`, '-f', `side=${side}`];
      if (n.start !== n.end) args.push('-F', `start_line=${n.start}`, '-f', `start_side=${side}`);
      let out;
      try {
        out = await gh(args, { timeout: 30_000 });
      } catch (err) {
        const msg = String(err?.stderr || err?.message || err).trim().split('\n').filter(Boolean).pop() ?? 'gh failed';
        throw new NoteError(`GitHub refused the comment: ${msg}`, 502);
      }
      let url = null;
      try {
        url = JSON.parse(out.stdout)?.html_url ?? null;
      } catch {
        /* posted; no link */
      }
      n.posted = { url, at: now() };
      await save(file, notes);
      return { ...state(notes), thread: noteThread(n) };
    });
  }

  return { list, create, update, remove, pending, post };
}
