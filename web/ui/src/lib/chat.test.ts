import { expect, test } from 'vitest'

import type { Message, MessagesResponse } from '@/api/types'

import { CHAT_FONT_SIZES, cursorFor, mergeChat, nearBottom, nextChat, nextChatLimit, nextCursor, parseMode, parseSize, sameGroup, splitPasted, stepSize, visibleMessages } from './chat'

const m = (over: Partial<Message>): Message => ({ role: 'assistant', kind: 'assistant', text: 'x', ts: 1_000_000, ...over })

test('parseMode / parseSize', () => {
  expect(parseMode('term')).toBe('term')
  expect(parseMode('garbage')).toBe('chat')
  expect(parseSize(CHAT_FONT_SIZES)('17')).toBe(17)
  expect(parseSize(CHAT_FONT_SIZES)('16')).toBeUndefined()
})

test('stepSize clamps and treats unknown as the middle', () => {
  expect(stepSize([11, 12, 14], 12, 1)).toBe(14)
  expect(stepSize([11, 12, 14], 14, 1)).toBe(14)
  expect(stepSize([11, 12, 14], 11, -1)).toBe(11)
  expect(stepSize([11, 12, 14], 99, -1)).toBe(11)
})

test('nextChatLimit', () => {
  expect(nextChatLimit(60)).toBe(200)
  expect(nextChatLimit(200)).toBe(500)
  expect(nextChatLimit(500)).toBeNull()
})

test('sameGroup: same speaker within 2 minutes', () => {
  expect(sameGroup(m({}), m({ ts: 1_000_000 + 60_000 }))).toBe(true)
  expect(sameGroup(m({}), m({ ts: 1_000_000 + 3 * 60_000 }))).toBe(false)
  expect(sameGroup(m({}), m({ role: 'user', kind: 'user' }))).toBe(false)
  expect(sameGroup(m({ kind: 'command' }), m({ kind: 'command' }))).toBe(false)
  expect(sameGroup(m({ ts: null }), m({}))).toBe(false)
  expect(sameGroup(m({}), undefined)).toBe(false)
})

test('visibleMessages hides interim notes on demand', () => {
  const list = [m({ final: false }), m({ final: true }), m({ role: 'user', kind: 'user' })]
  expect(visibleMessages(list, false)).toHaveLength(3)
  expect(visibleMessages(list, true)).toHaveLength(2)
  expect(visibleMessages(null, true)).toEqual([])
})

test('nearBottom', () => {
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }, 60)).toBe(true)
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }, 60)).toBe(false)
})

test('splitPasted takes a closing tag that repeats the id', () => {
  expect(splitPasted('\n\n<pasted_content id="7eaf">\nline 1\nline 2\n</pasted_content id="7eaf">')).toEqual([
    { pasted: true, text: 'line 1\nline 2' },
  ])
})

test('splitPasted pulls <pasted_content> blocks out of a prompt', () => {
  expect(splitPasted('plain text')).toEqual([{ pasted: false, text: 'plain text' }])
  expect(splitPasted('Look at this:\n<pasted_content id="ab12">\nline 1\nline 2\n</pasted_content>\nthoughts?')).toEqual([
    { pasted: false, text: 'Look at this:' },
    { pasted: true, text: 'line 1\nline 2' },
    { pasted: false, text: 'thoughts?' },
  ])
  expect(splitPasted('<pasted_content id="x">only</pasted_content>')).toEqual([{ pasted: true, text: 'only' }])
})

test('nextChat: a poll that only moved the clocks keeps the old state object', () => {
  const body = { messages: [m({ text: 'hi' })], truncated: false, status: 'idle', name: 'alpha', capturedAt: 1 }
  const first = nextChat(null, body)
  expect(first).toMatchObject({ status: 'idle', name: 'alpha', truncated: false })
  expect(nextChat(first, { ...body, capturedAt: 2, messages: [m({ text: 'hi' })] })).toBe(first)
  const moved = nextChat(first, { ...body, status: 'busy' })
  expect(moved).not.toBe(first)
  expect(moved.status).toBe('busy')
  expect(nextChat(null, {})).toMatchObject({ messages: [], truncated: false, status: 'unknown', name: null })
})

// --- chat deltas (#37) -------------------------------------------------------

const u = (text: string) => m({ role: 'user', kind: 'user', text })
const a = (text: string) => m({ text })
const q = (id: string, question = 'Pick?', ts = 5) => m({ kind: 'question', id, ts, questions: [{ question, header: 'P', multiSelect: false, options: [{ label: 'A', description: '' }] }] })
type Body = Partial<MessagesResponse>
const body = (over: Body): Body => ({ status: 'idle', name: 'alpha', truncated: false, screen: null, cursor: 'c', ...over })
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

test('mergeChat: a legacy body (no cursor) behaves like nextChat', () => {
  const legacy = { messages: [a('hi')], truncated: false, status: 'idle', name: 'alpha' }
  const s = mergeChat(null, legacy, 60)
  expect(s).toMatchObject({ messages: [a('hi')], total: 1, screen: null })
  expect(mergeChat(s, clone(legacy), 60)).toBe(s)
  expect(mergeChat(s, { ...legacy, status: 'busy' }, 60).status).toBe('busy')
})

test('mergeChat: full replaces, same keeps the object, a delta keeps what is before `from`', () => {
  const full = mergeChat(null, body({ full: true, from: 0, total: 3, messages: [u('a'), a('b'), u('c')] }), 60)
  expect(full.messages.map((x) => x.text)).toEqual(['a', 'b', 'c'])
  expect(mergeChat(full, body({ full: false, from: 3, total: 3, messages: [] }), 60)).toBe(full)
  const grown = mergeChat(full, body({ full: false, from: 3, total: 4, messages: [a('d')] }), 60)
  expect(grown.messages.map((x) => x.text)).toEqual(['a', 'b', 'c', 'd'])
  expect(grown.messages[0]).toBe(full.messages[0])
  const replaced = mergeChat(grown, body({ full: false, from: 3, total: 4, messages: [a('d, longer')] }), 60)
  expect(replaced.messages.map((x) => x.text)).toEqual(['a', 'b', 'c', 'd, longer'])
  // Identical re-sent tail (a new cursor, nothing new to show) → the same object: no re-render.
  expect(mergeChat(replaced, body({ full: false, from: 3, total: 4, messages: [a('d, longer')], cursor: 'other' }), 60)).toBe(replaced)
  // The settled reply re-sent before a new prompt keeps its object (ChatView compares by identity).
  const next = mergeChat(replaced, body({ full: false, from: 3, total: 5, messages: [a('d, longer'), u('e')] }), 60)
  expect(next.messages[3]).toBe(replaced.messages[3])
  expect(next.messages.at(-1)?.text).toBe('e')
})

test('mergeChat: trims to the limit; a full answer after a new generation replaces without arithmetic', () => {
  const s = mergeChat(null, body({ full: true, from: 2, total: 5, truncated: true, messages: [u('2'), a('3'), u('4')] }), 3)
  const t = mergeChat(s, body({ full: false, from: 5, total: 7, truncated: true, messages: [a('5'), u('6')] }), 3)
  expect(t.messages.map((x) => x.text)).toEqual(['4', '5', '6'])
  expect(t.truncated).toBe(true)
  const g = mergeChat(t, body({ full: true, from: 0, total: 2, truncated: false, messages: [u('x'), a('y')] }), 3)
  expect(g.messages.map((x) => x.text)).toEqual(['x', 'y'])
  expect([g.total, g.truncated]).toEqual([2, false])
})

test('mergeChat: a delta outside what the client holds is treated as full', () => {
  const s = mergeChat(null, body({ full: true, from: 0, total: 2, messages: [u('a'), a('b')] }), 60)
  const bad = mergeChat(s, body({ full: false, from: 9, total: 10, messages: [u('z')] }), 60)
  expect(bad.messages.map((x) => x.text)).toEqual(['z'])
})

test('mergeChat: a queue removal (total shrinks) merges, it is not mistaken for "same"', () => {
  const queued = m({ role: 'user', kind: 'user', text: 'later', queued: true })
  const s = mergeChat(null, body({ full: true, from: 0, total: 3, messages: [u('a'), a('b'), queued] }), 60)
  const removed = mergeChat(s, body({ full: false, from: 2, total: 2, messages: [] }), 60)
  expect(removed).not.toBe(s)
  expect(removed.messages.map((x) => x.text)).toEqual(['a', 'b'])
})

test('mergeChat: the screen prompt — kept across a new ts, replaced when it changes, dropped when gone', () => {
  const s = mergeChat(null, body({ full: true, from: 0, total: 1, messages: [a('b')], screen: q('screen:1', 'Pick?', 5) }), 60)
  expect(s.screen?.id).toBe('screen:1')
  const sameQ = mergeChat(s, body({ full: false, from: 1, total: 1, messages: [], screen: q('screen:1', 'Pick?', 99) }), 60)
  expect(sameQ).toBe(s)
  expect(sameQ.screen?.ts).toBe(5)
  const other = mergeChat(s, body({ full: false, from: 1, total: 1, messages: [], screen: q('screen:2', 'Other?') }), 60)
  expect(other).not.toBe(s)
  expect(other.screen?.id).toBe('screen:2')
  const gone = mergeChat(other, body({ full: false, from: 1, total: 1, messages: [], screen: null }), 60)
  expect(gone.screen).toBeNull()
  expect(gone.messages).toBe(other.messages)
})

test('cursorFor / nextCursor: keyed by host/id/limit; a legacy body or an error resets it', () => {
  const ref = nextCursor('h/s/60', { cursor: 'abc' })
  expect(cursorFor(ref, 'h/s/60')).toBe('abc')
  expect(cursorFor(ref, 'h/s/200')).toBe('')
  expect(cursorFor(ref, 'h/other/60')).toBe('')
  expect(cursorFor(null, 'h/s/60')).toBe('')
  expect(cursorFor(nextCursor('h/s/60', { messages: [] }), 'h/s/60')).toBe('')
})
