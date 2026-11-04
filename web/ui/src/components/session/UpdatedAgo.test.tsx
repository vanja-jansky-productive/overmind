import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { Ago } from '@/components/Ago'
import { AGO_SLOW_MS, tickerSubscribe } from '@/hooks/useNow'
import { createStamp } from '@/hooks/useStamp'

import { UpdatedAgo } from './UpdatedAgo'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000_000)
})
afterEach(() => vi.useRealTimers())

test('the header says "connecting…" until the mode has a capture, then how old it is', () => {
  const stamp = createStamp()
  expect(renderToStaticMarkup(<UpdatedAgo stamp={stamp} connected={false} />)).toBe('· connecting…')
  expect(renderToStaticMarkup(<UpdatedAgo stamp={stamp} connected />)).toBe('· connecting…') // no time yet
  stamp.set(10_000_000 - 5_000)
  expect(renderToStaticMarkup(<UpdatedAgo stamp={stamp} connected />)).toBe('· 5s ago')
  // terminal size changed: the old capture's time is still in the stamp, but nothing is shown yet
  expect(renderToStaticMarkup(<UpdatedAgo stamp={stamp} connected={false} />)).toBe('· connecting…')
})

test('<Ago> renders seconds and minutes', () => {
  expect(renderToStaticMarkup(<Ago at={10_000_000 - 12_000} />)).toBe('12s')
  expect(renderToStaticMarkup(<Ago at={10_000_000 - 5 * 60_000} />)).toBe('5m')
  expect(renderToStaticMarkup(<Ago at={null} />)).toBe('')
})

test('<Ago> on the 30 s clock never paints its cached tick, so it never goes back', () => {
  // A minute label elsewhere holds the 30 s clock; its tick is 29 s old here.
  const off = tickerSubscribe(AGO_SLOW_MS, () => {})
  vi.advanceTimersByTime(AGO_SLOW_MS - 1_000)
  const at = 10_000_000 - 31_000 // 60 s ago now; 31 s ago by the cached tick
  expect(renderToStaticMarkup(<Ago at={at} />)).toBe('1m') // not "31s": read from the 1 s clock, not the old tick
  expect(renderToStaticMarkup(<Ago at={Date.now() - 3_000} />)).toBe('3s') // a younger time reads the 1 s clock
  off()
})
