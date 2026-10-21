// Session titles — pure, unit-tested in title.test.ts.
//
// One title per session (docs/architecture.md → "Session titles"): the CLI computes it
// (`display_title`); the Claude session name is the source of truth and the tmux name is
// derived from it. The UI only draws `sessionTitle()` and renames through the API.
import type { Session } from '@/api/types'

/** Same cap as the CLI and the server (core::title::MAX_TITLE). */
export const MAX_TITLE = 64

/** How long a touch has to rest on a row before it turns into "rename". */
export const LONG_PRESS_MS = 550

/** A pending optimistic title. */
export interface PendingTitle {
  title: string
  /** Epoch ms of the rename request. */
  at: number
}

/** An optimistic title stops standing in once the overmind shows it, or after this long. */
export const PENDING_TTL_MS = 30_000

type TitleFields = Pick<Session, 'display_title' | 'name' | 'gen_title' | 'session_id'>

/** The one title to draw: `display_title`, else (older CLIs) the name / generated title / short id. */
export function sessionTitle(s: Partial<TitleFields> | null | undefined, pending?: PendingTitle | null, now = Date.now()): string {
  const server = serverTitle(s)
  if (pending && pending.title !== server && now - pending.at < PENDING_TTL_MS) return pending.title
  return server
}

function serverTitle(s: Partial<TitleFields> | null | undefined): string {
  for (const v of [s?.display_title, s?.name, s?.gen_title]) {
    const t = typeof v === 'string' ? v.trim() : ''
    if (t) return t
  }
  return s?.session_id ? String(s.session_id).slice(0, 8) : '(unnamed)'
}

export type TitleCheck = { ok: true; title: string } | { ok: false; error: string }

/** Validate what was typed: trimmed, one line, 1..64 characters (mirrors the server). */
export function validateTitle(raw: string): TitleCheck {
  const title = String(raw ?? '').trim()
  if (!title) return { ok: false, error: 'A title can’t be empty' }
  if (/[\r\n]/.test(title)) return { ok: false, error: 'One line only' }
  if ([...title].length > MAX_TITLE) return { ok: false, error: `At most ${MAX_TITLE} characters` }
  return { ok: true, title }
}

/** Is there anything to save? (Unchanged or invalid input just closes the editor.) */
export function titleChanged(raw: string, current: string): boolean {
  const check = validateTitle(raw)
  return check.ok && check.title !== current.trim()
}

/**
 * Toast copy for a rename that did not go through. `status` is the HTTP status: 409 =
 * held — the session is waiting on a prompt, where typed keys would be its answer. (A
 * busy session is renamed: Claude runs `/rename` mid-turn without disturbing the turn.)
 */
export function renameFailure(status: number, message: string): { title: string; description: string } {
  if (status === 409) {
    return { title: 'Not renamed — the session is waiting on you', description: 'Nothing was typed into it. Answer it first, then rename.' }
  }
  return { title: 'Rename failed', description: message || 'request failed' }
}

/** The tmux side of a successful rename, for the toast description ('' when nothing to say). */
export function tmuxNote(tmux: { renamed: boolean; to?: string | null; note?: string } | null | undefined): string {
  if (!tmux) return ''
  if (tmux.renamed && tmux.to) return `tmux session → ${tmux.to}`
  return ''
}

/** Would the subtitle (first prompt) just repeat the title? True when the title is its whole slug. */
export function echoesTitle(title: string, subtitle: string): boolean {
  const slug = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const a = slug(title)
  return a.length > 0 && slug(subtitle) === a
}
