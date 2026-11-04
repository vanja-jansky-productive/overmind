import { useSyncExternalStore } from 'react'

/**
 * A timestamp in a tiny external store: what moves on every poll ("updated 5s ago", "checked
 * 3s ago") lives here, so only the leaf that shows it re-renders — not the tree above it.
 * `set` only moves it forward (it ignores a value at or before the current one), so a body rebuilt
 * on the client from older clocks (a kept poll body) never makes a label jump back. `force` takes
 * any value: what the server just said wins, even behind the current one (its clock stepped back).
 */
export interface Stamp {
  get: () => number
  set: (at: number) => void
  force: (at: number) => void
  subscribe: (fn: () => void) => () => void
}

export function createStamp(initial = 0): Stamp {
  let value = initial
  const listeners = new Set<() => void>()
  const move = (at: number) => {
    value = at
    for (const fn of listeners) fn()
  }
  return {
    get: () => value,
    set: (at) => {
      if (at > value) move(at)
    },
    force: (at) => {
      if (Number.isFinite(at) && at !== value) move(at)
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
  }
}

/** The stamp's value, re-rendering the caller when it moves. */
export function useStamp(stamp: Stamp): number {
  return useSyncExternalStore(stamp.subscribe, stamp.get, stamp.get)
}
