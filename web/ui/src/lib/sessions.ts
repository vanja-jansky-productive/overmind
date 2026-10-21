// Session list logic: status metadata, filtering, search, sorting — pure, unit-tested.
import type { OvermindResponse, Session, SessionStatus } from '@/api/types'

export type StatusKey = SessionStatus
export interface StatusMeta {
  key: StatusKey
  /** Human label. */
  label: string
}

const STATUS_META: Record<StatusKey, StatusMeta> = {
  waiting: { key: 'waiting', label: 'needs you' },
  busy: { key: 'busy', label: 'working' },
  idle: { key: 'idle', label: 'idle' },
  unknown: { key: 'unknown', label: 'unknown' },
}

export function statusMeta(status: string | null | undefined): StatusMeta {
  const k = String(status || '').toLowerCase() as StatusKey
  return STATUS_META[k] ?? STATUS_META.unknown
}

/** "needs you · permission" for a waiting session with a reason, else the plain label. */
export function statusLabel(s: Pick<Session, 'status' | 'waiting_for'>): string {
  const meta = statusMeta(s.status)
  const why = typeof s.waiting_for === 'string' ? s.waiting_for.trim() : ''
  return meta.key === 'waiting' && why ? `${meta.label} · ${why}` : meta.label
}

export type StatusFilterId = 'all' | 'waiting' | 'busy' | 'idle' | 'scheduled'
export interface StatusFilter {
  id: StatusFilterId
  label: string
  match: (s: Session) => boolean
}

export const STATUS_FILTERS: StatusFilter[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'waiting', label: 'Needs you', match: (s) => statusMeta(s.status).key === 'waiting' },
  { id: 'busy', label: 'Busy', match: (s) => statusMeta(s.status).key === 'busy' },
  { id: 'idle', label: 'Idle', match: (s) => statusMeta(s.status).key === 'idle' },
  // Only the sessions bots started (every other filter leaves them out unless waiting).
  { id: 'scheduled', label: 'Bots', match: (s) => isJobSession(s) },
]

/** The filters worth a chip: "Bots" only when there are bot sessions, or it is the one picked. */
export function visibleStatusFilters(counts: Record<StatusFilterId, number> | null, current: StatusFilterId): StatusFilter[] {
  return STATUS_FILTERS.filter((f) => f.id !== 'scheduled' || current === 'scheduled' || (counts?.scheduled ?? 0) > 0)
}

export function findStatusFilter(id: string | null | undefined): StatusFilter {
  return STATUS_FILTERS.find((f) => f.id === id) ?? STATUS_FILTERS[0]
}

/** Every session across hosts (unreachable hosts contribute none), voice operators left out (they live in #/operator). */
export function allSessions(overmind: OvermindResponse | null | undefined): Session[] {
  const out: Session[] = []
  for (const host of overmind?.hosts ?? []) for (const s of host.sessions ?? []) if (!s.operator) out.push({ ...s, host: s.host ?? host.name })
  return out
}

export function matchesSearch(s: Session, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [s.display_title, s.name, s.gen_title, s.title, s.cwd, s.tmux_session, s.host]
    .filter((v): v is string => typeof v === 'string')
    .join('\n')
    .toLowerCase()
    .includes(q)
}

/** Most recent activity first (a flat list across hosts). */
export function byLastActivity(a: Session, b: Session): number {
  return (b.updated_at || 0) - (a.updated_at || 0)
}

export interface ListView {
  /** Sessions to show: search + host + status filter applied, sorted by last activity. */
  sessions: Session[]
  /** Per status-filter counts, after search + host scoping (what the chips show). */
  counts: Record<StatusFilterId, number>
}

/** A session a bot started (`origin`, docs/cli.md → Bots). */
export function isJobSession(s: Pick<Session, 'origin'>): boolean {
  return Boolean(s.origin?.job)
}

/**
 * Job sessions stay out of every filter but "Scheduled" — except one waiting on you, which
 * always shows (and always counts).
 */
export function hiddenAsScheduled(s: Session): boolean {
  return isJobSession(s) && statusMeta(s.status).key !== 'waiting'
}

/**
 * `host` null = every host. The "Scheduled" filter shows only job sessions; the others show the
 * rest, plus job sessions waiting on you.
 */
export function listView(
  overmind: OvermindResponse | null | undefined,
  { query = '', host = null, status = 'all' }: { query?: string; host?: string | null; status?: StatusFilterId },
): ListView {
  const matched = allSessions(overmind).filter((s) => (host == null || s.host === host) && matchesSearch(s, query))
  const visible = matched.filter((s) => !hiddenAsScheduled(s))
  const scope = (f: StatusFilter) => (f.id === 'scheduled' ? matched : visible).filter(f.match)
  const counts = Object.fromEntries(STATUS_FILTERS.map((f) => [f.id, scope(f).length])) as Record<StatusFilterId, number>
  return { sessions: clusterByStack(scope(findStatusFilter(status)).sort(byLastActivity)), counts }
}

/** Every session by status, job sessions included — the header's counters. */
export function statusSummary(overmind: OvermindResponse | null | undefined): Record<'waiting' | 'busy' | 'idle', number> {
  const out = { waiting: 0, busy: 0, idle: 0 }
  for (const s of allSessions(overmind)) {
    const k = statusMeta(s.status).key
    if (k === 'waiting' || k === 'busy' || k === 'idle') out[k] += 1
  }
  return out
}

/**
 * Keep the sessions of one stack adjacent: every stack moves up to the position of its first
 * member (members keep their relative order), everything else stays where it was. Stable, pure;
 * rows without `stack` (older servers) come back unchanged.
 */
/** A stack's identity across hosts: its home host + id; null when the session is in none. */
function stackKey(s: Session): string | null {
  return s.stack?.id ? `${s.stack.host || s.host}/${s.stack.id}` : null
}

export function clusterByStack(sessions: Session[]): Session[] {
  // Keyed by the stack's home host: members on other hosts cluster with it.
  const key = stackKey
  const members = new Map<string, Session[]>()
  for (const s of sessions) {
    const k = key(s)
    if (!k) continue
    const list = members.get(k)
    if (list) list.push(s)
    else members.set(k, [s])
  }
  if (![...members.values()].some((l) => l.length > 1)) return sessions
  const out: Session[] = []
  const done = new Set<string>()
  for (const s of sessions) {
    const k = key(s)
    if (!k) out.push(s)
    else if (!done.has(k)) {
      done.add(k)
      out.push(...(members.get(k) ?? [s]))
    }
  }
  return out
}

export function findSession(overmind: OvermindResponse | null | undefined, host: string, id: string): Session | null {
  const entry = overmind?.hosts?.find((h) => h.name === host)
  return entry?.sessions?.find((s) => s.session_id === id) ?? null
}

/** Hash route of a session's detail screen: `#/s/<host>/<session_id>`. */
export function sessionHref(s: Pick<Session, 'host' | 'session_id'>): string {
  return `/s/${encodeURIComponent(s.host)}/${encodeURIComponent(s.session_id)}`
}

/** Hosts a session can be spawned on: reachable ones, with the directories each advertises. */
export function spawnTargets(overmind: OvermindResponse | null | undefined): { name: string; dirs: { label: string; path: string }[] }[] {
  return (overmind?.hosts ?? [])
    .filter((h) => h.ok !== false)
    .map((h) => ({ name: h.name, dirs: Array.isArray(h.spawnDirs) ? h.spawnDirs : [] }))
}

/** The freshly spawned session, once Claude registered it: its tmux session (or name) matches. */
export function findSpawned(
  overmind: OvermindResponse | null | undefined,
  host: string,
  spawned: { tmuxSession?: string; name?: string },
): Session | null {
  const entry = overmind?.hosts?.find((h) => h.name === host)
  const tmux = spawned.tmuxSession || spawned.name
  return (
    entry?.sessions?.find((s) => (tmux && s.tmux_session === tmux) || (spawned.name && s.name === spawned.name)) ?? null
  )
}

/** The overmind minus one session (optimistic update after closing it). */
export function withoutSession(overmind: OvermindResponse, host: string, id: string): OvermindResponse {
  return {
    ...overmind,
    hosts: overmind.hosts.map((h) => (h.name === host ? { ...h, sessions: h.sessions.filter((s) => s.session_id !== id) } : h)),
  }
}

/** A list entry: one session, or the adjacent members of one stack (2 or more) shown as a group. */
export type ListEntry = { kind: 'session'; session: Session } | { kind: 'stack'; key: string; sessions: Session[] }

/**
 * Split a (clustered) list into entries: each run of 2+ adjacent members of one stack becomes a
 * `stack` entry, a lone member stays a plain `session`. Order is kept as given.
 */
export function stackRuns(sessions: Session[]): ListEntry[] {
  const out: ListEntry[] = []
  for (let i = 0; i < sessions.length; ) {
    const k = stackKey(sessions[i])
    let j = i + 1
    while (k && j < sessions.length && stackKey(sessions[j]) === k) j += 1
    if (k && j - i > 1) out.push({ kind: 'stack', key: k, sessions: sessions.slice(i, j) })
    else out.push({ kind: 'session', session: sessions[i] })
    i = j
  }
  return out
}
