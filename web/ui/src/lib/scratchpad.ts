import { storage } from '@/lib/storage'

// The scratchpad: one plain-text buffer for copy → tweak → copy, autosaved to localStorage
// (per browser / Overmind.app, survives reloads). On desktop it floats over the app without a
// backdrop, so the chat stays selectable while it is open; on mobile it is a bottom drawer.

export const SCRATCH_KEY = 'overmind.scratchpad'
export const SCRATCH_RECT_KEY = 'overmind.scratchpad.rect'
/** Typing pauses this long before the buffer is written (blur / close / pagehide write at once). */
export const SAVE_DELAY_MS = 300

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const MIN_W = 280
export const MIN_H = 180
const MARGIN = 16

/** Bottom-right, clear of the composer's send button column: 440×380 (smaller viewports shrink it). */
export function defaultRect(vw: number, vh: number): Rect {
  const w = Math.min(440, vw - 2 * MARGIN)
  const h = Math.min(380, vh - 2 * MARGIN)
  return { x: vw - w - MARGIN, y: vh - h - 96, w, h }
}

/** Keep the panel inside the viewport and at least MIN_W × MIN_H (as far as the viewport allows). */
export function clampRect(r: Rect, vw: number, vh: number): Rect {
  const w = Math.max(Math.min(MIN_W, vw), Math.min(r.w, vw))
  const h = Math.max(Math.min(MIN_H, vh), Math.min(r.h, vh))
  const x = Math.max(0, Math.min(r.x, vw - w))
  const y = Math.max(0, Math.min(r.y, vh - h))
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/** A stored rect, or null when missing / malformed. */
export function parseRect(raw: unknown): Rect | null {
  const r = raw as Partial<Rect> | null
  if (!r || typeof r !== 'object') return null
  const ok = [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n))
  return ok ? (r as Rect) : null
}

export const loadText = (): string => storage.get(SCRATCH_KEY) ?? ''
export function saveText(text: string): void {
  if (text) storage.set(SCRATCH_KEY, text)
  else storage.remove(SCRATCH_KEY)
}

export const loadRect = (): Rect | null => parseRect(storage.getJSON(SCRATCH_RECT_KEY))
export const saveRect = (r: Rect): void => storage.setJSON(SCRATCH_RECT_KEY, r)

// --- open state: one tiny store, so any screen (shortcut, palette, header button) can toggle it.
type Listener = () => void
let open = false
let focusTick = 0
const listeners = new Set<Listener>()
const emit = () => listeners.forEach((l) => l())

export const scratchpad = {
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => void listeners.delete(l)
  },
  isOpen: () => open,
  /** Bumped by show(): the panel focuses its editor when it changes. */
  focusTick: () => focusTick,
  show(): void {
    open = true
    focusTick++
    emit()
  },
  hide(): void {
    if (!open) return
    open = false
    emit()
  },
  /** The shortcut: open (focused) → close; open elsewhere → focus it; closed → open. */
  toggle(focused: boolean): void {
    if (open && focused) scratchpad.hide()
    else scratchpad.show()
  },
}
