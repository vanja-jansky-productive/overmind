import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { api, isAbortError } from '@/api/client'
import type { OvermindResponse } from '@/api/types'
import { OvermindContext, loadSnapshot, saveSnapshot, type OvermindState } from '@/hooks/useOvermind'
import { usePoller } from '@/hooks/usePoller'

export const OVERMIND_POLL_MS = 5000

/** Polls /api/overmind every 5s (paused while the page is hidden) for the whole app. */
export function OvermindProvider({ children, pollMs = OVERMIND_POLL_MS }: { children: ReactNode; pollMs?: number }) {
  const [snap, setSnap] = useState(() => {
    const s = loadSnapshot()
    return { overmind: s?.overmind ?? null, at: s?.at ?? 0 }
  })
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const applyOvermind = useCallback((data: OvermindResponse) => {
    const at = data?.snapshotAt || Date.now()
    setSnap({ overmind: data, at })
    saveSnapshot({ overmind: data, at })
  }, [])

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
    () => ({ overmind: snap.overmind, overmindAt: snap.at, error, refreshing, refresh, applyOvermind }),
    [snap, error, refreshing, refresh, applyOvermind],
  )
  return <OvermindContext.Provider value={value}>{children}</OvermindContext.Provider>
}
