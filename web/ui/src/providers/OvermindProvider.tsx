import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'

import { api, isAbortError } from '@/api/client'
import type { OvermindResponse } from '@/api/types'
import { OvermindContext, loadSnapshot, saveSnapshot, type OvermindState } from '@/hooks/useOvermind'
import { usePoller } from '@/hooks/usePoller'
import { setKnownHosts } from '@/lib/format'
import { closedKey, withoutClosed } from '@/lib/sessions'

export const OVERMIND_POLL_MS = 5000
/** How long a closed session stays hidden from polls that still list it. */
const CLOSED_HIDE_MS = 20_000

/** Polls /api/overmind every 5s (paused while the page is hidden) for the whole app. */
export function OvermindProvider({ children, pollMs = OVERMIND_POLL_MS }: { children: ReactNode; pollMs?: number }) {
  const [snap, setSnap] = useState(() => {
    const s = loadSnapshot()
    setKnownHosts(s?.overmind?.hosts)
    return { overmind: s?.overmind ?? null, at: s?.at ?? 0 }
  })
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const closed = useRef(new Map<string, number>())

  const applyOvermind = useCallback((data: OvermindResponse) => {
    const now = Date.now()
    for (const [k, until] of closed.current) if (until <= now) closed.current.delete(k)
    const overmind = withoutClosed(data, closed.current, now)
    const at = data?.snapshotAt || now
    setKnownHosts(overmind?.hosts)
    setSnap({ overmind, at })
    saveSnapshot({ overmind, at })
  }, [])

  const dropSession = useCallback(
    (host: string, id: string) => {
      closed.current.set(closedKey(host, id), Date.now() + CLOSED_HIDE_MS)
      if (snap.overmind) applyOvermind(snap.overmind)
    },
    [snap.overmind, applyOvermind],
  )

  const poll = useCallback(
    async (signal: AbortSignal) => {
      setRefreshing(true)
      try {
        applyOvermind(await api.overmind({ signal }))
        setError(null)
      } catch (err) {
        if (isAbortError(err)) throw err
        setError((err as Error)?.message || 'request failed')
      } finally {
        if (!signal.aborted) setRefreshing(false)
      }
    },
    [applyOvermind],
  )

  const refresh = usePoller(poll, pollMs)

  const value = useMemo<OvermindState>(
    () => ({ overmind: snap.overmind, overmindAt: snap.at, error, refreshing, refresh, applyOvermind, dropSession }),
    [snap, error, refreshing, refresh, applyOvermind, dropSession],
  )
  return <OvermindContext.Provider value={value}>{children}</OvermindContext.Provider>
}
