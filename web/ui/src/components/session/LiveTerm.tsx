import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2Icon } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { api, ApiError, isAbortError, sendErrorMessage } from '@/api/client'
import type { ScreenFrame } from '@/api/types'
import { usePoller } from '@/hooks/usePoller'
import { frameToAnsi, menuInput, parseMenu, sameMenu, type Menu } from '@/lib/term'

export const LIVE_POLL_MS = 400
const AFTER_INPUT_MS = 60
const MENU_KEY_GAP_MS = 60
// Monospace advance ≈ 0.6em: the font size that fits `cols` into the width.
const CHAR_EM = 0.6

export interface LiveTermProps {
  host: string
  id: string
  /** px at the default text size (`overmind.termFont`): the largest size used; smaller to fit the width. */
  fontSize: number
  /** The pane can't be mirrored (not tmux) — the caller falls back to the text view. */
  onUnsupported: () => void
  onError: (message: string) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The session's tmux pane as a real terminal: the screen is mirrored a few times a second and
 * everything typed, pasted or clicked in it goes to the pane as raw input — the agent's
 * option menus, arrows, Esc, Ctrl-C and mouse clicks all work as in a local terminal. The
 * menu on screen is also offered as buttons (one tap on a phone).
 */
export function LiveTerm({ host, id, fontSize, onUnsupported, onError }: LiveTermProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const lastRef = useRef<{ key: string; frame: ScreenFrame } | null>(null)
  const [ready, setReady] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [picking, setPicking] = useState(false)
  const errRef = useRef({ onUnsupported, onError })
  useEffect(() => {
    errRef.current = { onUnsupported, onError }
  }, [onUnsupported, onError])

  const fit = useCallback(() => {
    const term = termRef.current
    const box = boxRef.current
    const f = lastRef.current?.frame
    if (!term || !box || !f) return
    const size = Math.max(7, Math.min(fontSize, Math.floor((box.clientWidth - 16) / (f.cols * CHAR_EM))))
    if (term.options.fontSize !== size) term.options.fontSize = size
  }, [fontSize])

  const paint = useCallback(
    (f: ScreenFrame) => {
      const term = termRef.current
      if (!term) return
      const key = JSON.stringify(f)
      if (lastRef.current?.key === key) return
      const resized = lastRef.current?.frame.cols !== f.cols || lastRef.current?.frame.rows !== f.rows
      lastRef.current = { key, frame: f }
      if (resized) {
        term.resize(f.cols, f.rows)
        fit()
      }
      term.write(frameToAnsi(f))
      setMenu((prev) => {
        const next = parseMenu(f.lines)
        return sameMenu(prev, next) ? prev : next
      })
    },
    [fit],
  )

  const poll = useCallback(
    async (signal: AbortSignal) => {
      try {
        paint(await api.screen(host, id, { signal }))
        setReady(true)
      } catch (err) {
        if (isAbortError(err)) throw err
        if (err instanceof ApiError && err.status === 409) errRef.current.onUnsupported()
        else errRef.current.onError(sendErrorMessage(err))
      }
    },
    [host, id, paint],
  )
  const refresh = usePoller(poll, LIVE_POLL_MS)

  // Input: one request per key / mouse event, in order — never merged. Claude Code reads two
  // escape sequences arriving in one write as a lone Esc (which cancels a permission prompt).
  const queue = useRef<{ pending: string[]; busy: boolean }>({ pending: [], busy: false })
  const flush = useCallback(async () => {
    const q = queue.current
    if (q.busy || !q.pending.length) return
    q.busy = true
    try {
      while (q.pending.length) {
        const data = q.pending.shift() as string
        try {
          await api.input(host, id, data)
        } catch (err) {
          errRef.current.onError(sendErrorMessage(err))
        }
      }
    } finally {
      q.busy = false
    }
    setTimeout(refresh, AFTER_INPUT_MS)
  }, [host, id, refresh])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const style = getComputedStyle(box)
    const term = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 0,
      fontSize,
      fontFamily: style.fontFamily,
      allowTransparency: true,
      cursorBlink: false,
      theme: { background: 'rgba(0,0,0,0)', foreground: style.color, cursor: style.color },
    })
    term.open(box)
    termRef.current = term
    const send = (d: string) => {
      queue.current.pending.push(d)
      void flush()
    }
    const data = term.onData(send)
    const bin = term.onBinary(send)
    const ro = new ResizeObserver(() => fit())
    ro.observe(box)
    if (lastRef.current) {
      const f = lastRef.current.frame
      lastRef.current = null
      paint(f)
    }
    return () => {
      ro.disconnect()
      data.dispose()
      bin.dispose()
      term.dispose()
      termRef.current = null
    }
    // The terminal lives as long as the view; font changes go through `fit`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => fit(), [fit])

  const pick = async (index: number) => {
    if (!menu || picking) return
    setPicking(true)
    try {
      // Only act on the menu as it is on screen now — never on a stale one.
      const now = await api.screen(host, id)
      paint(now)
      const live = parseMenu(now.lines)
      if (!sameMenu(menu, live)) {
        errRef.current.onError('The prompt changed — check the terminal and pick again')
        return
      }
      for (const [i, key] of menuInput(menu, index, now.appCursor).entries()) {
        if (i > 0) await sleep(MENU_KEY_GAP_MS)
        await api.input(host, id, key)
      }
    } catch (err) {
      errRef.current.onError(sendErrorMessage(err))
    } finally {
      setPicking(false)
      setTimeout(refresh, AFTER_INPUT_MS)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-terminal">
      <div
        ref={boxRef}
        aria-label="Live terminal"
        className="min-h-0 flex-1 overflow-auto overscroll-contain px-safe font-mono text-foreground/90 [&_.xterm]:p-2"
        onClick={() => termRef.current?.focus()}
      />
      {!ready ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-dimmer">
          <Loader2Icon className="size-4 animate-spin" /> Connecting…
        </div>
      ) : null}
      {menu ? (
        <div role="group" aria-label="Options on screen" className="flex shrink-0 flex-wrap gap-1.5 border-t bg-background/80 px-3 py-2 backdrop-blur-sm">
          {menu.options.map((o, i) => (
            <button
              key={o.n}
              type="button"
              disabled={picking}
              onClick={() => void pick(i)}
              title={o.label}
              className={
                'max-w-full truncate rounded-full border px-3 py-1 text-left text-xs active:bg-muted disabled:opacity-50 ' +
                (menu.current === i ? 'border-status-waiting/60 text-foreground' : 'text-dimmer hover:text-foreground')
              }
            >
              <span className="font-mono">{o.n}.</span> {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
