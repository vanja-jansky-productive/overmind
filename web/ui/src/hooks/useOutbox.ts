import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { api, sendErrorMessage } from '@/api/client'
import { Outbox, type OutboxItem } from '@/lib/outbox'

export interface UseOutboxOptions {
  host: string
  id: string
  /** Delivered (the POST returned ok) — only while the screen is mounted. */
  onSent?: (item: OutboxItem) => void
  /** Failed; `mounted` = false once the screen is gone (then only a toast can tell). */
  onError?: (err: unknown, item: OutboxItem, mounted: boolean) => void
}

/**
 * The session screen's outbox (lib/outbox.ts): messages wait out the send delay, then go out one
 * at a time as keepalive POSTs (they survive a page unload). Leaving the screen (unmount — also a
 * session switch, the screens are keyed by session) sends what is still counting down right away;
 * so does the page going to the background (iOS freezes timers there). On `pagehide` whatever has
 * not left yet is handed to one keepalive fetch per message (best effort, no ordering guarantee).
 */
export function useOutbox({ host, id, onSent, onError }: UseOutboxOptions) {
  const [box] = useState(() => new Outbox({ send: (text) => api.send(host, id, text, { keepalive: true }), errorText: sendErrorMessage }))
  // Callbacks stay current; after unmount only onError runs (a toast is all that can tell then).
  const mounted = useRef(false)
  useEffect(() => {
    box.configure({
      onSent: (it) => {
        if (mounted.current) onSent?.(it)
      },
      onError: (err, it) => onError?.(err, it, mounted.current),
    })
  })
  const items = useSyncExternalStore(box.subscribe, box.getItems, box.getItems)

  useEffect(() => {
    mounted.current = true
    box.resume()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') box.flush()
    }
    const onPageHide = () => {
      for (const it of box.takeUnsent()) void api.send(host, id, it.text, { keepalive: true }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      mounted.current = false
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      // Leaving: never drop a message silently — send it now (the POSTs outlive the screen).
      box.flush()
      box.dispose()
    }
  }, [box, host, id])

  return { box, items }
}
