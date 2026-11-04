import { expect, test } from 'vitest'

import type { FocusStatus } from '@/api/types'
import { sameFocus } from './useFocus'

const st = (over: Partial<FocusStatus>): FocusStatus => ({ host: 'laptop', active: false, remainingMs: 0, endsAt: null, apps: [], stale: false, ...over })

test('sameFocus ignores the countdown, nothing else', () => {
  expect(sameFocus(null, null)).toBe(true)
  expect(sameFocus(null, st({}))).toBe(false)
  expect(sameFocus(st({ active: true, endsAt: 5, remainingMs: 100 }), st({ active: true, endsAt: 5, remainingMs: 50 }))).toBe(true)
  expect(sameFocus(st({ active: true, endsAt: 5 }), st({ active: true, endsAt: 6 }))).toBe(false)
  expect(sameFocus(st({}), st({ active: true }))).toBe(false)
})
