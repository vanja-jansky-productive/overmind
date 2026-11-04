import { Fragment } from 'react'
import { CircleAlertIcon, FileTextIcon, Loader2Icon } from 'lucide-react'

import type { NoteEntry, NoteHit, NotesSearch } from '@/api/types'
import { Ago } from '@/components/Ago'
import { notesHref, splitRanges } from '@/lib/notes'
import { dirname } from '@/lib/paths'
import { cn } from '@/lib/utils'

function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  return splitRanges(text, ranges).map((p, i) =>
    p.hit ? (
      <mark key={i} className="rounded-[3px] bg-status-waiting/30 px-px text-foreground">
        {p.v}
      </mark>
    ) : (
      <Fragment key={i}>{p.v}</Fragment>
    ),
  )
}

const folder = (p: string) => (dirname(p) === '.' ? '' : dirname(p))

export interface NoteResultsProps {
  host: string
  data: NotesSearch | null
  loading: boolean
  error: string | null
  selected: string | null
  /** A result was picked (scroll the note to its first match). */
  onPick: (hit: NoteHit) => void
  compact?: boolean
}

/** Search results: title, folder, age, up to three snippets with the matches marked. */
export function NoteResults({ host, data, loading, error, selected, onPick, compact = false }: NoteResultsProps) {
  if (error) {
    return (
      <p className="flex items-center gap-2 px-4 py-6 text-sm text-destructive">
        <CircleAlertIcon className="size-4 shrink-0" /> {error}
      </p>
    )
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2 px-4 py-6 text-sm text-dimmer">
        <Loader2Icon className="size-4 animate-spin" /> Searching…
      </p>
    )
  }
  return (
    <div className={cn('transition-opacity', loading && 'opacity-60')}>
      <p className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-[0.6875rem] text-dimmer tabular-nums">
        {loading ? <Loader2Icon className="size-3 animate-spin" /> : null}
        {data.total === 0 ? 'No matches' : `${data.total} ${data.total === 1 ? 'note' : 'notes'}${data.total > data.results.length ? ` · top ${data.results.length}` : ''}`}
        <span className="ml-auto">{data.engine === 'command' ? 'search command' : 'full text'} · {data.ms} ms</span>
      </p>
      {data.fallback ? <p className="px-4 pb-1 text-[0.6875rem] text-status-waiting">{data.fallback} — built-in search used</p> : null}
      <ul className="px-1.5 pb-2">
        {data.results.map((r) => {
          const active = r.path === selected
          return (
            <li key={r.path}>
              <a
                href={`#${notesHref(host, r.path)}`}
                onClick={() => onPick(r)}
                className={cn(
                  'block rounded-lg px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  compact ? 'py-1.5' : 'py-2.5',
                  active ? 'bg-primary/12' : 'hover:bg-muted/60',
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className={cn('min-w-0 flex-1 truncate font-medium', compact ? 'text-[0.8125rem]' : 'text-[0.9375rem]')}>{r.title}</span>
                  <span className="shrink-0 text-[0.6875rem] text-dimmer tabular-nums"><Ago at={r.mtime} /></span>
                </span>
                {folder(r.path) ? <span className="block truncate font-mono text-[0.6875rem] text-dimmer">{folder(r.path)}/</span> : null}
                {r.matches.map((m, i) => (
                  <span key={i} className="mt-0.5 flex gap-1.5 text-xs leading-snug text-muted-foreground">
                    {m.line ? <span className="w-6 shrink-0 text-right font-mono text-[0.625rem] leading-[1.35rem] text-dimmer tabular-nums">{m.line}</span> : null}
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                      <Marked text={m.text} ranges={m.ranges} />
                    </span>
                  </span>
                ))}
                {r.more ? <span className="mt-0.5 block pl-7.5 text-[0.6875rem] text-dimmer">+{r.more} more</span> : null}
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The landing list: recently changed notes. */
export function RecentNotes({ host, notes, selected, compact = false }: { host: string; notes: NoteEntry[]; selected: string | null; compact?: boolean }) {
  if (!notes.length) return null
  return (
    <section aria-label="Recently changed">
      <h2 className="px-4 pt-3 pb-1 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">Recently changed</h2>
      <ul className="px-1.5 pb-2">
        {notes.map((n) => (
          <li key={n.path}>
            <a
              href={`#${notesHref(host, n.path)}`}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-lg px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                compact ? 'py-1.5 text-[0.8125rem]' : 'min-h-11 py-2 text-[0.9375rem]',
                n.path === selected ? 'bg-primary/12' : 'hover:bg-muted/60',
              )}
            >
              <FileTextIcon className="size-4 shrink-0 text-dimmer" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{n.title ?? n.path}</span>
                {folder(n.path) ? <span className="block truncate font-mono text-[0.6875rem] text-dimmer">{folder(n.path)}/</span> : null}
              </span>
              <span className="shrink-0 text-[0.6875rem] text-dimmer tabular-nums"><Ago at={n.mtime} /></span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
