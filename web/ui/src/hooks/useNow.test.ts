import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { AGO_FAST_MS, AGO_SLOW_MS, agoEvery, tickerNow, tickerSubscribe } from './useNow'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

test('one timer per interval, shared by every subscriber, released at 0', () => {
  const a = vi.fn()
  const b = vi.fn()
  const offA = tickerSubscribe(1000, a)
  const offB = tickerSubscribe(1000, b)
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(1000)
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)
  expect(tickerNow(1000)).toBe(1_001_000)
  const offC = tickerSubscribe(5000, vi.fn())
  expect(vi.getTimerCount()).toBe(2)
  offA()
  expect(vi.getTimerCount()).toBe(2)
  offB()
  offC()
  expect(vi.getTimerCount()).toBe(0)
})

test('joining a running clock whose tick is a second or more old bumps it for everyone', () => {
  const first = vi.fn()
  const off = tickerSubscribe(30_000, first)
  const start = tickerNow(30_000)
  vi.advanceTimersByTime(500)
  const offFresh = tickerSubscribe(30_000, vi.fn())
  expect(tickerNow(30_000)).toBe(start) // under a second: no bump
  vi.advanceTimersByTime(10_000)
  const offLate = tickerSubscribe(30_000, vi.fn())
  expect(tickerNow(30_000)).toBe(start + 10_500)
  expect(first).toHaveBeenCalledTimes(1)
  off()
  offFresh()
  offLate()
})

test('a stopped clock reads fresh for its next first reader', () => {
  const off = tickerSubscribe(60_000, vi.fn())
  off()
  vi.advanceTimersByTime(120_000)
  expect(tickerNow(60_000)).toBe(Date.now())
})

test('a fast clock reads fresh after its own interval, not after a whole second', () => {
  const off = tickerSubscribe(250, vi.fn())
  off()
  vi.advanceTimersByTime(300)
  expect(tickerNow(250)).toBe(Date.now())
})

test('relative-time cadence: 1 s while a label shows seconds, 30 s once it shows minutes', () => {
  const now = 10_000_000
  expect(agoEvery(now, now - 59_999)).toBe(AGO_FAST_MS)
  expect(agoEvery(now, now - 60_000)).toBe(AGO_SLOW_MS)
  expect(agoEvery(now, now - 3 * 3_600_000)).toBe(AGO_SLOW_MS)
  expect(agoEvery(now, now + 5_000)).toBe(AGO_FAST_MS) // ahead of the clock: "0s"
  expect(agoEvery(now, null, undefined, 0)).toBe(AGO_SLOW_MS) // nothing shown
  expect(agoEvery(now, now - 3_600_000, now - 2_000)).toBe(AGO_FAST_MS) // any young part of a composite
  expect(agoEvery(now)).toBe(AGO_SLOW_MS)
})
