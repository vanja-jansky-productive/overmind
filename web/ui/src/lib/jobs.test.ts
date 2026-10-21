import { expect, test } from 'vitest'

import type { OvermindResponse, Job, JobRunSession } from '@/api/types'
import { flattenJobs, isJobsLocation, keepLabel, liveSession, liveSummary, outcomeTone, promptLabel, runTree, whenLabel } from './jobs'

const job = (over: Partial<Job>): Job => ({
  name: 'triage',
  schedule: '0 7 * * 1-5',
  enabled: true,
  dir: '~/Code/project',
  harness: 'claude',
  model: null,
  command: 'claude',
  keep: 86400,
  prompt: null,
  nextRun: null,
  lastSlot: null,
  runs: [],
  live: [],
  ...over,
})

const rs = (tmuxSession: string, parent: string | null, at: number): JobRunSession => ({ tmuxSession, name: tmuxSession, parent, at, closedAt: null })

test('isJobsLocation', () => {
  expect(isJobsLocation('/jobs')).toBe(true)
  expect(isJobsLocation('/jobs/x')).toBe(true)
  expect(isJobsLocation('/bots')).toBe(true)
  expect(isJobsLocation('/bots/x')).toBe(true)
  expect(isJobsLocation('/botsx')).toBe(false)
  expect(isJobsLocation('/jobsx')).toBe(false)
  expect(isJobsLocation('/')).toBe(false)
})

test('flattenJobs: host order, then by name, stamped with the host', () => {
  const out = flattenJobs([
    { host: 'workstation', jobs: [job({ name: 'b' }), job({ name: 'a' })], error: null },
    { host: 'laptop', jobs: [job({ name: 'c' })], error: null },
    { host: 'down', jobs: [], error: 'timeout' },
  ])
  expect(out.map((j) => `${j.host}/${j.name}`)).toEqual(['workstation/a', 'workstation/b', 'laptop/c'])
})

test('whenLabel: today / tomorrow / yesterday / a date', () => {
  const now = new Date(2026, 9, 13, 12, 0).getTime()
  expect(whenLabel(new Date(2026, 9, 13, 7, 5).getTime(), now)).toBe('today 07:05')
  expect(whenLabel(new Date(2026, 9, 14, 7, 0).getTime(), now)).toBe('tomorrow 07:00')
  expect(whenLabel(new Date(2026, 9, 12, 23, 59).getTime(), now)).toBe('yesterday 23:59')
  expect(whenLabel(new Date(2026, 9, 19, 7, 0).getTime(), now)).toBe('Mon 19.10. 07:00')
  expect(whenLabel(null, now)).toBe('')
})

test('outcomeTone', () => {
  expect(outcomeTone('spawned')).toBe('ok')
  expect(outcomeTone('failed')).toBe('error')
  expect(outcomeTone('missed')).toBe('warn')
  expect(outcomeTone('skipped')).toBe('warn')
  expect(outcomeTone('new-thing')).toBe('muted')
})

test('runTree: children under their parent, siblings in start order, unknown parents at the top', () => {
  const rows = runTree({
    sessions: [
      rs('root', null, 1),
      rs('b', 'root', 3),
      rs('a', 'root', 2),
      rs('a-child', 'a', 4),
      rs('orphan', 'not-in-run', 5),
    ],
  })
  expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.session.tmuxSession}`)).toEqual(['root', '  a', '    a-child', '  b', 'orphan'])
  // A cycle (hand-edited state) still lists every session once.
  const cyc = runTree({ sessions: [rs('x', 'y', 1), rs('y', 'x', 2)] })
  expect(cyc.map((r) => r.session.tmuxSession).sort()).toEqual(['x', 'y'])
  expect(runTree({ sessions: [] })).toEqual([])
})

test('liveSession: by host + tmux session', () => {
  const overmind: OvermindResponse = {
    self: 'laptop',
    hosts: [
      { name: 'laptop', ok: true, sessions: [{ host: 'laptop', session_id: '1', tmux_session: 'triage-0101-0700' }] },
      { name: 'workstation', ok: true, sessions: [{ host: 'workstation', session_id: '2', tmux_session: 'triage-0101-0700' }] },
    ],
  }
  expect(liveSession(overmind, 'workstation', 'triage-0101-0700')?.session_id).toBe('2')
  expect(liveSession(overmind, 'laptop', 'gone')).toBeNull()
  expect(liveSession(null, 'laptop', 'x')).toBeNull()
})

test('liveSummary / keepLabel / promptLabel', () => {
  expect(liveSummary(job({}))).toBe('')
  const live = (status: string) => ({ run: 'r', sessionId: 's', tmuxSession: 't', status, title: null })
  expect(liveSummary(job({ live: [live('busy'), live('waiting')] }))).toBe('2 live · 1 needs you')
  expect(liveSummary(job({ live: [live('waiting'), live('waiting')] }))).toBe('2 live · 2 need you')
  expect(keepLabel(86400)).toBe('closed after 1d')
  expect(keepLabel(7200)).toBe('closed after 2h')
  expect(keepLabel(1800)).toBe('closed after 30m')
  expect(keepLabel(null)).toBe('kept forever')
  expect(promptLabel({ inline: ' triage\n the  inbox ' })).toBe('triage the inbox')
  expect(promptLabel({ file: '~/notes/triage.md' })).toBe('file: ~/notes/triage.md')
  expect(promptLabel(null)).toBe('')
})
