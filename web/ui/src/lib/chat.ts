// Chat/term view logic — pure, unit-tested in chat.test.ts.
import type { Message, MessagesResponse } from '@/api/types'

export type DetailMode = 'chat' | 'term'

export const TERM_FONT_SIZES = [11, 12, 14] as const
export const CHAT_FONT_SIZES = [13, 15, 17] as const
export const TERM_LINES = [200, 600] as const
/** "Load older" steps through these message limits. */
export const CHAT_LIMITS = [60, 200, 500] as const
/** Captions only on the last message of a same-speaker burst this close in time. */
export const GROUP_GAP_MS = 2 * 60 * 1000

export const CHAT_POLL_MS = 3000
export const PEEK_POLL_MS = 2000
/** Composer text limit (server: 1..8000 chars). */
export const MAX_SEND_CHARS = 8000

/**
 * The chat pane's transcript state. `messages` is the transcript window (the last `limit`, at
 * absolute indices `total - messages.length` …); `screen` is the prompt the terminal shows, apart
 * (ChatView gets it appended). `key` (JSON of the rest) is for answers of an older server only.
 */
export interface ChatState {
  messages: Message[]
  truncated: boolean
  status: string
  name: string | null
  total: number
  screen: Message | null
  key: string
}

/** A /messages poll onto the chat state: `prev` itself when nothing but the clocks moved, so nothing re-renders. */
export function nextChat(prev: ChatState | null, data: Partial<MessagesResponse>): ChatState {
  const messages = Array.isArray(data.messages) ? data.messages : []
  const truncated = data.truncated === true
  const status = String(data.status || 'unknown')
  const name = typeof data.name === 'string' && data.name ? data.name : null
  const key = JSON.stringify([messages, truncated, status, name])
  return prev?.key === key ? prev : { messages, truncated, status, name, total: messages.length, screen: null, key }
}

const sameJson = (x: unknown, y: unknown) => x === y || JSON.stringify(x) === JSON.stringify(y)

/** The screen prompt: the server stamps `ts` on every read, so an unchanged one keeps the first. */
function keepScreen(prev: Message | null, next: Message | null | undefined): Message | null {
  if (!next) return null
  return prev && prev.id === next.id && sameJson(prev.questions, next.questions) ? prev : next
}

let warnedDelta = false

/**
 * A /messages poll onto the chat state (#37). An answer without `cursor` (an older server) is a
 * whole list (nextChat). `full: false` keeps the messages before `from` and appends the answer's,
 * trimmed to `limit`; anything else replaces the list. Messages equal to the ones held keep their
 * objects, and when nothing visible changed the result is `prev` itself — nothing re-renders.
 */
export function mergeChat(prev: ChatState | null, data: Partial<MessagesResponse>, limit: number): ChatState {
  if (typeof data.cursor !== 'string') return nextChat(prev, data)
  const incoming = Array.isArray(data.messages) ? data.messages : []
  const truncated = data.truncated === true
  const status = String(data.status || 'unknown')
  const name = typeof data.name === 'string' && data.name ? data.name : null
  const total = Number.isInteger(data.total) ? Number(data.total) : incoming.length
  const screen = keepScreen(prev?.screen ?? null, data.screen)
  const held = prev?.messages ?? []
  const base = prev ? prev.total - held.length : 0
  const from = Number(data.from)
  let delta = !!prev && data.full === false
  if (delta && !(Number.isInteger(from) && from <= prev!.total)) {
    if (!warnedDelta) console.warn('chat: a delta outside the held window, taken as a full answer', { from, base, total: prev!.total })
    warnedDelta = true
    delta = false
  }
  const keep = delta ? held.slice(0, Math.max(0, from - base)) : []
  // Per-message reuse: an entry equal to the one held at its place keeps that object.
  const tail = incoming.map((msg, j) => {
    const old = held[keep.length + j]
    return old && sameJson(old, msg) ? old : msg
  })
  let messages = keep.length ? keep.concat(tail) : tail
  if (messages.length > limit) messages = messages.slice(-limit)
  if (messages.length === held.length && messages.every((msg, i) => msg === held[i])) messages = held
  if (prev && messages === prev.messages && screen === prev.screen && truncated === prev.truncated && status === prev.status && name === prev.name && total === prev.total) return prev
  return { messages, truncated, status, name, total, screen, key: '' }
}

/** The cursor a chat poll sends: only for the same host / session / limit it was answered for. */
export type CursorRef = { key: string; cursor: string } | null
export const cursorFor = (ref: CursorRef, key: string): string => (ref && ref.key === key ? ref.cursor : '')
export const nextCursor = (key: string, data: Partial<MessagesResponse>): CursorRef => ({ key, cursor: typeof data.cursor === 'string' ? data.cursor : '' })

export const parseMode = (raw: string): DetailMode => (raw === 'term' ? 'term' : 'chat')

/** A stored size must be one of `sizes`; anything else is the middle one. */
export function parseSize(sizes: readonly number[]) {
  return (raw: string): number | undefined => {
    const n = Number(raw)
    return sizes.includes(n) ? n : undefined
  }
}

/** Next size up/down, clamped. An unknown current size counts as the middle one. */
export function stepSize(sizes: readonly number[], current: number, dir: 1 | -1): number {
  const i = sizes.indexOf(current)
  return sizes[Math.min(sizes.length - 1, Math.max(0, (i === -1 ? 1 : i) + dir))]
}

export function nextChatLimit(current: number): number | null {
  return CHAT_LIMITS.find((n) => n > current) ?? null
}

export const msgKind = (m: Message | null | undefined): string => String(m?.kind || m?.role || 'assistant')

/** Interim = assistant narration between tool calls (`final: false`). */
export const isInterim = (m: Message) => m.role === 'assistant' && m.final === false

/** Same speaker, close in time → one caption for the whole burst. */
export function sameGroup(a: Message | undefined, b: Message | undefined): boolean {
  if (!a || !b) return false
  const ka = msgKind(a)
  if (ka !== msgKind(b)) return false
  if (ka === 'command' || ka === 'system') return false
  const ta = Number(a.ts)
  const tb = Number(b.ts)
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta <= 0 || tb <= 0) return false
  return Math.abs(tb - ta) <= GROUP_GAP_MS
}

export function visibleMessages(messages: Message[] | null | undefined, hideInterim: boolean): Message[] {
  const list = Array.isArray(messages) ? messages : []
  return hideInterim ? list.filter((m) => !isInterim(m)) : list
}

/** The follow-scroll rule: "at the bottom" = within `slack` px of it. */
export function nearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack: number): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

export type TextPart = { pasted: false; text: string } | { pasted: true; text: string }

// Claude Code repeats the id on the closing tag: `<pasted_content id="ab12">…</pasted_content id="ab12">`.
const PASTED_RE = /<pasted_content(?:\s[^>]*)?>([\s\S]*?)<\/pasted_content(?:\s[^>]*)?>/g

/** Split a user prompt into typed text and `<pasted_content>` blocks (tags dropped, blank edges trimmed). */
export function splitPasted(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(PASTED_RE)) {
    const before = text.slice(last, m.index).trim()
    if (before) parts.push({ pasted: false, text: before })
    const body = m[1].replace(/^\n+|\s+$/g, '')
    if (body) parts.push({ pasted: true, text: body })
    last = m.index + m[0].length
  }
  const rest = text.slice(last).trim()
  if (rest || !parts.length) parts.push({ pasted: false, text: last ? rest : text })
  return parts.filter((p) => p.text)
}
