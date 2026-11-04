import { expect, test, vi } from 'vitest'

import { createStamp } from './stamp'

test('a stamp notifies its own listeners when it moves, and only then', () => {
  const a = createStamp()
  const b = createStamp(5)
  const la = vi.fn()
  const lb = vi.fn()
  const off = a.subscribe(la)
  b.subscribe(lb)
  expect([a.get(), b.get()]).toEqual([0, 5])
  a.set(10)
  a.set(10)
  expect(a.get()).toBe(10)
  expect(la).toHaveBeenCalledTimes(1)
  expect(lb).not.toHaveBeenCalled()
  off()
  a.set(11)
  expect(la).toHaveBeenCalledTimes(1)
})
