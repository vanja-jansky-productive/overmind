import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'

import { api } from '@/api/client'
import { OvermindContext, loadSnapshot, type OvermindState } from '@/hooks/useOvermind'
import { usePoller } from '@/hooks/usePoller'
import { createOvermindFeed } from '@/providers/overmindFeed'

export const OVERMIND_POLL_MS = 5000

/**
 * Polls /api/overmind every 5s (paused while the page is hidden) for the whole app. A body that
 * only moved its clocks (`snapshotAt`, hosts' `fetchedAt`) changes no state: the clocks go to the
 * stamps in hooks/useOvermind.ts, so idle polls re-render nothing. The decisions live in
 * providers/overmindFeed.ts; this wires them to the poller and the context.
 */
export function OvermindProvider({ children, pollMs = OVERMIND_POLL_MS }: { children: ReactNode; pollMs?: number }) {
  const [feed] = useState(() => createOvermindFeed(loadSnapshot()))
  const state = useSyncExternalStore(feed.subscribe, feed.get, feed.get)

  const poll = useCallback((signal: AbortSignal) => feed.poll((s) => api.overmind({ signal: s }), signal), [feed])
  const pollNow = usePoller(poll, pollMs)
  // Only an explicit refresh shows "refreshing…"; background polls stay silent.
  const refresh = useCallback(() => {
    feed.startRefresh()
    pollNow()
  }, [feed, pollNow])

  const value = useMemo<OvermindState>(
    () => ({ ...state, refresh, applyOvermind: feed.apply, dropSession: feed.drop }),
    [state, refresh, feed],
  )
  return <OvermindContext.Provider value={value}>{children}</OvermindContext.Provider>
}
