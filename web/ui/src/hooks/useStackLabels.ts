// Stack renames (`POST …/stacks/:id/rename`), optimistic: the new label of a rename in flight
// lives in this tiny module store (useSyncExternalStore, like useTitles) under `host/id`, so a
// row's chip, the session screen's bar, a board column and the Stack sheet all show it at once —
// it wins over `session.stack.label` / the loaded StackView until the server has it.
import { useCallback, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import { api } from '@/api/client'
import type { StackView } from '@/api/types'
import { useOvermind } from '@/hooks/useOvermind'
import { MAX_STACK_LABEL, STACK_LABEL_TTL_MS, shownStackLabel, stackErrorMessage, type PendingStackLabel } from '@/lib/stacks'

let pending: ReadonlyMap<string, PendingStackLabel> = new Map()
const listeners = new Set<() => void>()

function subscribe(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

function setPending(key: string, entry: PendingStackLabel | null) {
  const next = new Map(pending)
  if (entry) next.set(key, entry)
  else next.delete(key)
  pending = next
  for (const l of listeners) l()
}

const stackKey = (host: string, id: string) => `${host}/${id}`

/** The label to draw for stack `host/id` whose server label is `server` — optimistic while a rename is pending. */
export function useStackLabel(host: string | null | undefined, id: string | null | undefined, server: string): { label: string; saving: boolean } {
  const key = host && id ? stackKey(host, id) : ''
  const entry = useSyncExternalStore(subscribe, () => (key ? (pending.get(key) ?? null) : null))
  return { label: shownStackLabel(server, entry), saving: !!entry?.saving }
}

/**
 * `rename(host, id, label)`: shows the new label everywhere at once, POSTs the rename, then
 * refreshes the overmind (now, and once more when the server's snapshot has certainly been
 * rebuilt); the override is dropped once the overmind shows the label (or after a TTL). A failure
 * rolls back and toasts. Resolves the updated StackView, or null when it failed. The caller
 * checks `stackLabelChanged` first.
 */
export function useRenameStack(): (host: string, id: string, label: string) => Promise<StackView | null> {
  const { refresh } = useOvermind()
  return useCallback(
    async (host: string, id: string, raw: string) => {
      const label = raw.trim().slice(0, MAX_STACK_LABEL)
      if (!label) return null
      const key = stackKey(host, id)
      const at = Date.now()
      setPending(key, { label, at, saving: true })
      try {
        const view = await api.renameStack(host, id, label)
        const saved = view?.label || label
        setPending(key, { label: saved, at, saving: false })
        setTimeout(() => {
          if (pending.get(key)?.at === at) setPending(key, null)
        }, STACK_LABEL_TTL_MS)
        toast.success(`Renamed stack to ${saved}`, { duration: 1800 })
        refresh()
        setTimeout(refresh, 2500)
        return view
      } catch (err) {
        if (pending.get(key)?.at === at) setPending(key, null)
        toast.error('Could not rename the stack', { description: stackErrorMessage(err) })
        return null
      }
    },
    [refresh],
  )
}
