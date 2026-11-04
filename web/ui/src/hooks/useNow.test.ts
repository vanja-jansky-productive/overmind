import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { tickerNow, tickerSubscribe } from './useNow'

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
