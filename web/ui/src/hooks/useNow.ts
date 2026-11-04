import { useSyncExternalStore } from 'react'

/**
 * One shared clock per interval: every `useNow(ms)` with the same `ms` reads one cached tick from
 * one timer (N leaves ticking = one timer, one batched commit). The timer runs while anything
 * subscribes; a subscriber joining an entry whose tick is older than min(ms, 1 s) bumps it first,
 * so a slow clock (30 s, 60 s) never paints a stale label and a fast one (250 ms) never lags.
 * Relative-time labels use `useAgoNow` instead: 1 s while they show seconds, 30 s after.
 */
interface Ticker {
  last: number
  subs: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
  subscribe: (fn: () => void) => () => void
  get: () => number
}

const tickers = new Map<number, Ticker>()

function emit(t: Ticker) {
  for (const fn of t.subs) fn()
}

function ticker(ms: number): Ticker {
  const known = tickers.get(ms)
  if (known) return known
  const staleMs = Math.min(ms, 1000)
  const entry: Ticker = {
    last: Date.now(),
    subs: new Set(),
    timer: null,
    // Nobody holds the old tick while the clock is stopped: a first reader gets a fresh one.
    get: () => {
      if (!entry.subs.size && Date.now() - entry.last >= staleMs) entry.last = Date.now()
      return entry.last
    },
    subscribe: (fn) => {
      if (Date.now() - entry.last >= staleMs) {
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

/** The shared `ms` clock outside React: subscribe (returns the unsubscribe; tests) and read its tick. */
export const tickerSubscribe = (ms: number, fn: () => void): (() => void) => ticker(ms).subscribe(fn)
export const tickerNow = (ms: number): number => ticker(ms).get()

/** Current time from the shared `ms` clock (above), re-rendering the caller on each tick. */
export function useNow(ms = 1000): number {
  const t = ticker(ms)
  return useSyncExternalStore(t.subscribe, t.get, t.get)
}

export const AGO_FAST_MS = 1000
export const AGO_SLOW_MS = 30_000

/**
 * The clock a relative-time label needs: `relTime` shows seconds under a minute, so 1 s while any
 * of `ats` is that young (or ahead of `now`), else 30 s (a minute label is at most 30 s late).
 */
export function agoEvery(now: number, ...ats: (number | null | undefined)[]): number {
  return ats.some((at) => at != null && at > 0 && now - at < 60_000) ? AGO_FAST_MS : AGO_SLOW_MS
}

/**
 * `useNow` for labels built with `relTime` from `ats`: the 1 s clock while one of them shows
 * seconds, the 30 s one after. The 1 s tick that crosses a minute re-renders onto the 30 s clock;
 * a new (younger) `at` arrives as a prop and re-renders back onto the 1 s one. The value never
 * goes back.
 */
export function useAgoNow(...ats: (number | null | undefined)[]): number {
  // The 1 s clock's tick, read without subscribing: it picks the cadence, and it keeps the value
  // from going back when the 30 s clock (cached tick up to 30 s old) takes over.
  const fast = tickerNow(AGO_FAST_MS)
  return Math.max(useNow(agoEvery(fast, ...ats)), fast)
}
