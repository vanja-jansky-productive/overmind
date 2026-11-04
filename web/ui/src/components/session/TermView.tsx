import { useEffect, useLayoutEffect } from 'react'
import { Loader2Icon } from 'lucide-react'

import { Linkified } from '@/components/Markdown'
import { LatestButton } from '@/components/session/LatestButton'
import { FileLinksContext, type FileStats } from '@/hooks/useFileLinks'
import { useFollowScroll } from '@/hooks/useFollowScroll'
import { textPathCandidates } from '@/lib/paths'
import { termFontRem } from '@/lib/prefs'

export interface TermViewProps {
  /** null = not loaded yet. */
  text: string | null
  failed: boolean
  /** px at the default text size (`fleet.termFont`); rendered in rem, so it follows the text size. */
  fontSize: number
  jumpSignal: number
  /** Link file paths that exist on the session's host (click → preview). */
  fileLinks?: FileStats
}

/** Raw terminal capture (`peek`), links and file paths clickable, follow-scroll with "↓ latest". */
export function TermView({ text, failed, fontSize, jumpSignal, fileLinks }: TermViewProps) {
  const { ref, following, stick, jump, onScroll } = useFollowScroll<HTMLPreElement>(40)

  useLayoutEffect(() => {
    stick()
  }, [text, fontSize, stick])

  useEffect(() => {
    if (jumpSignal) jump()
  }, [jumpSignal, jump])

  const requestStats = fileLinks?.request
  useEffect(() => {
    if (!requestStats || !text) return
    const candidates = textPathCandidates(text)
    if (candidates.length) requestStats(candidates)
  }, [text, requestStats])

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
          ) : fileLinks ? (
            <FileLinksContext.Provider value={fileLinks.api}>
              <Linkified text={text} />
            </FileLinksContext.Provider>
          ) : (
            <Linkified text={text} />
          )}
        </span>
      </pre>
      <LatestButton show={!following} onClick={jump} />
    </div>
  )
}
