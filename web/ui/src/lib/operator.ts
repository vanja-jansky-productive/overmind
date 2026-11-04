// The voice operator screen (#/operator): pure helpers. The operator is a Claude session the
// server starts in its own workspace (web/lib/operator.mjs); the screen talks to it by voice —
// /api/transcribe in, the ordinary send route, its final replies read aloud with /api/speak.
import type { Message, Session } from '@/api/types'
import { sessionTitle } from '@/lib/title'

/** One line of the operator conversation. */
export interface Turn {
  role: 'user' | 'assistant'
  text: string
  ts: number | null
  /** Index in the transcript's messages: identifies a reply across polls. */
  key: string
}

/** What the conversation shows: the user's prompts and the operator's replies (not its narration between tool calls). */
export function conversation(messages: Message[]): Turn[] {
  const out: Turn[] = []
  messages.forEach((m, i) => {
    if (!m.text?.trim()) return
    if (m.kind === 'user' && m.role === 'user') out.push({ role: 'user', text: m.text, ts: m.ts ?? null, key: `${i}:${m.ts ?? ''}` })
    else if (m.kind === 'assistant' && m.final !== false) out.push({ role: 'assistant', text: m.text, ts: m.ts ?? null, key: `${i}:${m.ts ?? ''}` })
  })
  return out
}

/**
 * The reply to read aloud: the last assistant turn when it came after the user's last prompt
 * and the operator is done (not busy) — else null. `spoken`: the key of the reply already read.
 * `final`: the turn's last message is known to end it (Claude writes a message only once it is
 * complete, `stop_reason` included), so read it without waiting for the status to turn idle.
 */
export function replyToSpeak(turns: Turn[], status: string | null | undefined, spoken: string | null, { final = false } = {}): Turn | null {
  if (status === 'busy' && !final) return null
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'assistant' || last.key === spoken) return null
  return last
}

/** A session's identity across polls. */
export const sessionKey = (s: Pick<Session, 'host' | 'session_id'>) => `${s.host}/${s.session_id}`

/** The sessions that started waiting since `before` (keys of the ones already waiting), the operator itself excluded. */
export function newlyWaiting(sessions: Session[], before: Set<string>, operatorKey: string | null): Session[] {
  return sessions.filter((s) => s.status === 'waiting' && !before.has(sessionKey(s)) && sessionKey(s) !== operatorKey)
}

/** The waiting sessions' keys, for the next `newlyWaiting`. */
export function waitingKeys(sessions: Session[]): Set<string> {
  return new Set(sessions.filter((s) => s.status === 'waiting').map(sessionKey))
}

/** A short spoken heads-up for sessions that just started waiting (no model call: read as is). */
export function waitingAnnouncement(sessions: Session[]): string {
  if (!sessions.length) return ''
  const names = sessions.map((s) => sessionTitle(s))
  if (names.length === 1) return `${names[0]} te čeka.`
  return `Čekaju te: ${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}.`
}

/** Markdown as the browser's own voice should read it (the server does this for /api/speak). */
export function plainSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

// The speech endpoint takes up to 4096 characters (the server reads at most 4000).
const SPEAK_MAX_CHARS = 4000

/**
 * `text` as plain speech in pieces read one after another: a short first piece (one or two
 * sentences) so the voice starts within a second, then pieces of up to ~500 characters, voiced
 * while the first one plays. A short text stays one piece.
 */
export function speechChunks(text: string, { first = 200, rest = 500, min = 60 } = {}): string[] {
  const plain = plainSpeech(text).slice(0, SPEAK_MAX_CHARS)
  if (!plain) return []
  if (plain.length <= first) return [plain]
  const sentences = plain.split(/(?<=[.!?…])\s+/)
  // A long first sentence is cut at its last comma before `first`, so the voice still starts soon.
  const head = sentences[0]
  const comma = head.length > first ? head.lastIndexOf(', ', first) : -1
  if (comma >= min) sentences.splice(0, 1, head.slice(0, comma + 1), head.slice(comma + 2))
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    // The first piece: at least `min` characters (a lone "Done." would play and stall), then cut.
    const limit = out.length || cur.length < min ? rest : first
    if (cur && (cur.length + 1 + s.length > limit || (!out.length && cur.length >= min))) {
      out.push(cur)
      cur = s
    } else cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}

/** The language to read `text` in with the browser's voice: Croatian when it looks Croatian. */
export function speechLang(text: string): 'hr-HR' | 'en-US' {
  return /[čćžšđ]|\b(je|su|da|ne|na|što|sesij\w*|radi|čeka)\b/i.test(text) ? 'hr-HR' : 'en-US'
}

/** Reading speeds the rate button cycles through. */
export const SPEECH_RATES = [1, 1.25, 1.5, 2] as const

/** The next speed after `rate` (back to 1× after the fastest). */
export function nextRate(rate: number): number {
  const i = SPEECH_RATES.findIndex((r) => r === rate)
  return SPEECH_RATES[(i + 1) % SPEECH_RATES.length]
}

/** A stored speed, if it is one of SPEECH_RATES. */
export function parseRate(raw: string): number | undefined {
  const n = Number(raw)
  return (SPEECH_RATES as readonly number[]).includes(n) ? n : undefined
}
