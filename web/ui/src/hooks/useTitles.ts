// Inline title editing: which title is being edited, and the optimistic titles of renames
// in flight. A tiny module store (useSyncExternalStore) so a row, a board card and the
// session header showing the same session agree without prop drilling.
import { useCallback, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'

import { ApiError, api } from '@/api/client'
import type { RenameResponse, Session } from '@/api/types'
import { useOvermind } from '@/hooks/useOvermind'
import { sessionKey } from '@/lib/shortcuts'
import { PENDING_TTL_MS, renameFailure, sessionTitle, tmuxNote, validateTitle, type PendingTitle } from '@/lib/title'

/** Where a title is drawn — one session can be on screen in several places at once. */
export type TitleScope = 'row' | 'card' | 'header'

interface Pending extends PendingTitle {
  saving: boolean
}

interface State {
  editing: string | null
  pending: ReadonlyMap<string, Pending>
}

let state: State = { editing: null, pending: new Map() }
const listeners = new Set<() => void>()

function update(next: Partial<State>) {
  state = { ...state, ...next }
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const getState = () => state

function setPending(key: string, entry: Pending | null) {
  const pending = new Map(state.pending)
  if (entry) pending.set(key, entry)
  else pending.delete(key)
  update({ pending })
}

/** Open the inline editor for `key` (`host/session_id`) in `scope`; closes any other. */
export function startEditing(scope: TitleScope, key: string) {
  update({ editing: `${scope}:${key}` })
}

/** Open the editor from an event handler — synchronously, so the input's focus is part of the gesture (iOS keyboard). */
export function openTitleEditor(scope: TitleScope, key: string) {
  flushSync(() => startEditing(scope, key))
}

export function stopEditing() {
  if (state.editing != null) update({ editing: null })
}

/** Is the editor open for this session in this scope? */
export function useEditing(scope: TitleScope, key: string): boolean {
  const editing = useSyncExternalStore(subscribe, () => getState().editing)
  return editing === `${scope}:${key}`
}

/** The title to draw for `s` — optimistic while a rename is in flight — and whether it's saving. */
export function useSessionTitle(s: Session | null | undefined, fallbackKey?: string): { title: string; saving: boolean } {
  const key = s ? sessionKey(s) : (fallbackKey ?? '')
  const entry = useSyncExternalStore(subscribe, () => getState().pending.get(key) ?? null)
  return { title: sessionTitle(s, entry), saving: !!entry?.saving }
}

/**
 * `rename(session, raw)`: validates, shows the new title at once, POSTs the rename and
 * rolls back with a toast when it is refused (waiting on a prompt → 409) or fails. Resolves
 * true when `/rename` went out.
 */
export function useRename(): (s: Session, raw: string) => Promise<boolean> {
  const { refresh } = useOvermind()
  return useCallback(
    async (s: Session, raw: string) => {
      const check = validateTitle(raw)
      if (!check.ok) {
        toast.error(check.error)
        return false
      }
      const key = sessionKey(s)
      const at = Date.now()
      setPending(key, { title: check.title, at, saving: true })
      try {
        const res: RenameResponse = await api.rename(s.host, s.session_id, check.title)
        // Keep the optimistic title until the overmind shows it (sessionTitle drops it then).
        setPending(key, { title: check.title, at, saving: false })
        setTimeout(() => {
          if (state.pending.get(key)?.at === at) setPending(key, null)
        }, PENDING_TTL_MS)
        const note = tmuxNote(res.tmux)
        if (res.result === 'sent') toast.success(`Renamed to ${check.title}`, { description: note || 'Sent — the list catches up in a moment' })
        else toast.success(`Renamed to ${check.title}`, note ? { description: note } : undefined)
        // Now, and once more when the server's snapshot has certainly been rebuilt.
        refresh()
        setTimeout(refresh, 2500)
        return true
      } catch (err) {
        if (state.pending.get(key)?.at === at) setPending(key, null)
        const status = err instanceof ApiError ? err.status : 0
        const message = (err as Error)?.message ?? ''
        const f = renameFailure(status, message)
        if (status === 409) toast.warning(f.title, { description: f.description })
        else toast.error(f.title, { description: f.description })
        return false
      }
    },
    [refresh],
  )
}
