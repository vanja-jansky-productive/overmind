import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { ApiError, api, isAbortError } from '@/api/client'
import type { PrsResponse, PullRequest } from '@/api/types'
import { useOvermind } from '@/hooks/useOvermind'
import { usePoller } from '@/hooks/usePoller'
import { PrsContext, type PrsState } from '@/hooks/usePrs'
import { linkSessions, prRef } from '@/lib/prs'
import { allSessions } from '@/lib/sessions'

// The CLI refetches once its cache is older than `prs.refresh` (5m); polling reads the cache.
const POLL_MS = 60_000

/**
 * The PRs that need you, as one host's `gh` sees them (its login, its checkouts for
 * `local`), polled app-wide so session rows can show the PR they work on. The host: the one
 * this UI is served from (every host is the same you on GitHub).
 */
export function PrsProvider({ children }: { children: ReactNode }) {
  const { overmind } = useOvermind()
  const hosts = useMemo(() => (overmind?.hosts ?? []).filter((h) => h.ok).map((h) => h.name), [overmind])
  const host = overmind?.self && hosts.includes(overmind.self) ? overmind.self : (hosts[0] ?? null)

  // Last answer and failure per host (switching back paints at once; null error = ok).
  const [answers, setAnswers] = useState<Record<string, PrsResponse>>({})
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const data = host ? (answers[host] ?? null) : null
  const error = host ? (errors[host] ?? null) : null
  const loading = !!host && !data && !(host in errors)

  const load = useCallback(
    async (signal: AbortSignal, refresh = false) => {
      if (!host) return
      try {
        const r = await api.prs(host, { signal, refresh })
        setAnswers((a) => ({ ...a, [host]: r }))
        setErrors((e) => ({ ...e, [host]: null }))
      } catch (err) {
        if (isAbortError(err)) throw err
        // 404/501: that host's server or CLI predates `overmind prs`.
        const old = err instanceof ApiError && (err.status === 404 || err.status === 501)
        const msg = old ? `${host} runs an older overmind — update it to see pull requests` : (err as Error)?.message || 'could not load pull requests'
        setErrors((e) => ({ ...e, [host]: msg }))
      }
    },
    [host],
  )

  const reload = usePoller((signal) => load(signal).catch(() => {}), POLL_MS, { enabled: !!host })
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load(new AbortController().signal, true)
    } catch {
      reload()
    } finally {
      setRefreshing(false)
    }
  }, [load, reload])

  const markSeen = useCallback(
    async (p: PullRequest) => {
      if (!host) return
      await api.prSeen(host, prRef(p))
      reload()
    },
    [host, reload],
  )

  const links = useMemo(() => linkSessions(data?.prs ?? [], data ? host : null, allSessions(overmind)), [data, host, overmind])
  const value = useMemo<PrsState>(
    () => ({ host, data, error, loading, refresh, refreshing, reload, markSeen, links }),
    [host, data, error, loading, refresh, refreshing, reload, markSeen, links],
  )
  return <PrsContext.Provider value={value}>{children}</PrsContext.Provider>
}
