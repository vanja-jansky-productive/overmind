// Bots screen (`#/bots`, formerly `#/jobs`): agent sessions from a recipe per host (docs/cli.md → Bots) — pure helpers.
// In code a bot is still a job: the API, the types and `origin.job` keep that name.
import type { OvermindResponse, Job, JobRun, JobRunSession, Session } from '@/api/types'

export const isJobsLocation = (location: string) => /^\/(?:bots|jobs)(?:\/|$)/.test(location)

/** One host's answer to GET …/jobs. `error`: the host could not list its jobs (older CLI, down). */
export interface HostJobs {
  host: string
  jobs: Job[]
  error: string | null
}

/** Every job across hosts, stamped with its host, in host order then by name. */
export function flattenJobs(results: HostJobs[]): (Job & { host: string })[] {
  return results.flatMap((r) => [...r.jobs].sort((a, b) => a.name.localeCompare(b.name)).map((j) => ({ ...j, host: r.host })))
}

export const jobKey = (j: { host?: string; name: string }) => `${j.host ?? ''}/${j.name}`

const pad2 = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "today 07:00" / "tomorrow 07:00" / "yesterday 07:00" / "Mon 12.10. 07:00" (like `overmind jobs`). */
export function whenLabel(ms: number | null | undefined, now = Date.now()): string {
  const t = Number(ms)
  if (ms == null || !Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(new Date(now))) / 86_400_000)
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (diff === 0) return `today ${hhmm}`
  if (diff === 1) return `tomorrow ${hhmm}`
  if (diff === -1) return `yesterday ${hhmm}`
  return `${DAYS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}. ${hhmm}`
}

export type OutcomeTone = 'ok' | 'warn' | 'error' | 'muted'

/** How a run's outcome reads: spawned = ok, failed = error, missed / skipped = warn. */
export function outcomeTone(outcome: string | null | undefined): OutcomeTone {
  switch (outcome) {
    case 'spawned':
      return 'ok'
    case 'failed':
      return 'error'
    case 'missed':
    case 'skipped':
      return 'warn'
    default:
      return 'muted'
  }
}

export const OUTCOME_TEXT: Record<OutcomeTone, string> = {
  ok: 'text-status-busy',
  warn: 'text-status-waiting',
  error: 'text-destructive',
  muted: 'text-dimmer',
}

export interface RunTreeRow {
  session: JobRunSession
  depth: number
}

/**
 * A run's sessions as a tree, flattened in display order: each session followed by the ones it
 * spawned (indented one level deeper). A parent that is not in the run counts as none. Siblings
 * keep the order they started in.
 */
export function runTree(run: Pick<JobRun, 'sessions'>): RunTreeRow[] {
  const sessions = [...(run.sessions ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  const known = new Set(sessions.map((s) => s.tmuxSession))
  const children = new Map<string | null, JobRunSession[]>()
  for (const s of sessions) {
    const p = s.parent && known.has(s.parent) && s.parent !== s.tmuxSession ? s.parent : null
    const list = children.get(p)
    if (list) list.push(s)
    else children.set(p, [s])
  }
  const out: RunTreeRow[] = []
  const seen = new Set<string>()
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.tmuxSession)) continue // a cycle in hand-edited state
      seen.add(s.tmuxSession)
      out.push({ session: s, depth })
      walk(s.tmuxSession, depth + 1)
    }
  }
  walk(null, 0)
  // Anything only reachable through a cycle still shows, at the top level.
  for (const s of sessions) if (!seen.has(s.tmuxSession)) out.push({ session: s, depth: 0 })
  return out
}

/** The live session behind a run's tmux session: same host + tmux session in /api/overmind. */
export function liveSession(overmind: OvermindResponse | null | undefined, host: string, tmuxSession: string): Session | null {
  const entry = overmind?.hosts?.find((h) => h.name === host)
  const s = entry?.sessions?.find((x) => x.tmux_session === tmuxSession)
  return s ? { ...s, host: s.host ?? host } : null
}

/** "2 live · 1 needs you" for a job's live sessions; '' when none. */
export function liveSummary(job: Pick<Job, 'live'>): string {
  const live = job.live ?? []
  if (!live.length) return ''
  const waiting = live.filter((l) => l.status === 'waiting').length
  return `${live.length} live${waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}`
}

/** `keep` (seconds; null = never) as "closed after 24h". */
export function keepLabel(keep: number | null | undefined): string {
  if (keep == null) return 'kept forever'
  if (keep % 86400 === 0) return `closed after ${keep / 86400}d`
  if (keep % 3600 === 0) return `closed after ${keep / 3600}h`
  return `closed after ${Math.round(keep / 60)}m`
}

/** The job's first prompt, one line: the inline text or `file: <path>`. */
export function promptLabel(prompt: Job['prompt']): string {
  if (!prompt) return ''
  if ('inline' in prompt) return prompt.inline.replace(/\s+/g, ' ').trim()
  return `file: ${prompt.file}`
}
