import { useCallback, useMemo, useState } from 'react'

import { ApiError, api, isAbortError } from '@/api/client'
import type { Job } from '@/api/types'
import { useOvermind } from '@/hooks/useOvermind'
import { usePoller } from '@/hooks/usePoller'
import { flattenJobs, type HostJobs } from '@/lib/jobs'

const POLL_MS = 30_000
const SHOW_POLL_MS = 15_000

// Last answers, kept across remounts so reopening the page paints at once.
let last: HostJobs[] = []

function errorText(err: unknown, what: string): string {
  // 404: that host's server predates the jobs routes; 501: its CLI predates `overmind jobs`.
  if (err instanceof ApiError && err.status === 404 && !/no (?:bot|job)/.test(err.message)) return 'runs an older overmind web — update it to see its bots'
  return (err as Error)?.message || `could not load ${what}`
}

/** Every reachable host's jobs (GET …/jobs), polled while shown. `patch` applies a job changed here. */
export function useJobs() {
  const { overmind } = useOvermind()
  const hosts = useMemo(() => (overmind?.hosts ?? []).filter((h) => h.ok !== false).map((h) => h.name), [overmind])
  const [results, setResults] = useState<HostJobs[]>(last)
  const [loading, setLoading] = useState(last.length === 0)
  const hostsKey = hosts.join('\n')

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!hosts.length) return
      const next = await Promise.all(
        hosts.map(async (host): Promise<HostJobs> => {
          try {
            return { host, jobs: (await api.jobs(host, { signal })).jobs ?? [], error: null }
          } catch (err) {
            if (isAbortError(err)) throw err
            return { host, jobs: [], error: errorText(err, 'jobs') }
          }
        }),
      )
      last = next
      setResults(next)
      setLoading(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hostsKey stands in for hosts
    [hostsKey],
  )

  const reload = usePoller((signal) => load(signal).catch(() => {}), POLL_MS, { enabled: hosts.length > 0 })

  /** Optimistic / server-confirmed change to one job (the enabled switch). */
  const patch = useCallback((host: string, name: string, change: Partial<Job>) => {
    setResults((prev) => {
      const next = prev.map((r) => (r.host === host ? { ...r, jobs: r.jobs.map((j) => (j.name === name ? { ...j, ...change } : j)) } : r))
      last = next
      return next
    })
  }, [])

  const jobs = useMemo(() => flattenJobs(results), [results])
  const errors = useMemo(() => results.filter((r) => r.error), [results])
  return { jobs, errors, loading: loading && hosts.length > 0, reload, patch }
}

/** One job with all its kept runs (GET …/jobs/:name), polled while `enabled` (the job is expanded). */
export function useJobShow(host: string, name: string, enabled: boolean) {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = usePoller(
    async (signal) => {
      try {
        setJob(await api.job(host, name, { signal }))
        setError(null)
      } catch (err) {
        if (isAbortError(err)) throw err
        setError(errorText(err, 'runs'))
      }
    },
    SHOW_POLL_MS,
    { enabled },
  )
  return { job, error, reload }
}
