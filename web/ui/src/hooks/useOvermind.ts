import { createContext, useContext } from 'react'

import type { OvermindResponse } from '@/api/types'
import { storage } from '@/lib/storage'

export interface OvermindState {
  /** Last good /api/overmind body (or the localStorage snapshot before the first poll). */
  overmind: OvermindResponse | null
  /** When `overmind` was built (server `snapshotAt`, else receive time); 0 = never. */
  overmindAt: number
  /** Last poll error message; null after a successful poll. */
  error: string | null
  /** A poll is in flight. */
  refreshing: boolean
  /** Poll now (e.g. after a spawn/kill). */
  refresh: () => void
  /** Record a fresh /api/overmind body fetched elsewhere (e.g. a spawn watcher). */
  applyOvermind: (data: OvermindResponse) => void
}

export const OvermindContext = createContext<OvermindState | null>(null)

export function useOvermind(): OvermindState {
  const ctx = useContext(OvermindContext)
  if (!ctx) throw new Error('useOvermind() outside <OvermindProvider>')
  return ctx
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
