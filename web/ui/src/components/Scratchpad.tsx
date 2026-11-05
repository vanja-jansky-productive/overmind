import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { CopyIcon, NotebookPenIcon, Trash2Icon, XIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { useScratchpadOpen } from '@/hooks/useScratchpad'
import { copyWithToast } from '@/lib/clipboard'
import {
  SAVE_DELAY_MS,
  SCRATCH_KEY,
  clampRect,
  defaultRect,
  loadRect,
  loadText,
  saveRect,
  saveText,
  scratchpad,
  type Rect,
} from '@/lib/scratchpad'
import { withHint } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

/** Header / rail button that opens the scratchpad. */
export function ScratchpadButton({ className, size = 'icon' }: { className?: string; size?: 'icon' | 'icon-sm' }) {
  const open = useScratchpadOpen()
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label="Scratchpad"
      aria-pressed={open}
      title={withHint('Scratchpad', 'scratchpad')}
      onClick={() => (open ? scratchpad.hide() : scratchpad.show())}
      className={cn('text-dimmer hover:text-foreground', open && 'text-foreground', className)}
    >
      <NotebookPenIcon />
    </Button>
  )
}

/**
 * The scratchpad, mounted once at the app root: a floating, non-modal panel on desktop (drag the
 * header, resize from the corner; the app stays usable under it) and a bottom drawer on mobile.
 * The text autosaves to localStorage while typing and follows edits made in other tabs.
 */
export function Scratchpad() {
  const desktop = useIsDesktop()
  const open = useScratchpadOpen()
  const tick = useSyncExternalStore(scratchpad.subscribe, scratchpad.focusTick, () => 0)
  const [text, setText] = useState(loadText)
  const [saved, setSaved] = useState(true)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const pending = useRef<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  const flush = () => {
    if (pending.current == null) return
    saveText(pending.current)
    pending.current = null
    setSaved(true)
  }
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })

  const edit = (value: string) => {
    setText(value)
    pending.current = value
    setSaved(false)
  }
  useEffect(() => {
    if (saved) return
    const t = setTimeout(() => flushRef.current(), SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [text, saved])

  useEffect(() => {
    const onHide = () => flushRef.current()
    // Another tab / window edited it: take theirs unless this one is mid-edit.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SCRATCH_KEY || pending.current != null) return
      setText(e.newValue ?? '')
    }
    window.addEventListener('pagehide', onHide)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('storage', onStorage)
      flushRef.current()
    }
  }, [])

  // show(): remember where focus was (Esc / close hands it back), then focus the editor.
  useEffect(() => {
    if (!open || !tick) return
    const active = document.activeElement
    if (active instanceof HTMLElement && !active.closest('[data-scratchpad]')) returnFocus.current = active
    const id = requestAnimationFrame(() => textRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, tick])
  useEffect(() => {
    if (open) return
    flushRef.current()
    const el = returnFocus.current
    returnFocus.current = null
    if (el?.isConnected && document.activeElement?.closest('[data-scratchpad]') == null) el.focus({ preventScroll: true })
  }, [open])

  const clear = () => {
    const before = text
    if (!before) return
    edit('')
    toast('Scratchpad cleared', { action: { label: 'Undo', onClick: () => edit(before) } })
    textRef.current?.focus()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      scratchpad.hide()
    }
  }

  const lines = text ? text.split('\n').length : 0
  const status = `${text.length} chars · ${lines} ${lines === 1 ? 'line' : 'lines'} · ${saved ? 'saved' : 'saving…'}`
  const toolbar = (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Copy all" title="Copy all" disabled={!text} onClick={() => void copyWithToast(text)}>
        <CopyIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Clear" title="Clear (undo from the toast)" disabled={!text} onClick={clear}>
        <Trash2Icon />
      </Button>
    </>
  )
  const editor = (
    <textarea
      ref={textRef}
      value={text}
      onChange={(e) => edit(e.target.value)}
      onBlur={flush}
      onKeyDown={onKeyDown}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      placeholder="Paste, tweak, copy. Autosaved."
      aria-label="Scratchpad text"
      className="min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed outline-none placeholder:text-dimmer"
    />
  )

  if (!desktop) {
    return (
      <Drawer open={open} onOpenChange={(o) => (o ? scratchpad.show() : scratchpad.hide())}>
        <DrawerContent data-scratchpad className="px-safe">
          <div className="flex items-center gap-1 border-b px-3 pb-2">
            <DrawerTitle className="flex-1 text-[0.9375rem]">Scratchpad</DrawerTitle>
            <DrawerDescription className="sr-only">Plain text, autosaved on this device</DrawerDescription>
            {toolbar}
          </div>
          <div className="flex h-[min(60vh,calc(var(--app-h,100dvh)-8rem))] flex-col">{editor}</div>
          <div className="px-3 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[0.6875rem] text-dimmer tabular-nums">{status}</div>
        </DrawerContent>
      </Drawer>
    )
  }
  if (!open) return null
  return (
    <FloatingPanel>
      <div className="flex shrink-0 cursor-move items-center gap-1 border-b py-1 pr-1 pl-3 select-none" data-drag-handle>
        <NotebookPenIcon className="size-3.5 text-dimmer" />
        <h2 className="flex-1 text-xs font-semibold">Scratchpad</h2>
        {toolbar}
        <Button variant="ghost" size="icon-sm" aria-label="Close" title={withHint('Close (Esc)', 'scratchpad')} onClick={() => scratchpad.hide()}>
          <XIcon />
        </Button>
      </div>
      {editor}
      <div className="shrink-0 border-t px-3 py-1 text-[0.6875rem] text-dimmer tabular-nums">{status}</div>
    </FloatingPanel>
  )
}

/** Fixed, draggable (by `[data-drag-handle]`), resizable from the bottom-right corner; the rect persists. */
function FloatingPanel({ children }: { children: ReactNode }) {
  const [rect, setRect] = useState<Rect>(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    return clampRect(loadRect() ?? defaultRect(vw, vh), vw, vh)
  })
  const drag = useRef<{ mode: 'move' | 'resize'; px: number; py: number; start: Rect } | null>(null)
  const rectRef = useRef(rect)
  useEffect(() => {
    rectRef.current = rect
  }, [rect])

  useLayoutEffect(() => {
    const onResize = () => setRect((r) => clampRect(r, window.innerWidth, window.innerHeight))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const begin = (mode: 'move' | 'resize', e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    if (mode === 'move' && (e.target as HTMLElement).closest('button')) return
    if (mode === 'move' && !(e.target as HTMLElement).closest('[data-drag-handle]')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode, px: e.clientX, py: e.clientY, start: rect }
  }
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    const next = d.mode === 'move' ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, w: d.start.w + dx, h: d.start.h + dy }
    setRect(clampRect(next, window.innerWidth, window.innerHeight))
  }
  const end = () => {
    if (!drag.current) return
    drag.current = null
    saveRect(rectRef.current)
  }

  return (
    <section
      data-scratchpad
      aria-label="Scratchpad"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5"
      onPointerDown={(e) => begin('move', e)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {children}
      <div
        aria-hidden
        onPointerDown={(e) => {
          e.stopPropagation()
          begin('resize', e)
        }}
        className="absolute right-0 bottom-0 size-4 cursor-nwse-resize"
      />
    </section>
  )
}
