import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'

import { api, isAbortError } from '@/api/client'
import type { OvermindResponse } from '@/api/types'
import { OvermindContext, loadSnapshot, overmindStamp, saveSnapshot, stampOvermind, type OvermindState } from '@/hooks/useOvermind'
import { usePoller } from '@/hooks/usePoller'
import { setKnownHosts } from '@/lib/format'
import { closedKey, nextOvermind, type OvermindSnap } from '@/lib/sessions'

export const OVERMIND_POLL_MS = 5000
/** How long a closed session stays hidden from polls that still list it. */
const CLOSED_HIDE_MS = 20_000
/** An unchanged body rewrites the localStorage snapshot at most this often (keeps its `at` fresh enough for the 6 h max age). */
const SNAPSHOT_REWRITE_MS = 60_000

/**
 * Polls /api/overmind every 5s (paused while the page is hidden) for the whole app. A body that
 * only moved its clocks (`snapshotAt`, hosts' `fetchedAt`) changes no state: the clocks go to the
 * stamps in hooks/useOvermind.ts, so idle polls re-render nothing.
 */
export function OvermindProvider({ children, pollMs = OVERMIND_POLL_MS }: { children: ReactNode; pollMs?: number }) {
  const [snap, setSnap] = useState<OvermindSnap>(() => {
    const s = loadSnapshot()
    setKnownHosts(s?.overmind?.hosts)
    // A reload shows "updated 3m ago" / "checked 3m ago" at once.
    if (s) stampOvermind(s.overmind, s.at)
    return { overmind: s?.overmind ?? null, key: null }
  })
  const snapRef = useRef(snap)
  const savedAt = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const closed = useRef(new Map<string, number>())

  /** Land a body (no clocks moved): state only when something but the clocks changed. */
  const land = useCallback((data: OvermindResponse, at: number) => {
    const now = Date.now()
    const next = nextOvermind(snapRef.current, data, closed.current, now)
    if (!next.changed && now - savedAt.current < SNAPSHOT_REWRITE_MS) return
    savedAt.current = now
    saveSnapshot({ overmind: next.fresh, at })
    if (!next.changed) return
    const value = { overmind: next.overmind, key: next.key }
    snapRef.current = value
    setKnownHosts(next.overmind.hosts)
    setSnap(value)
  }, [])

  const applyOvermind = useCallback(
    (data: OvermindResponse) => {
      const at = data?.snapshotAt || Date.now()
      stampOvermind(data, at)
      land(data, at)
    },
    [land],
  )

  // Re-lands the current body (its clocks are older than the stamps: leave those alone).
  const dropSession = useCallback(
    (host: string, id: string) => {
      closed.current.set(closedKey(host, id), Date.now() + CLOSED_HIDE_MS)
      const { overmind } = snapRef.current
      if (overmind) land(overmind, overmindStamp.get() || Date.now())
    },
    [land],
  )

  const poll = useCallback(
    async (signal: AbortSignal) => {
      try {
        applyOvermind(await api.overmind({ signal }))
        setError(null)
      } catch (err) {
        if (isAbortError(err)) throw err
        setError((err as Error)?.message || 'request failed')
      } finally {
        if (!signal.aborted && refreshingRef.current) {
          refreshingRef.current = false
          setRefreshing(false)
        }
      }
    },
    [applyOvermind],
  )

  const pollNow = usePoller(poll, pollMs)
  // Only an explicit refresh shows "refreshing…"; background polls stay silent.
  const refresh = useCallback(() => {
    refreshingRef.current = true
    setRefreshing(true)
    pollNow()
  }, [pollNow])

  const value = useMemo<OvermindState>(
    () => ({ overmind: snap.overmind, error, refreshing, refresh, applyOvermind, dropSession }),
    [snap, error, refreshing, refresh, applyOvermind, dropSession],
  )
  return <OvermindContext.Provider value={value}>{children}</OvermindContext.Provider>
}
