import { useSyncExternalStore } from 'react'

/**
 * A timestamp in a tiny external store: what moves on every poll ("updated 5s ago", "checked
 * 3s ago") lives here, so only the leaf that shows it re-renders — not the tree above it.
 * `set` is a no-op when the value is unchanged.
 */
export interface Stamp {
  get: () => number
  set: (at: number) => void
  subscribe: (fn: () => void) => () => void
}

export function createStamp(initial = 0): Stamp {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (at) => {
      if (at === value) return
      value = at
      for (const fn of listeners) fn()
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
