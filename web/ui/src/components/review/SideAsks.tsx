import { ChevronDownIcon, ChevronUpIcon, CopyIcon, LoaderIcon, SparklesIcon, XIcon } from 'lucide-react'
import { useState } from 'react'

import type { SideAsk } from '@/api/types'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { copyWithToast } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

/**
 * The side questions asked on this screen, newest first, docked at the bottom of the diff
 * column. Ephemeral: closing one forgets it (and stops it if it still runs).
 */
export function SideAsks({ asks, onClose, onOpen }: { asks: SideAsk[]; onClose: (id: string) => void; onOpen?: (ask: SideAsk) => void }) {
  const [folded, setFolded] = useState(false)
  if (!asks.length) return null
  return (
    <section
      aria-label="Side questions"
      className="pointer-events-auto sticky -bottom-3 z-20 -mx-3 -mb-3 max-h-[55vh] overflow-hidden border-t bg-background/95 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur-md"
    >
      <header className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <SparklesIcon className="size-3.5" />
        <span className="font-semibold text-foreground">Side questions</span>
        <span>· not part of the session’s conversation, forgotten when closed</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label={folded ? 'Show side questions' : 'Fold side questions'} onClick={() => setFolded(!folded)}>
          {folded ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
      </header>
      {folded ? null : (
        <div className="max-h-[calc(55vh-2.25rem)] space-y-2 overflow-y-auto px-3 pb-3">
          {asks.map((a) => (
            <AskCard key={a.id} ask={a} onClose={() => onClose(a.id)} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  )
}

function AskCard({ ask, onClose, onOpen }: { ask: SideAsk; onClose: () => void; onOpen?: (ask: SideAsk) => void }) {
  const running = ask.status === 'running'
  return (
    <article className="rounded-lg border bg-card">
      <div className="flex items-start gap-2 border-b px-3 py-1.5">
        <div className="min-w-0 flex-1">
          {ask.label ? (
            <button type="button" className="block max-w-full truncate font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground" onClick={() => onOpen?.(ask)} title="Show in the diff">
              {ask.label}
            </button>
          ) : null}
          <p className="text-sm font-medium whitespace-pre-wrap">{ask.question}</p>
        </div>
        {ask.text && !running ? (
          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Copy answer" title="Copy answer" onClick={() => void copyWithToast(ask.text)}>
            <CopyIcon />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={running ? 'Stop and close' : 'Close'} title={running ? 'Stop and close' : 'Close'} onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="px-3 py-2">
        {ask.text ? <Markdown text={ask.text} className={cn('text-sm', running && 'text-muted-foreground')} /> : null}
        {running ? (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderIcon className="size-3.5 animate-spin" />
            {ask.activity ? `Using ${ask.activity}…` : ask.text ? 'Answering…' : ask.forked ? 'Asking a fork of the session…' : 'Asking Claude…'}
          </p>
        ) : null}
        {ask.status === 'error' ? <p className="text-xs text-destructive">{ask.error ?? 'It failed.'}</p> : null}
      </div>
    </article>
  )
}
