import { useSyncExternalStore } from 'react'

/**
 * One shared clock per interval: every `useNow(ms)` with the same `ms` reads one cached tick from
 * one timer (N leaves ticking = one timer, one batched commit). The timer runs while anything
 * subscribes; a subscriber joining an entry whose tick is a second or more old bumps it first, so a
 * slow clock (30 s, 60 s) never paints a stale label.
 */
interface Ticker {
  last: number
  subs: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
  subscribe: (fn: () => void) => () => void
  get: () => number
}

const STALE_MS = 1000
const tickers = new Map<number, Ticker>()

function emit(t: Ticker) {
  for (const fn of t.subs) fn()
}

function ticker(ms: number): Ticker {
  const known = tickers.get(ms)
  if (known) return known
  const entry: Ticker = {
    last: Date.now(),
    subs: new Set(),
    timer: null,
    // Nobody holds the old tick while the clock is stopped: a first reader gets a fresh one.
    get: () => {
      if (!entry.subs.size && Date.now() - entry.last >= STALE_MS) entry.last = Date.now()
      return entry.last
    },
    subscribe: (fn) => {
      if (Date.now() - entry.last >= STALE_MS) {
        entry.last = Date.now()
        emit(entry)
      }
      entry.subs.add(fn)
      if (!entry.timer) {
        entry.timer = setInterval(() => {
          entry.last = Date.now()
          emit(entry)
        }, ms)
      }
      return () => {
        entry.subs.delete(fn)
        if (!entry.subs.size && entry.timer) {
          clearInterval(entry.timer)
          entry.timer = null
        }
      }
    },
  }
  tickers.set(ms, entry)
  return entry
}

/** Subscribe to the shared `ms` clock outside React (tests); returns the unsubscribe. */
export function tickerSubscribe(ms: number, fn: () => void): () => void {
  return ticker(ms).subscribe(fn)
}

/** The shared `ms` clock's current tick. */
export function tickerNow(ms: number): number {
  return ticker(ms).get()
}

/** Current time, re-rendering every `ms` — keeps "updated 5s ago" honest without refetching. */
export function useNow(ms = 1000): number {
  const t = ticker(ms)
  return useSyncExternalStore(t.subscribe, t.get, t.get)
}
