import { isAbortError } from '@/api/client'
import type { OvermindResponse } from '@/api/types'
import { overmindStamp, saveSnapshot, stampOvermind, withStampedClocks, type OvermindSnapshot } from '@/hooks/useOvermind'
import { setKnownHosts } from '@/lib/format'
import { closedKey, nextOvermind, type OvermindSnap } from '@/lib/sessions'

/** How long a closed session stays hidden from polls that still list it. */
export const CLOSED_HIDE_MS = 20_000
/** An unchanged body rewrites the localStorage snapshot at most this often (keeps its `at` fresh enough for the 6 h max age). */
export const SNAPSHOT_REWRITE_MS = 60_000

/** What OvermindProvider puts in context besides its callbacks; a new object only when one of these changes. */
export interface FeedState {
  overmind: OvermindResponse | null
  error: string | null
  refreshing: boolean
}

export interface OvermindFeed {
  get: () => FeedState
  subscribe: (fn: () => void) => () => void
  /** Record a body (from a poll or a caller): stamps move, state only when more than the clocks changed. */
  apply: (data: OvermindResponse) => void
  /** Hide a just-closed session now and from polls for CLOSED_HIDE_MS; the clocks stay. */
  drop: (host: string, id: string) => void
  /** One poll: `fetch` the body, apply it, clear or set `error`, end a refresh. Rethrows aborts. */
  poll: (fetch: (signal: AbortSignal) => Promise<OvermindResponse>, signal: AbortSignal) => Promise<void>
  /** An explicit refresh starts: `refreshing` until the next poll that is not aborted settles. */
  startRefresh: () => void
}

/**
 * The /api/overmind state machine behind OvermindProvider, outside React so it can be tested
 * (overmindFeed.test.ts). `snapshot` (the localStorage one) paints at once and sets the stamps.
 */
export function createOvermindFeed(
  snapshot: OvermindSnapshot | null,
  { now = Date.now, save = saveSnapshot }: { now?: () => number; save?: (s: OvermindSnapshot) => void } = {},
): OvermindFeed {
  setKnownHosts(snapshot?.overmind?.hosts)
  // A reload shows "updated 3m ago" / "checked 3m ago" at once.
  if (snapshot) stampOvermind(snapshot.overmind, snapshot.at)
  let snap: OvermindSnap = { overmind: snapshot?.overmind ?? null, key: null }
  let state: FeedState = { overmind: snap.overmind, error: null, refreshing: false }
  let savedAt = 0
  const closed = new Map<string, number>()
  const listeners = new Set<() => void>()

  const update = (patch: Partial<FeedState>) => {
    if ((Object.keys(patch) as (keyof FeedState)[]).every((k) => state[k] === patch[k])) return
    state = { ...state, ...patch }
    for (const fn of listeners) fn()
  }

  // Land a body whose clocks are already stamped. The snapshot is saved with the stamps' clocks,
  // not the body's: a kept or client-built body can carry clocks hours old.
  const land = (data: OvermindResponse) => {
    const t = now()
    const next = nextOvermind(snap, data, closed, t)
    if (!next.changed && t - savedAt < SNAPSHOT_REWRITE_MS) return
    savedAt = t
    save({ overmind: withStampedClocks(next.fresh), at: overmindStamp.get() || t })
    if (!next.changed) return
    snap = { overmind: next.overmind, key: next.key }
    setKnownHosts(next.overmind.hosts)
    update({ overmind: next.overmind })
  }

  const apply = (data: OvermindResponse) => {
    stampOvermind(data, data?.snapshotAt || now())
    land(data)
  }

  return {
    get: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    apply,
    drop: (host, id) => {
      closed.set(closedKey(host, id), now() + CLOSED_HIDE_MS)
      if (snap.overmind) land(snap.overmind)
    },
    poll: async (fetch, signal) => {
      try {
        apply(await fetch(signal))
        update({ error: null })
      } catch (err) {
        if (isAbortError(err)) throw err
        update({ error: (err as Error)?.message || 'request failed' })
      } finally {
        // refresh() aborts the in-flight poll; the forced one that follows ends the refresh.
        if (!signal.aborted) update({ refreshing: false })
      }
    },
    startRefresh: () => update({ refreshing: true }),
  }
}
