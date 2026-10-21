import { useMemo, useState } from 'react'

import { useOvermind } from '@/hooks/useOvermind'
import { usePersistentState } from '@/hooks/usePersistentState'
import { relTime } from '@/lib/format'
import { allSessions, findStatusFilter, listView, statusSummary, type StatusFilterId } from '@/lib/sessions'

export const ALL_HOSTS = '*'

/**
 * The session list's state, shared by the mobile list screen and the desktop sidebar:
 * search, status + host filters (persisted in `overmind.filter`; "Scheduled" is a status filter),
 * the filtered view, per-host counts, the header summary and the "updated Xs ago" note.
 */
export function useSessionList(now: number) {
  const { overmind, overmindAt, error, refreshing } = useOvermind()
  const [query, setQuery] = useState('')
  const [status, setStatus] = usePersistentState<StatusFilterId>('overmind.filter', 'all', (raw) => findStatusFilter(raw).id)
  const [hostFilter, setHostFilter] = usePersistentState<string>('overmind.hostFilter', ALL_HOSTS)

  const hosts = overmind?.hosts ?? []
  const hostNames = hosts.map((h) => h.name)
  // A remembered host that is no longer configured means "all".
  const host = hostFilter !== ALL_HOSTS && hostNames.includes(hostFilter) ? hostFilter : null

  const view = useMemo(() => listView(overmind, { query, host, status }), [overmind, query, host, status])
  const hostCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of allSessions(overmind)) counts.set(s.host, (counts.get(s.host) ?? 0) + 1)
    return counts
  }, [overmind])
  const summary = useMemo(() => statusSummary(overmind), [overmind])

  const unreachable = hosts.filter((h) => h.ok === false && (host == null || h.name === host))

  let note: { text: string; error?: boolean }
  if (!overmind && refreshing) note = { text: 'loading…' }
  else if (error) note = { text: 'offline — retrying', error: true }
  else if (refreshing) note = { text: 'refreshing…' }
  else note = { text: overmindAt ? `updated ${relTime(overmindAt, now)} ago` : '' }

  return {
    overmind,
    error,
    query,
    setQuery,
    status,
    setStatus,
    setHostFilter,
    hosts,
    hostNames,
    host,
    view,
    hostCounts,
    summary,
    unreachable,
    note,
  }
}

export type SessionListState = ReturnType<typeof useSessionList>
