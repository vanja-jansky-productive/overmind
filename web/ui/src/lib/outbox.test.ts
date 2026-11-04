import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { Message } from '@/api/types'
import {
  Outbox,
  cancelPending,
  normalizeText,
  parseSendDelay,
  reconcile,
  restoreText,
  retry,
  sameText,
  schedule,
  secondsLeft,
  tailAnchor,
  SENT_TTL_MS,
  type OutboxItem,
} from './outbox'

const user = (text: string, ts: number): Message => ({ role: 'user', kind: 'user', text, ts })
const bot = (text: string, ts: number): Message => ({ role: 'assistant', kind: 'assistant', text, ts })
const item = (over: Partial<OutboxItem>): OutboxItem => ({
  id: 1,
  text: 'hi',
  state: 'sent',
  createdAt: 1000,
  dueAt: null,
  sentAt: 1000,
  anchor: '',
  error: null,
  ...over,
})

/** A send() whose promises the test resolves / rejects by hand. */
function fakeSend() {
  const calls: { text: string; resolve: () => void; reject: (e: unknown) => void }[] = []
  const send = vi.fn(
    (text: string) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ text, resolve, reject })
      }),
  )
  return { send, calls }
}

const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0)

describe('pure transitions', () => {
  test('schedule: one pending at a time — a second send flushes the first', () => {
    let items = schedule([], { id: 1, text: 'a', now: 0, delayMs: 3000, anchor: '' })
    expect(items.map((i) => i.state)).toEqual(['pending'])
    items = schedule(items, { id: 2, text: 'b', now: 500, delayMs: 3000, anchor: '' })
    expect(items.map((i) => [i.id, i.state, i.dueAt])).toEqual([
      [1, 'queued', null],
      [2, 'pending', 3500],
    ])
  })

  test('delay 0 queues at once', () => {
    expect(schedule([], { id: 1, text: 'a', now: 0, delayMs: 0, anchor: null })[0].state).toBe('queued')
  })

  test('cancelPending takes the pending one only', () => {
    const items = schedule(schedule([], { id: 1, text: 'a', now: 0, delayMs: 3000, anchor: '' }), { id: 2, text: 'b', now: 1, delayMs: 3000, anchor: '' })
    const { items: rest, cancelled } = cancelPending(items)
    expect(cancelled?.text).toBe('b')
    expect(rest.map((i) => i.id)).toEqual([1])
    expect(cancelPending(rest).cancelled).toBeNull()
  })

  test('retry moves a failed message to the back of the line', () => {
    const items = [item({ id: 1, state: 'failed', error: 'x' }), item({ id: 2, state: 'sent' })]
    const out = retry(items, 1, 'k')
    expect(out.map((i) => [i.id, i.state, i.anchor, i.error])).toEqual([
      [2, 'sent', '', null],
      [1, 'queued', 'k', null],
    ])
    expect(retry(out, 2, null)).toBe(out) // only failed ones
  })

  test('text normalization and matching', () => {
    expect(normalizeText('  a\r\n\n b\t ')).toBe('a b')
    expect(sameText('fix it', ' fix   it\n')).toBe(true)
    expect(sameText('fix it', 'fix it now')).toBe(false)
    expect(sameText('line 1\nline 2', '\n\n<pasted_content id="7eaf">\nline 1\nline 2\n</pasted_content id="7eaf">')).toBe(true)
    const long = 'please look at the attached screenshot and fix the layout'
    expect(sameText(`${long} /tmp/a.png`, `${long} [Image #1]`)).toBe(true)
  })

  test('restoreText: alone, or before what was typed since', () => {
    expect(restoreText('first', '')).toBe('first')
    expect(restoreText('first', '  ')).toBe('first')
    expect(restoreText('first\n', ' second')).toBe('first\n\nsecond')
  })

  test('secondsLeft rounds up and clamps', () => {
    expect(secondsLeft(3000, 0)).toBe(3)
    expect(secondsLeft(3000, 2001)).toBe(1)
    expect(secondsLeft(3000, 4000)).toBe(0)
    expect(secondsLeft(null, 0)).toBe(0)
  })

  test('parseSendDelay accepts only the offered values', () => {
    expect(parseSendDelay('0')).toBe(0)
    expect(parseSendDelay('5000')).toBe(5000)
    expect(parseSendDelay('1234')).toBeUndefined()
    expect(parseSendDelay('x')).toBeUndefined()
  })
})

describe('reconcile (dedupe against the transcript)', () => {
  const before = [user('yes', 100), bot('ok', 200)]

  test('tailAnchor: last user message; empty window → ""; not loaded → null', () => {
    expect(tailAnchor(before)).toBe('user|100|yes')
    expect(tailAnchor([bot('x', 1)])).toBe('')
    expect(tailAnchor(null)).toBeNull()
  })

  test('drops a sent bubble once its message shows after the anchor, not before', () => {
    const items = [item({ text: 'yes', anchor: tailAnchor(before), createdAt: 300, sentAt: 300 })]
    // The earlier identical "yes" is not it.
    expect(reconcile(items, before, 400)).toBe(items)
    const after = [...before, user(' yes\n', 350)]
    expect(reconcile(items, after, 400)).toEqual([])
  })

  test('matches in order: two identical sends need two transcript messages', () => {
    const anchor = tailAnchor(before)
    const items = [item({ id: 1, text: 'go', anchor }), item({ id: 2, text: 'go', anchor })]
    const one = [...before, user('go', 300)]
    expect(reconcile(items, one, 400).map((i) => i.id)).toEqual([2])
    const two = [...one, bot('…', 310), user('go', 320)]
    expect(reconcile(items, two, 400)).toEqual([])
  })

  test('pending, queued and failed bubbles are never matched', () => {
    const anchor = tailAnchor(before)
    const items = [item({ id: 1, text: 'go', state: 'pending', anchor }), item({ id: 2, text: 'go', state: 'failed', anchor })]
    expect(reconcile(items, [...before, user('go', 300)], 400)).toBe(items)
  })

  test('anchor unknown or scrolled out → by timestamp', () => {
    const items = [item({ text: 'go', anchor: null, createdAt: 100_000 })]
    // An old "go" (over a minute before the send) does not count; a recent one does.
    expect(reconcile(items, [user('go', 10_000)], 100_500)).toBe(items)
    expect(reconcile(items, [user('go', 10_000), user('go', 100_200)], 100_500)).toEqual([])
    const gone = [item({ text: 'go', anchor: 'user|1|scrolled away', createdAt: 100_000 })]
    expect(reconcile(gone, [bot('x', 99_990), user('go', 100_100)], 100_500)).toEqual([])
  })

  test('a sending message can match too (the transcript beat the POST)', () => {
    const items = [item({ text: 'go', state: 'sending', sentAt: null, anchor: tailAnchor(before) })]
    expect(reconcile(items, [...before, user('go', 300)], 400)).toEqual([])
  })

  test('an unmatched sent bubble expires', () => {
    const items = [item({ text: 'go', sentAt: 0, anchor: '' })]
    expect(reconcile(items, [], 60_000)).toBe(items)
    expect(reconcile(items, [], 3 * 60_000 + 1)).toEqual([])
  })
})

describe('Outbox (timers + one-at-a-time sender)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  test('waits out the delay, then sends; sending → sent', async () => {
    const { send, calls } = fakeSend()
    const onSent = vi.fn()
    const box = new Outbox({ send, onSent })
    box.add('hello', 3000, '')
    expect(box.getItems()[0].state).toBe('pending')
    await vi.advanceTimersByTimeAsync(2999)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledWith('hello')
    expect(box.getItems()[0].state).toBe('sending')
    calls[0].resolve()
    await flushMicrotasks()
    expect(box.getItems()[0].state).toBe('sent')
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  test('cancel within the window: never sent, text handed back', async () => {
    const { send } = fakeSend()
    const box = new Outbox({ send })
    box.add('oops', 3000, '')
    await vi.advanceTimersByTimeAsync(1500)
    expect(box.hasPending()).toBe(true)
    expect(box.cancel()?.text).toBe('oops')
    expect(box.getItems()).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(send).not.toHaveBeenCalled()
    expect(box.cancel()).toBeNull()
  })

  test('a second send flushes the first now; the second keeps its own window; order kept', async () => {
    const { send, calls } = fakeSend()
    const box = new Outbox({ send })
    box.add('one', 3000, '')
    await vi.advanceTimersByTimeAsync(1000)
    box.add('two', 3000, '')
    expect(send).toHaveBeenCalledTimes(1)
    expect(calls[0].text).toBe('one')
    // Esc now cancels "two", not "one".
    expect(box.cancel()?.text).toBe('two')
    box.add('three', 3000, '')
    calls[0].resolve()
    await vi.advanceTimersByTimeAsync(2999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.text)).toEqual(['one', 'three'])
  })

  test('one POST at a time, in order', async () => {
    const { send, calls } = fakeSend()
    const box = new Outbox({ send })
    box.add('a', 0, '')
    box.add('b', 0, '')
    box.add('c', 0, '')
    expect(calls.map((c) => c.text)).toEqual(['a'])
    calls[0].resolve()
    await flushMicrotasks()
    expect(calls.map((c) => c.text)).toEqual(['a', 'b'])
    calls[1].resolve()
    await flushMicrotasks()
    calls[2].resolve()
    await flushMicrotasks()
    expect(box.getItems().map((i) => i.state)).toEqual(['sent', 'sent', 'sent'])
  })

  test('failure: inline error, the next message still goes; retry / discard', async () => {
    const { send, calls } = fakeSend()
    const onError = vi.fn()
    const box = new Outbox({ send, onError, errorText: () => 'Session gone' })
    box.add('a', 0, '')
    box.add('b', 0, '')
    calls[0].reject(new Error('404'))
    await flushMicrotasks()
    const [a] = box.getItems()
    expect([a.state, a.error]).toEqual(['failed', 'Session gone'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(calls[1].text).toBe('b')
    calls[1].resolve()
    await flushMicrotasks()
    box.retry(a.id, 'x')
    expect(calls[2].text).toBe('a')
    calls[2].reject(new Error('again'))
    await flushMicrotasks()
    expect(box.discard(a.id)).toBe('a')
    expect(box.getItems().map((i) => i.text)).toEqual(['b'])
  })

  test('flush sends the pending one now (leaving the screen)', async () => {
    const { send } = fakeSend()
    const box = new Outbox({ send })
    box.add('bye', 3000, '')
    box.flush()
    expect(send).toHaveBeenCalledWith('bye')
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('takeUnsent hands over pending + queued (page unload) and never sends them itself', async () => {
    const { send, calls } = fakeSend()
    const box = new Outbox({ send })
    box.add('a', 0, '') // in flight
    box.add('b', 0, '') // queued behind it
    box.add('c', 3000, '') // counting down
    expect(box.takeUnsent().map((i) => i.text)).toEqual(['b', 'c'])
    calls[0].resolve()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.map((c) => c.text)).toEqual(['a'])
  })

  test('an unmatched sent bubble expires on its own timer, no transcript poll needed', async () => {
    const { send, calls } = fakeSend()
    const box = new Outbox({ send })
    box.reconcile([user('earlier', 1)])
    box.add('one', 0, '')
    calls[0].resolve()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    box.add('two', 0, '')
    calls[1].resolve()
    await flushMicrotasks()
    expect(box.getItems().map((i) => i.text)).toEqual(['one', 'two'])
    await vi.advanceTimersByTimeAsync(SENT_TTL_MS - 60_000)
    expect(box.getItems().map((i) => i.text)).toEqual(['one', 'two'])
    await vi.advanceTimersByTimeAsync(1)
    expect(box.getItems().map((i) => i.text)).toEqual(['two'])
    // The second one gets its own slot.
    await vi.advanceTimersByTimeAsync(60_000 - 1)
    expect(box.getItems().map((i) => i.text)).toEqual(['two'])
    await vi.advanceTimersByTimeAsync(1)
    expect(box.getItems()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  test('dispose leaves no timers; resume arms them again', async () => {
    const { send, calls } = fakeSend()
    const box = new Outbox({ send })
    box.add('sent', 0, '')
    calls[0].resolve()
    await flushMicrotasks()
    box.add('later', 3000, '')
    expect(vi.getTimerCount()).toBe(2)
    box.dispose()
    expect(vi.getTimerCount()).toBe(0)
    box.resume()
    expect(vi.getTimerCount()).toBe(2)
    box.flush()
    box.dispose()
    calls[1].resolve()
    await flushMicrotasks()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('reconcile drops the delivered bubble; subscribers hear every change', async () => {
    const { send, calls } = fakeSend()
    const box = new Outbox({ send })
    const listener = vi.fn()
    const off = box.subscribe(listener)
    box.add('go', 0, tailAnchor([user('earlier', 1)]))
    calls[0].resolve()
    await flushMicrotasks()
    box.reconcile([user('earlier', 1), user('go', 2)])
    expect(box.getItems()).toEqual([])
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3)
    off()
  })
})
