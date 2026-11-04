import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CircleAlertIcon, CodeXmlIcon, CopyIcon, Loader2Icon, LockIcon, SendIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'

import { noteRawUrl } from '@/api/client'
import type { NoteEntry, NoteFile } from '@/api/types'
import { HostBadge } from '@/components/HostBadge'
import { Linkified, Markdown } from '@/components/Markdown'
import { SendNoteDialog } from '@/components/notes/SendNoteDialog'
import { CodeLines } from '@/components/session/FilePreview'
import { Button } from '@/components/ui/button'
import { FileLinksContext, HighlightContext, type FileLinkApi } from '@/hooks/useFileLinks'
import { useNoteFile } from '@/hooks/useNotes'
import { copyWithToast } from '@/lib/clipboard'
import { Ago } from '@/components/Ago'
import { isLocalHref } from '@/lib/markdown'
import { metaText, notesHref, resolveNoteLink, type NoteIndex } from '@/lib/notes'
import { cn } from '@/lib/utils'

export interface NoteViewProps {
  host: string
  path: string
  entry: NoteEntry | null
  index: NoteIndex
  /** Words to mark (the active search). */
  highlight: string[]
  /** Scroll to the first mark once loaded (opened from a search result). */
  scrollToHit: boolean
  /** Desktop pane (wider column, editor link) vs the mobile screen. */
  desktop?: boolean
  /** Rendered above the note (the mobile back bar). */
  header?: ReactNode
}

/** One note: title, path, frontmatter, then the body — links to other notes stay in the explorer. */
export function NoteView({ host, path, entry, index, highlight, scrollToHit, desktop = false, header }: NoteViewProps) {
  const [, navigate] = useLocation()
  const { file, error, loading } = useNoteFile(host, entry?.kind === 'image' ? null : path, entry?.mtime)
  const [sourceFor, setSourceFor] = useState<string | null>(null)
  const source = sourceFor === `${host}/${path}`
  const [sendOpen, setSendOpen] = useState(false)

  const links = useMemo<FileLinkApi>(
    () => ({
      isLink: (raw, src) => (src === 'file' || src === 'wiki') && !!resolveNoteLink(index, path, raw, src === 'wiki'),
      open: (raw, src) => {
        const target = resolveNoteLink(index, path, raw, src === 'wiki')
        if (target) navigate(notesHref(host, target.path))
        else toast.error(`No note at ${raw}`)
      },
      imageSrc: (src) => {
        if (!isLocalHref(src)) return null
        const target = resolveNoteLink(index, path, src)
        return target?.kind === 'image' ? noteRawUrl(host, target.path) : null
      },
    }),
    [index, path, host, navigate],
  )

  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!file || !scrollToHit) return
    bodyRef.current?.querySelector('[data-hit]')?.scrollIntoView({ block: 'center' })
  }, [file, scrollToHit])

  const title = file?.title ?? entry?.title ?? path.split('/').pop() ?? path
  const abs = file?.abs ?? null

  let body: ReactNode
  if (entry?.kind === 'image') {
    body = (
      <div className="flex justify-center p-4">
        <img src={noteRawUrl(host, path)} alt={path} className="max-w-full rounded-md object-contain" />
      </div>
    )
  } else if (error) {
    body = (
      <p className="flex items-center gap-2 px-4 py-10 text-sm text-destructive">
        <CircleAlertIcon className="size-4 shrink-0" /> {error}
      </p>
    )
  } else if (!file || loading) {
    body = (
      <p className="flex items-center gap-2 px-4 py-10 text-sm text-dimmer">
        <Loader2Icon className="size-4 animate-spin" /> Loading…
      </p>
    )
  } else if (file.kind === 'markdown' && !source) {
    body = (
      <div className={cn('mx-auto w-full px-4 pt-2 pb-10', desktop ? 'max-w-3xl' : 'max-w-2xl')} style={{ fontSize: '0.9375rem', lineHeight: 1.6 }}>
        {file.meta.length ? <Frontmatter meta={file.meta} /> : null}
        {file.encrypted ? (
          <p className="mb-3 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <LockIcon className="size-3.5 shrink-0" /> Encrypted content is not shown here.
          </p>
        ) : null}
        <HighlightContext.Provider value={highlight}>
          <FileLinksContext.Provider value={links}>
            <Markdown text={file.body} notes />
          </FileLinksContext.Provider>
        </HighlightContext.Provider>
      </div>
    )
  } else {
    body = (
      <div className="overflow-x-auto">
        <CodeLines text={file.text} />
      </div>
    )
  }

  return (
    <article aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={cn('mx-auto w-full px-4 pt-4 pb-2', desktop ? 'max-w-3xl' : 'max-w-2xl')}>
          <h1 className="text-xl leading-tight font-bold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <HostBadge host={host} />
            <span className="min-w-0 font-mono break-all text-dimmer">{path}</span>
            {entry?.mtime ? <span className="text-dimmer tabular-nums">· modified <Ago at={entry.mtime} /> ago</span> : null}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {file?.kind === 'markdown' ? (
              <Button variant="outline" size="sm" onClick={() => setSourceFor(source ? null : `${host}/${path}`)} aria-pressed={source}>
                {source ? 'Rendered' : 'Source'}
              </Button>
            ) : null}
            {abs ? (
              <Button variant="outline" size="sm" onClick={() => void copyWithToast(abs)}>
                <CopyIcon /> Copy path
              </Button>
            ) : null}
            {abs ? (
              <Button variant="outline" size="sm" onClick={() => setSendOpen(true)} title="Open a session with this note's path in its composer">
                <SendIcon /> Send to session
              </Button>
            ) : null}
            {file?.editorUrl ? (
              <Button asChild variant="outline" size="sm" className="pointer-coarse:hidden">
                <a href={file.editorUrl}>
                  <CodeXmlIcon /> Open in {/^cursor:/.test(file.editorUrl) ? 'Cursor' : 'VS Code'}
                </a>
              </Button>
            ) : null}
          </div>
        </div>
        {body}
      </div>
      {abs ? <SendNoteDialog open={sendOpen} onOpenChange={setSendOpen} host={host} absPath={abs} /> : null}
    </article>
  )
}

/** Frontmatter as a compact key → value grid; lists as chips, URLs as links. */
function Frontmatter({ meta }: { meta: NoteFile['meta'] }) {
  return (
    <dl className="mb-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
      {meta.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-dimmer">{k}</dt>
          <dd className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
            {Array.isArray(v) ? (
              <span className="flex flex-wrap gap-1">
                {v.map((x) => (
                  <span key={x} className="rounded-md bg-foreground/[0.07] px-1.5 py-px font-medium text-foreground/80">
                    {k === 'tags' || k === 'tag' ? `#${x.replace(/^#/, '')}` : x}
                  </span>
                ))}
              </span>
            ) : (
              <Linkified text={metaText(v)} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
