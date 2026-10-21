import { useEffect, useLayoutEffect } from 'react'
import { Loader2Icon } from 'lucide-react'

import { Linkified } from '@/components/Markdown'
import { LatestButton } from '@/components/session/LatestButton'
import { useFollowScroll } from '@/hooks/useFollowScroll'
import { termFontRem } from '@/lib/prefs'

export interface TermViewProps {
  /** null = not loaded yet. */
  text: string | null
  failed: boolean
  /** px at the default text size (`overmind.termFont`); rendered in rem, so it follows the text size. */
  fontSize: number
  jumpSignal: number
}

/** Raw terminal capture (`peek`), links clickable, follow-scroll with "↓ latest". */
export function TermView({ text, failed, fontSize, jumpSignal }: TermViewProps) {
  const { ref, following, stick, jump, onScroll } = useFollowScroll<HTMLPreElement>(40)

  useLayoutEffect(() => {
    stick()
  }, [text, fontSize, stick])

  useEffect(() => {
    if (jumpSignal) jump()
  }, [jumpSignal, jump])

  return (
    <div className="relative min-h-0 flex-1 bg-terminal">
      <pre
        ref={ref}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Terminal output"
        className="absolute inset-0 m-0 overflow-auto overscroll-contain px-safe font-mono whitespace-pre text-foreground/90 outline-none [overflow-anchor:none] [tab-size:4]"
        style={{ fontSize: termFontRem(fontSize), lineHeight: 1.32 }}
      >
        <span className="block w-max min-w-full px-3 pt-2.5 pb-4">
          {text === null ? (
            failed ? null : (
              <span className="flex items-center gap-2 font-sans text-sm text-dimmer">
                <Loader2Icon className="size-4 animate-spin" /> Connecting…
              </span>
            )
          ) : (
            <Linkified text={text} />
          )}
        </span>
      </pre>
      <LatestButton show={!following} onClick={jump} />
    </div>
  )
}
