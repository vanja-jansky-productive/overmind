import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { ApiError, api, isAbortError } from '@/api/client'
import type { Task, TasksResponse } from '@/api/types'
import { useOvermind } from '@/hooks/useOvermind'
import { usePersistentState } from '@/hooks/usePersistentState'
import { usePoller } from '@/hooks/usePoller'
import { usePrs } from '@/hooks/usePrs'
import { TasksContext, type TasksState } from '@/hooks/useTasks'
import { allSessions } from '@/lib/sessions'
import { linkTasks } from '@/lib/tasks'

// The CLI refetches once its cache is older than `tasks.refresh` (5m); polling reads the cache.
const POLL_MS = 60_000
// What the CLI says when the host has no Productive token / organization set up.
const UNCONFIGURED_RE = /productive api token|tasks\.(token|organization)/i

/**
 * Your open Productive tasks, as one host's token sees them, polled app-wide so session rows
 * and PR cards can show the task they work on. Default host: the one this UI is served from;
 * the choice is remembered. Inside PrsProvider: sessions link to tasks through their PRs too.
 */
export function TasksProvider({ children }: { children: ReactNode }) {
  const { overmind } = useOvermind()
  const prs = usePrs()
  const hosts = useMemo(() => (overmind?.hosts ?? []).filter((h) => h.ok).map((h) => h.name), [overmind])
  const [picked, setHost] = usePersistentState<string>('overmind.tasksHost', '')
  const host = hosts.includes(picked) ? picked : (overmind?.self ?? hosts[0] ?? null)

  // Last answer and failure per host (switching back paints at once; null error = ok).
  const [answers, setAnswers] = useState<Record<string, TasksResponse>>({})
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const data = host ? (answers[host] ?? null) : null
  const error = host ? (errors[host] ?? null) : null
  const loading = !!host && !data && !(host in errors)

  const load = useCallback(
    async (signal: AbortSignal, refresh = false) => {
      if (!host) return
      try {
        const r = await api.tasks(host, { signal, refresh })
        setAnswers((a) => ({ ...a, [host]: r }))
        setErrors((e) => ({ ...e, [host]: null }))
      } catch (err) {
        if (isAbortError(err)) throw err
        // 404/501: that host's server or CLI predates `overmind tasks`.
        const old = err instanceof ApiError && (err.status === 404 || err.status === 501)
        const msg = old ? `${host} runs an older overmind — update it to see tasks` : (err as Error)?.message || 'could not load tasks'
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

  const setStatus = useCallback(
    async (t: Task, status: string) => {
      if (!host) return
      const r = await api.taskStatus(host, t.id, status)
      // Paint the move at once; the next read brings the server's view (its column too).
      if (r.task) {
        const moved = r.task
        setAnswers((a) => (a[host] ? { ...a, [host]: { ...a[host], tasks: a[host].tasks.map((x) => (x.id === moved.id ? moved : x)) } } : a))
      }
      reload()
    },
    [host, reload],
  )

  const unconfigured = !data && !!error && UNCONFIGURED_RE.test(error)
  const links = useMemo(
    () => linkTasks(data?.tasks ?? [], prs.data?.prs ?? [], prs.links, allSessions(overmind)),
    [data, prs.data, prs.links, overmind],
  )
  const value = useMemo<TasksState>(
    () => ({ hosts, host, setHost, data, error, unconfigured, loading, refresh, refreshing, reload, setStatus, links }),
    [hosts, host, setHost, data, error, unconfigured, loading, refresh, refreshing, reload, setStatus, links],
  )
  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}
