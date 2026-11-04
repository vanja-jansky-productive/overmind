import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ApiError, api, isAbortError, sessionErrorMessage } from '@/api/client'
import type { Brief } from '@/api/types'
import { usePoller } from '@/hooks/usePoller'
import { briefTodos, retryMinutes, setTodoItem } from '@/lib/brief'

/** While open: refresh this often (GET never calls the model, so it is cheap). */
export const BRIEF_POLL_MS = 30_000
/** While a generation runs: poll until `generating` is false. */
export const BRIEF_GENERATING_POLL_MS = 2_500

function briefError(err: unknown): string {
  if (err instanceof ApiError && err.status === 501) return err.message || 'Briefs are not available on this server'
  // An older server has no brief routes at all: its generic 404, not "unknown session".
  if (err instanceof ApiError && err.status === 404 && err.message === 'not found') return 'This host’s overmind web server predates briefs — update and restart it'
  return sessionErrorMessage(err)
}

/**
 * A session's brief while `open`: GET on open, every 30s, every 2.5s while generating.
 * `regenerate()` (POST, 429 → toast), `save(body)` (PUT), `toggleTodo(i)` (optimistic PUT,
 * rolled back with a toast on failure). A poll that started before a local write is dropped,
 * so it can never paint over the edit.
 */
export function useBrief(host: string, id: string, open: boolean) {
  const key = `${host}/${id}`
  const [state, setState] = useState<{ key: string; brief: Brief } | null>(null)
  const [errorOf, setErrorOf] = useState<{ key: string; message: string } | null>(null)
  const brief = state?.key === key ? state.brief : null
  const error = errorOf?.key === key ? errorOf.message : null
  const [regenerating, setRegenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  // Bumped by every local write; `pending` counts writes in flight.
  const writes = useRef(0)
  const pending = useRef(0)
  // Set by regenerate(): the generatedAt before it, to tell "updated" from "nothing new" when it ends.
  const awaiting = useRef<{ key: string; before: string | null } | null>(null)

  const apply = useCallback(
    (b: Brief) => {
      // An unchanged poll keeps the same object: nothing re-renders.
      setState((prev) => (prev?.key === key && JSON.stringify(prev.brief) === JSON.stringify(b) ? prev : { key, brief: b }))
      setErrorOf(null)
      const a = awaiting.current
      if (a && a.key === key && !b.generating) {
        awaiting.current = null
        if (b.generatedAt && b.generatedAt !== a.before) toast.success('Brief updated', { duration: 1800 })
        else toast('Brief unchanged', { description: 'Nothing new to summarise, or the model call failed.' })
      }
    },
    [key],
  )

  const poll = useCallback(
    async (signal: AbortSignal) => {
      const seen = writes.current
      try {
        const b = await api.brief(host, id, { signal })
        if (seen !== writes.current || pending.current > 0) return
        apply(b)
      } catch (err) {
        if (isAbortError(err)) throw err
        setErrorOf({ key, message: briefError(err) })
      }
    },
    [host, id, key, apply],
  )

  const generating = !!brief?.generating
  const refresh = usePoller(poll, generating ? BRIEF_GENERATING_POLL_MS : BRIEF_POLL_MS, { enabled: open })

  const regenerate = async () => {
    if (regenerating || generating) return
    setRegenerating(true)
    try {
      await api.regenerateBrief(host, id)
      writes.current += 1 // a poll already in flight still says "not generating": drop it
      awaiting.current = { key, before: brief?.generatedAt ?? null }
      // generating → the poller restarts at the fast interval (and polls at once); nothing loaded yet → poll now.
      if (brief) setState({ key, brief: { ...brief, generating: true } })
      else refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const ms = (err.data as { retryAfterMs?: number } | null)?.retryAfterMs
        toast.error(`Brief updates capped — try again in ${retryMinutes(ms)} min`)
      } else toast.error('Could not update the brief', { description: briefError(err) })
    } finally {
      setRegenerating(false)
    }
  }

  /** PUT the body markdown. → true when saved. */
  const save = async (markdown: string): Promise<boolean> => {
    const mine = ++writes.current
    pending.current += 1
    setSaving(true)
    try {
      const b = await api.saveBrief(host, id, markdown)
      if (mine === writes.current) apply(b)
      return true
    } catch (err) {
      toast.error('Could not save the brief', { description: briefError(err) })
      return false
    } finally {
      pending.current -= 1
      setSaving(pending.current > 0)
    }
  }

  const toggleTodo = async (index: number) => {
    const prev = brief
    const todos = briefTodos(prev?.parsed)
    const item = todos[index]
    if (!prev || !item) return
    const markdown = setTodoItem(prev.markdown, index, !item.done)
    if (markdown == null) return
    const next = todos.map((t, i) => (i === index ? { ...t, done: !t.done } : t))
    const mine = ++writes.current
    pending.current += 1
    // The optimistic brief carries the new markdown too, so a second quick toggle builds on it.
    setState({ key, brief: { ...prev, markdown, parsed: { ...prev.parsed, todos: next, plan: next } } })
    try {
      const b = await api.saveBrief(host, id, markdown)
      if (mine === writes.current) apply(b)
    } catch (err) {
      if (mine === writes.current) setState({ key, brief: prev })
      toast.error('Could not update the todos', { description: briefError(err) })
    } finally {
      pending.current -= 1
    }
  }

  return { brief, error, generating, regenerating, saving, refresh, regenerate, save, toggleTodo }
}

export type BriefState = ReturnType<typeof useBrief>
