import { storage } from '@/lib/storage'

// Composer drafts, per session (`host/id`):
// - parked: one-shot text a screen hands to a session it opens (the notes explorer's
//   "Send to session"); in memory, taken by that session's Composer on mount.
// - saved: what was typed but not sent, in localStorage so it survives switching sessions
//   and restarting Overmind; cleared when the text is sent, dropped after DRAFT_TTL_MS.
const parked = new Map<string, string>()

const SAVED_KEY = 'overmind.drafts'
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000

export type SavedDrafts = Record<string, { text: string; at: number }>

export function setDraft(key: string, text: string): void {
  parked.set(key, text)
}

/** Saved drafts without the expired (or malformed) ones. */
export function pruneDrafts(all: unknown, now: number): SavedDrafts {
  const out: SavedDrafts = {}
  if (!all || typeof all !== 'object') return out
  for (const [k, v] of Object.entries(all as Record<string, unknown>)) {
    const d = v as { text?: unknown; at?: unknown } | null
    if (typeof d?.text === 'string' && d.text && typeof d.at === 'number' && now - d.at < DRAFT_TTL_MS) {
      out[k] = { text: d.text, at: d.at }
    }
  }
  return out
}

/** The saved draft with a parked one appended (a space between them when needed). */
export function joinDraft(saved: string, park: string): string {
  if (!saved) return park
  if (!park) return saved
  return /\s$/.test(saved) ? saved + park : `${saved} ${park}`
}

/** The textarea's starting text for `key`: its saved draft plus any parked one (taken). */
export function takeDraft(key: string | undefined, now = Date.now()): string {
  if (!key) return ''
  const park = parked.get(key) ?? ''
  parked.delete(key)
  const saved = pruneDrafts(storage.getJSON(SAVED_KEY), now)[key]?.text ?? ''
  return joinDraft(saved, park)
}

/** Remember `text` as `key`'s unsent draft; blank text forgets it. */
export function saveDraft(key: string | undefined, text: string, now = Date.now()): void {
  if (!key) return
  const all = pruneDrafts(storage.getJSON(SAVED_KEY), now)
  if (text.trim()) all[key] = { text, at: now }
  else if (key in all) delete all[key]
  else return
  if (Object.keys(all).length) storage.setJSON(SAVED_KEY, all)
  else storage.remove(SAVED_KEY)
}
