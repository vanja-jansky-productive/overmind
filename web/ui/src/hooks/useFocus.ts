import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { api, ApiError, isAbortError } from '@/api/client'
import type { FocusStatus } from '@/api/types'
import { usePoller } from '@/hooks/usePoller'
import { useSettings } from '@/hooks/useSettings'

export interface FocusState {
  /** The host the toggle drives; null: no toggle (unset, or that host has no `focus`). */
  host: string | null
  status: FocusStatus | null
  busy: boolean
  toggle: (minutes?: number) => Promise<void>
}

/** The Focus toggle's state: `web.focus.host`'s `focus status`, every 30s; `toggle` starts or stops. */
export function useFocus(): FocusState {
  const { focusHost } = useSettings()
  const [status, setStatus] = useState<FocusStatus | null>(null)
  // A host without the `focus` CLI (501) hides the toggle for the rest of the page load.
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)

  usePoller(
    async (signal) => {
      if (!focusHost) return
      try {
        const next = await api.focus(focusHost, { signal })
        setStatus((prev) => (sameFocus(prev, next) ? prev : next))
      } catch (err) {
        if (isAbortError(err)) return
        if (err instanceof ApiError && err.status === 501) setUnavailable(true)
      }
    },
    30 * 1000,
    { enabled: Boolean(focusHost) && !unavailable },
  )

  const toggle = useCallback(
    async (minutes?: number) => {
      if (!focusHost || busy) return
      setBusy(true)
      try {
        setStatus(await api.setFocus(focusHost, !status?.active, minutes))
      } finally {
        setBusy(false)
      }
    },
    [focusHost, busy, status?.active],
  )

  return { host: focusHost && !unavailable ? focusHost : null, status, busy, toggle }
}

/** Same focus state, the countdown (`remainingMs`, moving every poll) aside: a poll that brings nothing new keeps the old object. */
export function sameFocus(a: FocusStatus | null, b: FocusStatus | null): boolean {
  if (!a || !b) return a === b
  const { remainingMs: _a, ...x } = a
  const { remainingMs: _b, ...y } = b
  return JSON.stringify(x) === JSON.stringify(y)
}

/** Minutes left, rounded up ("42m"); null when off. */
export function focusLeft(focus: FocusState, now: number): string | null {
  const s = focus.status
  if (!s?.active || s.endsAt == null) return null
  return `${Math.max(1, Math.ceil((s.endsAt - now) / 60000))}m`
}

/** Start or stop focus mode, with a toast either way. */
export async function toggleFocus(focus: FocusState) {
  const on = !focus.status?.active
  try {
    await focus.toggle()
    toast.success(on ? 'Focus on' : 'Focus off')
  } catch (err) {
    toast.error(`Focus: ${err instanceof Error ? err.message : String(err)}`)
  }
}
