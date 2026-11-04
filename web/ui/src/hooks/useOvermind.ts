import { createContext, useContext } from 'react'

import type { OvermindResponse } from '@/api/types'
import { createStamp, useStamp, type Stamp } from '@/lib/stamp'
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

// The clocks of the last good body. They move on every poll, so they live in stamps (lib/stamp.ts)
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

/** Move the clocks to a body: `at` for the list, each host's `fetchedAt` (else `at`) for that host. */
export function stampOvermind(overmind: OvermindResponse | null | undefined, at: number): void {
  overmindStamp.set(at)
  for (const h of overmind?.hosts ?? []) hostStamp(h.name).set(h.fetchedAt || at)
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

export interface OvermindSnapshot {
  overmind: OvermindResponse
  at: number
}

export function loadSnapshot(now = Date.now()): OvermindSnapshot | null {
  const parsed = storage.getJSON<OvermindSnapshot>(SNAPSHOT_KEY)
  if (!parsed || !Array.isArray(parsed.overmind?.hosts) || !parsed.at) return null
  if (now - parsed.at > SNAPSHOT_MAX_AGE_MS) return null
  return parsed
}

export function saveSnapshot(snap: OvermindSnapshot): void {
  storage.setJSON(SNAPSHOT_KEY, snap)
}
