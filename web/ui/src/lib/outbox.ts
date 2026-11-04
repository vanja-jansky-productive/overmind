// Composer outbox: messages sent with an undo delay — pure state transitions, unit-tested in
// outbox.test.ts. hooks/useOutbox.ts owns the timers and the POSTs.
//
// Model: at most ONE message counts down at a time (`pending`). Sending another while one is
// pending flushes the first right away (→ `queued`) and starts a new window for the second, so
// Backspace / Undo always cancels the most recent message and order is kept. Queued messages are
// POSTed one at a time, oldest first (`sending`), then `sent` (kept until the transcript shows
// them) or `failed` (inline error, Retry / Edit).
import type { Message } from '@/api/types'
import { msgKind } from '@/lib/chat'

export type OutboxState = 'pending' | 'queued' | 'sending' | 'sent' | 'failed'

export interface OutboxItem {
  id: number
  text: string
  state: OutboxState
  createdAt: number
  /** `pending` only: when it goes out on its own. */
  dueAt: number | null
  /** When the POST succeeded (`sent`). */
  sentAt: number | null
  /**
   * The transcript's last user message when it was sent (tailAnchor), to look for it after that
   * point; '' = none in the window, null = not known (chat not loaded) → match by timestamp.
   */
  anchor: string | null
  error: string | null
}

/** Send delay choices (Settings → Chat), ms. */
export const SEND_DELAYS = [0, 3000, 5000] as const
export const DEFAULT_SEND_DELAY = 3000
export const SEND_DELAY_LABELS: Record<number, string> = { 0: 'Off', 3000: '3 s', 5000: '5 s' }
export const parseSendDelay = (raw: string): number | undefined => {
  const n = Number(raw)
  return (SEND_DELAYS as readonly number[]).includes(n) ? n : undefined
}

/** A sent message the transcript never matched is dropped after this long (a failed match must not double forever). */
export const SENT_TTL_MS = 3 * 60 * 1000
/** Without an anchor in the transcript: only messages this close to (or after) the send count. */
const TS_SLACK_MS = 60 * 1000

/** How the backend may reshape text: CRLF, trailing / repeated whitespace, a long paste wrapped in `<pasted_content>`. */
export function normalizeText(text: string): string {
  return String(text ?? '')
    .replace(/<\/?pasted_content(?:\s[^>]*)?>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Same message? Normalized equality, or the same first 32 chars (Claude Code may rewrite attached paths). */
export function sameText(a: string, b: string): boolean {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (x === y) return true
  return x.length >= 32 && y.length >= 32 && x.slice(0, 32) === y.slice(0, 32)
}

/** A transcript message's identity for anchoring (messages carry no ids). */
export function anchorKey(m: Message): string {
  return `${msgKind(m)}|${m.ts ?? ''}|${String(m.text ?? '').slice(0, 80)}`
}

/**
 * The anchor for a message sent now: the transcript's last USER message (not a queued one: it moves) (assistant messages are
 * merged and re-stamped as they grow, user ones are stable); '' when the window has none, null
 * when the transcript is not loaded.
 */
export function tailAnchor(messages: Message[] | null | undefined): string | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) if (msgKind(messages[i]) === 'user' && !messages[i].queued) return anchorKey(messages[i])
  return ''
}

const update = (items: OutboxItem[], id: number, patch: Partial<OutboxItem>) => items.map((it) => (it.id === id ? { ...it, ...patch } : it))

/** Any pending message goes out now (keeps order). */
export function flushPending(items: OutboxItem[]): OutboxItem[] {
  return items.some((it) => it.state === 'pending') ? items.map((it) => (it.state === 'pending' ? { ...it, state: 'queued', dueAt: null } : it)) : items
}

/** Add a message: flushes the one counting down, then counts down `delayMs` (0 = queued at once). */
export function schedule(
  items: OutboxItem[],
  msg: { id: number; text: string; now: number; delayMs: number; anchor: string | null },
): OutboxItem[] {
  const item: OutboxItem = {
    id: msg.id,
    text: msg.text,
    state: msg.delayMs > 0 ? 'pending' : 'queued',
    createdAt: msg.now,
    dueAt: msg.delayMs > 0 ? msg.now + msg.delayMs : null,
    sentAt: null,
    anchor: msg.anchor,
    error: null,
  }
  return [...flushPending(items), item]
}

/** The pending message (at most one). */
export const pendingItem = (items: OutboxItem[]): OutboxItem | null => items.find((it) => it.state === 'pending') ?? null

/** Backspace / Undo: drop the pending message; its text goes back to the composer. */
export function cancelPending(items: OutboxItem[]): { items: OutboxItem[]; cancelled: OutboxItem | null } {
  const p = pendingItem(items)
  if (!p) return { items, cancelled: null }
  return { items: items.filter((it) => it.id !== p.id), cancelled: p }
}

/** The countdown ran out. */
export function releaseDue(items: OutboxItem[], now: number): OutboxItem[] {
  return items.some((it) => it.state === 'pending' && it.dueAt != null && it.dueAt <= now)
    ? items.map((it) => (it.state === 'pending' && it.dueAt != null && it.dueAt <= now ? { ...it, state: 'queued', dueAt: null } : it))
    : items
}

/** The next message to POST: the oldest queued one, and only while nothing is in flight. */
export function nextToSend(items: OutboxItem[]): OutboxItem | null {
  if (items.some((it) => it.state === 'sending')) return null
  return items.find((it) => it.state === 'queued') ?? null
}

export const markSending = (items: OutboxItem[], id: number) => update(items, id, { state: 'sending', error: null })
export const markSent = (items: OutboxItem[], id: number, now: number) => update(items, id, { state: 'sent', sentAt: now })
export const markFailed = (items: OutboxItem[], id: number, error: string) => update(items, id, { state: 'failed', error })
/** Retry a failed message: to the back of the line (order = matching order), anchored at the current tail. */
export function retry(items: OutboxItem[], id: number, anchor: string | null): OutboxItem[] {
  const it = items.find((x) => x.id === id)
  if (!it || it.state !== 'failed') return items
  return [...items.filter((x) => x.id !== id), { ...it, state: 'queued', error: null, anchor }]
}
export const remove = (items: OutboxItem[], id: number) => items.filter((it) => it.id !== id)

/** Messages that have not left yet (pending or queued) — what leaving the screen must still send. */
export const unsent = (items: OutboxItem[]) => items.filter((it) => it.state === 'pending' || it.state === 'queued')

/**
 * Drop the optimistic bubbles the transcript now shows. In order, each sending / sent message
 * is matched to the first user message after its anchor (or, when the anchor is unknown / scrolled
 * out of the window, with a timestamp no older than its send minus a minute) with the same text, and after
 * the previous match — so two identical "yes" are two bubbles until two "yes" arrive. Sent ones
 * older than SENT_TTL_MS go too.
 */
export function reconcile(items: OutboxItem[], messages: Message[] | null | undefined, now: number): OutboxItem[] {
  const list = Array.isArray(messages) ? messages : []
  const keys = list.map(anchorKey)
  const matched = new Set<number>()
  let floor = 0
  for (const it of items) {
    if (it.state !== 'sending' && it.state !== 'sent') continue
    let start: number
    const at = it.anchor ? keys.lastIndexOf(it.anchor) : -1
    if (it.anchor === '') start = 0
    else if (at >= 0) start = at + 1
    else {
      // Anchor unknown or gone (scrolled out, transcript reloaded): fall back to timestamps.
      start = list.findIndex((m) => Number(m.ts) >= it.createdAt - TS_SLACK_MS)
      if (start < 0) continue
    }
    for (let j = Math.max(start, floor); j < list.length; j++) {
      const m = list[j]
      if (msgKind(m) !== 'user' || !sameText(String(m.text ?? ''), it.text)) continue
      matched.add(it.id)
      floor = j + 1
      break
    }
  }
  const out = items.filter((it) => !matched.has(it.id) && !(it.state === 'sent' && it.sentAt != null && now - it.sentAt > SENT_TTL_MS))
  return out.length === items.length ? items : out
}

/** Put cancelled text back: alone, or before what was typed since (a blank line between). */
export function restoreText(cancelled: string, current: string): string {
  if (!current.trim()) return cancelled
  return `${cancelled.replace(/\s+$/, '')}\n\n${current.replace(/^\s+/, '')}`
}

/** Whole seconds left on a countdown (for the text countdown / aria). */
export function secondsLeft(dueAt: number | null, now: number): number {
  if (dueAt == null) return 0
  return Math.max(0, Math.ceil((dueAt - now) / 1000))
}

export interface OutboxDeps {
  /** Deliver one message (POST …/send). Called one at a time, in order. */
  send: (text: string) => Promise<unknown>
  /** A human error for the bubble (sessionErrorMessage). */
  errorText?: (err: unknown) => string
  onSent?: (item: OutboxItem) => void
  onError?: (err: unknown, item: OutboxItem) => void
  now?: () => number
}

/**
 * The outbox for one session: the state above plus its timer and a one-at-a-time sender.
 * Framework-free (hooks/useOutbox.ts subscribes to it), so the timing is unit-tested with fake timers.
 */
export class Outbox {
  private items: OutboxItem[] = []
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** When the oldest unmatched `sent` bubble expires (SENT_TTL_MS): no transcript poll has to come by for it to go. */
  private expiry: ReturnType<typeof setTimeout> | null = null
  /** The transcript the last reconcile saw (the expiry re-runs it). */
  private lastMessages: Message[] | null | undefined = null
  private disposed = false
  private inflight = false
  private listeners = new Set<() => void>()
  private deps: OutboxDeps

  constructor(deps: OutboxDeps) {
    this.deps = deps
  }

  private now = () => (this.deps.now ?? Date.now)()

  /** Swap callbacks (the hook keeps them current). */
  configure(patch: Partial<OutboxDeps>) {
    this.deps = { ...this.deps, ...patch }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getItems = () => this.items

  private set(next: OutboxItem[]) {
    if (next === this.items) return
    this.items = next
    this.arm()
    for (const fn of this.listeners) fn()
    this.pump()
  }

  /** Two timers: the pending message's countdown, and the oldest sent bubble's expiry. */
  private arm() {
    this.armExpiry()
    const p = pendingItem(this.items)
    if (this.timer && (!p || p.dueAt == null)) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!p || p.dueAt == null || this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.set(releaseDue(this.items, this.now()))
      this.arm() // a clock that fired early re-arms for the rest
    }, Math.max(0, p.dueAt - this.now()))
  }

  private armExpiry() {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
    if (this.disposed) return
    let oldest = Infinity
    for (const it of this.items) if (it.state === 'sent' && it.sentAt != null) oldest = Math.min(oldest, it.sentAt)
    if (oldest === Infinity) return
    this.expiry = setTimeout(
      () => {
        this.expiry = null
        this.set(reconcile(this.items, this.lastMessages, this.now()))
        if (!this.expiry) this.armExpiry() // nothing dropped (a clock that fired early): try again
      },
      Math.max(0, oldest + SENT_TTL_MS + 1 - this.now()),
    )
  }

  private pump() {
    if (this.inflight) return
    const next = nextToSend(this.items)
    if (!next) return
    this.inflight = true
    this.set(markSending(this.items, next.id))
    let ok = false
    let error: unknown = null
    this.deps
      .send(next.text)
      .then(
        () => void (ok = true),
        (err) => void (error = err),
      )
      .finally(() => {
        this.inflight = false
        if (ok) {
          this.set(markSent(this.items, next.id, this.now()))
          this.deps.onSent?.(next)
        } else {
          this.set(markFailed(this.items, next.id, this.deps.errorText?.(error) ?? String((error as Error)?.message ?? error)))
          this.deps.onError?.(error, next)
        }
        this.pump()
      })
  }

  /** Send `text` after `delayMs` (0 = now); a message still counting down goes out first. */
  add(text: string, delayMs: number, anchor: string | null): number {
    const id = ++this.seq
    // Re-arm: the flushed message's timer must not fire for the new one.
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.set(schedule(this.items, { id, text, now: this.now(), delayMs, anchor }))
    return id
  }

  /** Backspace / Undo: the pending message, removed (null when none). */
  cancel(): OutboxItem | null {
    const { items, cancelled } = cancelPending(this.items)
    this.set(items)
    return cancelled
  }

  hasPending = () => pendingItem(this.items) != null

  /** Send what counts down now (leaving, backgrounded). */
  flush() {
    this.set(flushPending(this.items))
  }

  retry(id: number, anchor: string | null) {
    this.set(retry(this.items, id, anchor))
  }

  /** Edit a failed message: removed, its text returned for the composer. */
  discard(id: number): string | null {
    const it = this.items.find((x) => x.id === id)
    if (!it || it.state !== 'failed') return null
    this.set(remove(this.items, id))
    return it.text
  }

  reconcile(messages: Message[] | null | undefined) {
    this.lastMessages = messages
    this.set(reconcile(this.items, messages, this.now()))
  }

  /** Unmounted: stop the timers (a send still in flight finishes; nothing arms again until resume()). */
  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
  }

  /** Mounted again (StrictMode re-runs effects on the same box): timers back on. */
  resume() {
    this.disposed = false
    this.arm()
  }

  /** Page unload: hand over everything not yet sent (the caller beacons it) and forget it. */
  takeUnsent(): OutboxItem[] {
    const out = unsent(this.items)
    if (out.length) this.set(this.items.map((it) => (out.includes(it) ? { ...it, state: 'sent', sentAt: this.now(), dueAt: null } : it)))
    return out
  }
}
