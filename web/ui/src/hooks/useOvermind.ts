import { createContext, useContext } from 'react'

import type { OvermindResponse } from '@/api/types'
import { createStamp, useStamp, type Stamp } from '@/hooks/useStamp'
import { storage } from '@/lib/storage'

export interface OvermindState {
  /** Last good /api/overmind body (or the localStorage snapshot before the first poll). */
  overmind: OvermindResponse | null
  /** Last poll error message; null after a successful poll. */
  error: string | null
  /** An explicit refresh() is in flight (background polls do not show). */
  refreshing: boolean
  /** Poll now (e.g. after a spawn/kill). */
  refresh: () => void
  /** Record a fresh /api/overmind body fetched elsewhere (e.g. a spawn watcher). */
  applyOvermind: (data: OvermindResponse) => void
  /** Drop a just-closed session now and keep it out of polls for a while (in-flight polls and
   * server/peer caches can still list it for a few seconds). */
  dropSession: (host: string, id: string) => void
}

export const OvermindContext = createContext<OvermindState | null>(null)

export function useOvermind(): OvermindState {
  const ctx = useContext(OvermindContext)
  if (!ctx) throw new Error('useOvermind() outside <OvermindProvider>')
  return ctx
}

// The clocks of the last good body. They move on every poll, so they live in stamps (hooks/useStamp.ts)
// read by the leaves that show them, never in the context: an unchanged body re-renders nothing.

/** When the last good body was built (server `snapshotAt`, else receive time); 0 = never. */
export const overmindStamp = createStamp()
const hostStamps = new Map<string, Stamp>()

/** One host's "checked" clock (its `fetchedAt`). */
export function hostStamp(name: string): Stamp {
  let s = hostStamps.get(name)
  if (!s) hostStamps.set(name, (s = createStamp()))
  return s
}

/**
 * Move the clocks to a body: `at` for the list, each host's `fetchedAt` (else `at`) for that host.
 * A body built on the client (`exact` false) never moves them back. A poll body (`exact`) sets them
 * outright: the server's `snapshotAt` only goes back when its clock does, and a host's `fetchedAt`
 * comes from the peer's clock while it answers and from ours while it does not, so forward-only
 * would freeze a label for as long as one clock is ahead of the other.
 */
export function stampOvermind(overmind: OvermindResponse | null | undefined, at: number, exact = false): void {
  const move = (s: Stamp, v: number) => (exact ? s.force(v) : s.set(v))
  move(overmindStamp, at)
  for (const h of overmind?.hosts ?? []) move(hostStamp(h.name), h.fetchedAt || at)
}

/** `overmind` with the clocks the stamps hold now (the latest the server said, never a kept body's older ones). */
export function withStampedClocks(overmind: OvermindResponse): OvermindResponse {
  const at = overmindStamp.get()
  return {
    ...overmind,
    ...(at ? { snapshotAt: at } : {}),
    hosts: overmind.hosts.map((h) => {
      const checked = hostStamp(h.name).get()
      return checked ? { ...h, fetchedAt: checked } : h
    }),
  }
}

/** "updated Xs ago": when the session list was last fetched (0 = never). */
export function useOvermindAt(): number {
  return useStamp(overmindStamp)
}

/** "checked Xs ago": when this host last answered (or was last tried, when unreachable). */
export function useHostCheckedAt(name: string): number {
  return useStamp(hostStamp(name))
}

// A reload paints the last list instantly while the first poll runs.
export const SNAPSHOT_KEY = 'overmind.snapshot'
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** A snapshot from further ahead than this was saved under a clock that has since stepped back: dropped. */
export const SNAPSHOT_MAX_SKEW_MS = 5 * 60 * 1000

export interface OvermindSnapshot {
  overmind: OvermindResponse
  at: number
}

export function loadSnapshot(now = Date.now()): OvermindSnapshot | null {
  const parsed = storage.getJSON<OvermindSnapshot>(SNAPSHOT_KEY)
  if (!parsed || !Array.isArray(parsed.overmind?.hosts) || !parsed.at) return null
  if (now - parsed.at > SNAPSHOT_MAX_AGE_MS || parsed.at - now > SNAPSHOT_MAX_SKEW_MS) return null
  return parsed
}

export function saveSnapshot(snap: OvermindSnapshot): void {
  storage.setJSON(SNAPSHOT_KEY, snap)
}
