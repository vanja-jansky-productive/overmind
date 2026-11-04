import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { Ago } from '@/components/Ago'
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
