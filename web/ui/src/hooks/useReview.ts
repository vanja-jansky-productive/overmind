import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { ApiError, api, sessionErrorMessage } from '@/api/client'
import type { ReviewAnchor, ReviewState } from '@/api/types'
import { usePoller } from '@/hooks/usePoller'
import { threadPending } from '@/lib/review'

/** While an answer is on its way: read the transcript this often. */
export const REVIEW_PENDING_POLL_MS = 2_000
export const REVIEW_IDLE_POLL_MS = 10_000

function reviewError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404 && err.message === 'not found') return 'This host’s overmind web server predates review comments — update and restart it'
  return sessionErrorMessage(err)
}

/**
 * The session's review threads (answers read from its transcript on every GET) and the actions
 * on them. Each action answers with the whole state, which replaces ours.
 */
export function useReview(host: string, id: string) {
  const key = `${host}/${id}`
  const [state, setState] = useState<{ key: string; review: ReviewState } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const review = state?.key === key ? state.review : null
  const pending = !!review?.threads.some(threadPending)

  const poll = useCallback(
    async (signal: AbortSignal) => {
      try {
        const r = await api.review(host, id, { signal })
        // Polls mostly bring nothing new: keep the same object so the diff doesn't re-render.
        setState((prev) => (prev?.key === key && JSON.stringify(prev.review) === JSON.stringify(r) ? prev : { key, review: r }))
        setError(null)
      } catch (err) {
        if (signal.aborted) throw err
        setError(reviewError(err))
      }
    },
    [host, id, key],
  )
  const refresh = usePoller(poll, pending ? REVIEW_PENDING_POLL_MS : REVIEW_IDLE_POLL_MS)

  /** Run a mutation; its answer becomes the state. false when it failed (toast shown). */
  const act = useCallback(
    async (label: string, fn: () => Promise<ReviewState>) => {
      try {
        const r = await fn()
        setState({ key, review: r })
        refresh()
        return true
      } catch (err) {
        toast.error(label, { description: reviewError(err) })
        return false
      }
    },
    [key, refresh],
  )

  return {
    review,
    error,
    comment: (anchor: ReviewAnchor, body: string, draft: boolean, base: string | null) =>
      act(draft ? 'Could not save the comment' : 'Could not send the comment', () => api.reviewComment(host, id, { ...anchor, body, draft, base })),
    reply: (thread: string, body: string) => act('Could not send the reply', () => api.reviewReply(host, id, thread, body)),
    edit: (thread: string, body: string) => act('Could not save the draft', () => api.reviewUpdate(host, id, thread, { body })),
    resolve: (thread: string, resolved: boolean) => act('Could not update the thread', () => api.reviewUpdate(host, id, thread, { resolved })),
    remove: (thread: string) => act('Could not delete the thread', () => api.reviewDelete(host, id, thread)),
    submit: (body: string) => act('Could not submit the review', () => api.submitReview(host, id, body)),
  }
}

export type ReviewApi = ReturnType<typeof useReview>
