import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ApiError, api, sessionErrorMessage, type PrKey } from '@/api/client'
import type { PrDiffResponse, PrNotesState, ReviewAnchor } from '@/api/types'
import { usePoller } from '@/hooks/usePoller'

/** A PR moves only on a push: poll its diff (the server fetches at most once a minute) this often. */
export const PR_DIFF_POLL_MS = 30_000
export const PR_NOTES_POLL_MS = 30_000

function prError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404 && err.message === 'not found') return 'This host’s overmind web server predates reviewing PRs without a session — update and restart it'
  return sessionErrorMessage(err)
}

/** A PR's diff from the host's clone, polled with `since`; `refetch()` fetches the PR now. */
export function usePrDiff(host: string, pr: PrKey) {
  const key = `${host}/${pr.owner}/${pr.repo}/${pr.number}`
  const [data, setData] = useState<{ key: string; diff: PrDiffResponse } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<number | null>(null)
  const last = useRef<{ key: string; fingerprint: string } | null>(null)
  const force = useRef(false)

  const poll = useCallback(
    async (signal: AbortSignal) => {
      const since = last.current?.key === key ? last.current.fingerprint : null
      const refetch = force.current
      force.current = false
      try {
        const r = await api.prDiff(host, { owner: pr.owner, repo: pr.repo, number: pr.number }, since, refetch, { signal })
        setError(null)
        if (r.unchanged && since) return
        last.current = { key, fingerprint: r.fingerprint }
        setData({ key, diff: r })
        setChangedAt(Date.now())
      } catch (err) {
        if (signal.aborted) throw err
        setError(prError(err))
      }
    },
    [host, pr.owner, pr.repo, pr.number, key],
  )
  const refresh = usePoller(poll, PR_DIFF_POLL_MS)
  const refetch = useCallback(() => {
    force.current = true
    refresh()
  }, [refresh])
  return { data: data?.key === key ? data.diff : null, error, changedAt, refetch }
}

/**
 * The PR's review notes (kept in Overmind on the host), with the same actions as a session's
 * review threads where they make sense — plus `post` (one note → a GitHub review comment).
 */
export function usePrNotes(host: string, pr: PrKey) {
  const key = `${host}/${pr.owner}/${pr.repo}/${pr.number}`
  const ref = { owner: pr.owner, repo: pr.repo, number: pr.number }
  const [state, setState] = useState<{ key: string; review: PrNotesState } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const review = state?.key === key ? state.review : null

  const poll = useCallback(
    async (signal: AbortSignal) => {
      try {
        const r = await api.prNotes(host, { owner: pr.owner, repo: pr.repo, number: pr.number }, { signal })
        setState((prev) => (prev?.key === key && JSON.stringify(prev.review) === JSON.stringify(r) ? prev : { key, review: r }))
        setError(null)
      } catch (err) {
        if (signal.aborted) throw err
        setError(prError(err))
      }
    },
    [host, pr.owner, pr.repo, pr.number, key],
  )
  usePoller(poll, PR_NOTES_POLL_MS)

  const act = async (label: string, fn: () => Promise<PrNotesState>) => {
    try {
      setState({ key, review: await fn() })
      return true
    } catch (err) {
      toast.error(label, { description: prError(err) })
      return false
    }
  }

  return {
    review,
    error,
    /** A note: always kept (the `draft` flag of a session's comment does not apply). */
    comment: (anchor: ReviewAnchor, body: string, _draft: boolean, base: string | null) => act('Could not save the note', () => api.prNoteCreate(host, ref, { ...anchor, body, base })),
    reply: async () => false,
    edit: (thread: string, body: string) => act('Could not save the note', () => api.prNoteUpdate(host, ref, thread, { body })),
    resolve: (thread: string, resolved: boolean) => act('Could not update the note', () => api.prNoteUpdate(host, ref, thread, { resolved })),
    remove: (thread: string) => act('Could not delete the note', () => api.prNoteDelete(host, ref, thread)),
    post: (thread: string, headOid: string) => act('Could not post to GitHub', () => api.prNotePost(host, ref, thread, headOid)),
  }
}
