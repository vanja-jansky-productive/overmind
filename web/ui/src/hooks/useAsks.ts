import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { api, sessionErrorMessage } from '@/api/client'
import type { ReviewAnchor, SideAsk } from '@/api/types'

/** While an answer streams in: poll it this often. */
export const ASK_POLL_MS = 800

export type AskBody = Partial<ReviewAnchor> & { question: string }

/**
 * Side questions on this screen: ephemeral (this tab's memory and the host's, never the
 * session's thread). `start` asks one (the caller picks the endpoint: a session's fork, or a
 * PR's checkout); running ones are polled until they end.
 */
export function useAsks(host: string, start: ((body: AskBody) => Promise<SideAsk>) | null) {
  const [asks, setAsks] = useState<SideAsk[]>([])
  const asksRef = useRef(asks)
  useEffect(() => {
    asksRef.current = asks
  }, [asks])

  const running = asks.some((a) => a.status === 'running')
  useEffect(() => {
    if (!running || !host) return
    const ctl = new AbortController()
    const t = setInterval(() => {
      for (const a of asksRef.current) {
        if (a.status !== 'running') continue
        api.askGet(host, a.id, { signal: ctl.signal }).then(
          (r) => setAsks((list) => list.map((x) => (x.id === a.id ? r.ask : x))),
          (err) => {
            if (ctl.signal.aborted) return
            setAsks((list) => list.map((x) => (x.id === a.id ? { ...x, status: 'error', activity: null, error: sessionErrorMessage(err) } : x)))
          },
        )
      }
    }, ASK_POLL_MS)
    return () => {
      clearInterval(t)
      ctl.abort()
    }
  }, [running, host])

  const ask = useCallback(
    async (body: AskBody) => {
      if (!start) return null
      try {
        const a = await start(body)
        setAsks((list) => [a, ...list])
        return a
      } catch (err) {
        toast.error(`Side question: ${sessionErrorMessage(err)}`)
        return null
      }
    },
    [start],
  )

  const close = useCallback(
    (id: string) => {
      const a = asksRef.current.find((x) => x.id === id)
      setAsks((list) => list.filter((x) => x.id !== id))
      if (a && host) api.askCancel(host, id).catch(() => {})
    },
    [host],
  )

  return { asks, ask, close, available: !!start }
}
