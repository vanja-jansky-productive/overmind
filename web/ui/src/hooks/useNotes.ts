import { useEffect, useMemo, useState } from 'react'

import { ApiError, api, isAbortError } from '@/api/client'
import type { NoteFile, NotesSearch, NotesTree } from '@/api/types'
import { useOvermind } from '@/hooks/useOvermind'
import { usePoller } from '@/hooks/usePoller'
import { indexNotes } from '@/lib/notes'

const TREE_POLL_MS = 30_000
const SEARCH_DEBOUNCE_MS = 180

/** Hosts whose server has a notes explorer, self first (from /api/overmind host entries). */
export function useNotesHosts(): { name: string; label: string | null }[] {
  const { overmind } = useOvermind()
  return useMemo(() => (overmind?.hosts ?? []).filter((h) => h.notes).map((h) => ({ name: h.name, label: h.notes?.name ?? null })), [overmind])
}

// Last tree per host, kept across remounts so switching screens repaints at once.
const trees = new Map<string, NotesTree>()

/** The host's file list: at once from the cache, then polled every 30s while shown. */
export function useNotesTree(host: string | null) {
  const [state, setState] = useState<{ host: string | null; tree: NotesTree | null; error: string | null }>(() => ({
    host,
    tree: host ? (trees.get(host) ?? null) : null,
    error: null,
  }))
  if (state.host !== host) setState({ host, tree: host ? (trees.get(host) ?? null) : null, error: null })
  const refresh = usePoller(
    async (signal) => {
      if (!host) return
      try {
        const tree = await api.notesTree(host, { signal })
        trees.set(host, tree)
        setState((s) => (s.host === host ? { host, tree, error: null } : s))
      } catch (err) {
        if (isAbortError(err)) return
        const error = err instanceof ApiError && err.status === 501 ? `Notes are not configured on ${host}` : (err as Error)?.message || 'could not load notes'
        setState((s) => (s.host === host ? { ...s, error } : s))
      }
    },
    TREE_POLL_MS,
    { enabled: !!host },
  )
  const tree = state.host === host ? state.tree : null
  const index = useMemo(() => indexNotes(tree?.files ?? []), [tree])
  return { tree, index, error: state.host === host ? state.error : null, refresh }
}

/** Debounced search; the previous request is aborted when the query changes. */
export function useNotesSearch(host: string | null, q: string) {
  const query = q.trim()
  const [state, setState] = useState<{ key: string; data: NotesSearch | null; error: string | null; loading: boolean }>({ key: '', data: null, error: null, loading: false })
  const key = host && query ? `${host}\0${query}` : ''
  useEffect(() => {
    if (!key || !host) return
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      setState((s) => ({ ...s, key, loading: true, error: null }))
      api
        .notesSearch(host, query, 60, { signal: ctl.signal })
        .then((data) => setState({ key, data, error: null, loading: false }))
        .catch((err) => {
          if (!isAbortError(err)) setState({ key, data: null, error: (err as Error)?.message || 'search failed', loading: false })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [key, host, query])
  if (!key) return { data: null, error: null, loading: false, pending: false }
  // Results of the previous query stay up (dimmed by the caller) until the new ones land.
  return { data: state.data, error: state.key === key ? state.error : null, loading: state.loading || state.key !== key, pending: state.key !== key }
}

/** One note; reloaded when the tree reports a new mtime for it. */
export function useNoteFile(host: string | null, path: string | null, mtime: number | undefined) {
  const [state, setState] = useState<{ key: string; file: NoteFile | null; error: string | null }>({ key: '', file: null, error: null })
  const key = host && path ? `${host}\0${path}` : ''
  useEffect(() => {
    if (!key || !host || !path) return
    const ctl = new AbortController()
    api
      .noteFile(host, path, { signal: ctl.signal })
      .then((file) => setState({ key, file, error: null }))
      .catch((err) => {
        if (!isAbortError(err)) setState({ key, file: null, error: (err as Error)?.message || 'could not load the note' })
      })
    return () => ctl.abort()
  }, [key, host, path, mtime])
  if (!key || state.key !== key) return { file: null, error: null, loading: !!key }
  return { file: state.file, error: state.error, loading: false }
}
