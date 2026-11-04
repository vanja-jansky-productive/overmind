import { expect, test, vi } from 'vitest'

import { createStamp } from './useStamp'

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

test('a stamp never moves backwards', () => {
  const a = createStamp(100)
  const l = vi.fn()
  a.subscribe(l)
  a.set(50)
  a.set(Number.NaN)
  expect(a.get()).toBe(100)
  expect(l).not.toHaveBeenCalled()
  a.set(150)
  expect(a.get()).toBe(150)
})

test('force sets any value, back too, and notifies only on a change', () => {
  const a = createStamp(100)
  const l = vi.fn()
  a.subscribe(l)
  a.force(50)
  a.force(50)
  a.force(Number.NaN)
  expect(a.get()).toBe(50)
  expect(l).toHaveBeenCalledTimes(1)
})
