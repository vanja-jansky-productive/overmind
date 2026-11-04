import { useMemo, useState } from 'react'

import { useOvermind } from '@/hooks/useOvermind'
import { usePersistentState } from '@/hooks/usePersistentState'
import { useSlack } from '@/hooks/useSlack'
import { DEFAULT_SELECTION, isShared, parseSelection, resolveSelection, serializeSelection, type HostSelection } from '@/lib/hosts'
import { allSessions, findStatusFilter, keepOrder, listView, slackLinked, statusSummary, type StatusFilterId } from '@/lib/sessions'

/**
 * The session list's state, shared by the mobile list screen and the desktop sidebar:
 * search, status + host filters (persisted in `overmind.filter` / `overmind.hostFilter`; Bots / Slack / Apps
 * are status filters; the host filter is a scope or a multi-select, lib/hosts.ts), the filtered view,
 * per-host counts, the header summary (own hosts only: a shared shed's sessions are not yours to
 * answer) and the list's status note (`listNote`; the "updated Xs ago" clock itself is
 * `useOvermindAt()` in the one place that shows it, so polls re-render nothing here).
 * While `frozen` (the pointer is on the list) the view keeps its order: rows don't move
 * under the mouse; the new order lands when it leaves.
 */
export function useSessionList() {
  const { overmind, error, refreshing } = useOvermind()
  const [query, setQuery] = useState('')
  const [status, setStatus] = usePersistentState<StatusFilterId>('overmind.filter', 'all', (raw) => findStatusFilter(raw).id)
  const [hostFilter, setHostFilter] = usePersistentState<string>('overmind.hostFilter', serializeSelection(DEFAULT_SELECTION))
  const selection = useMemo(() => parseSelection(hostFilter), [hostFilter])
  const setSelection = (sel: HostSelection) => setHostFilter(serializeSelection(sel))

  const hosts = useMemo(() => overmind?.hosts ?? [], [overmind])
  const hostNames = hosts.map((h) => h.name)
  // The hosts shown; a remembered host that is no longer configured drops out (lib/hosts.ts).
  const shown = useMemo(() => resolveSelection(selection, hosts), [selection, hosts])
  // Before the first snapshot there are no hosts to resolve against: show everything.
  const hostSet = hosts.length ? shown : null
  const ownHosts = useMemo(() => new Set(hosts.filter((h) => !isShared(h)).map((h) => h.name)), [hosts])

  const slackStatus = useSlack()
  const slack = useMemo(() => slackLinked(slackStatus?.enabled ? slackStatus.links : null), [slackStatus])
  const live = useMemo(() => listView(overmind, { query, hosts: hostSet, status, slack }), [overmind, query, hostSet, status, slack])
  // The order the list froze in (session keys); null when it follows the live order.
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null)
  const setFrozen = (on: boolean) => setFrozenOrder(on ? live.sessions.map((s) => `${s.host}/${s.session_id}`) : null)
  const view = useMemo(() => (frozenOrder ? { ...live, sessions: keepOrder(live.sessions, frozenOrder) } : live), [live, frozenOrder])
  const hostCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of allSessions(overmind)) counts.set(s.host, (counts.get(s.host) ?? 0) + 1)
    return counts
  }, [overmind])
  const summary = useMemo(() => statusSummary(overmind, ownHosts), [overmind, ownHosts])
  // Sessions waiting on each shared host: the rail's quiet hint that something happens there.
  const sharedWaiting = useMemo(() => {
    const out = new Map<string, number>()
    for (const h of hosts) {
      if (!isShared(h) || h.ok === false) continue
      out.set(h.name, h.sessions.filter((s) => s.status === 'waiting' && !s.operator).length)
    }
    return out
  }, [hosts])

  const unreachable = hosts.filter((h) => h.ok === false && (hostSet == null || hostSet.has(h.name)))

  const note = listNote(overmind, error, refreshing)

  return {
    overmind,
    error,
    query,
    setQuery,
    status,
    setStatus,
    selection,
    setSelection,
    hosts,
    hostNames,
    /** Host names the views show; null = all (no snapshot yet). */
    hostSet,
    sharedWaiting,
    view,
    setFrozen,
    hostCounts,
    summary,
    unreachable,
    note,
  }
}

export interface ListNote {
  text: string
  error?: boolean
}

/**
 * The list's status: "loading…" before the first body, "offline — retrying" on error, "refreshing…"
 * during an explicit refresh, else `updated` — the caller adds the age (`useOvermindAt()`).
 */
export function listNote(overmind: unknown, error: string | null, refreshing: boolean): ListNote {
  if (!overmind && !error) return { text: 'loading…' }
  if (error) return { text: 'offline — retrying', error: true }
  if (refreshing) return { text: 'refreshing…' }
  return { text: 'updated' }
}

export type SessionListState = ReturnType<typeof useSessionList>
