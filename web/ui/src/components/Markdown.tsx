import { Fragment, memo, useContext, type ReactNode } from 'react'

import { FileLinksContext, HighlightContext, type FileLinkApi, type FileLinkSource } from '@/hooks/useFileLinks'
import { linkify, parseMarkdown, type Block, type Inline } from '@/lib/markdown'
import { splitRanges, termRanges } from '@/lib/notes'
import { splitPaths } from '@/lib/paths'
import { cn } from '@/lib/utils'

// Renders the lib/markdown.ts AST as React elements: text is always a React text child
// (escaped), links are only the http(s) hrefs the parser let through. No innerHTML.
// Inside a <FileLinksContext> provider, file paths the provider accepts render as buttons
// (never hrefs) that open the in-app preview; without one, paths stay plain text.

function Highlighted({ v }: { v: string }) {
  const terms = useContext(HighlightContext)
  const ranges = terms.length ? termRanges(v, terms) : []
  if (!ranges.length) return v
  return splitRanges(v, ranges).map((p, i) =>
    p.hit ? (
      <mark key={i} data-hit className="rounded-[3px] bg-status-waiting/30 text-foreground">
        {p.v}
      </mark>
    ) : (
      <Fragment key={i}>{p.v}</Fragment>
    ),
  )
}

const linkClass =
  'text-primary underline decoration-primary/40 underline-offset-2 break-all active:opacity-70 [overflow-wrap:anywhere]'

function Link({ href, children }: { href: string; children: ReactNode }) {
  // A link into this app (`<origin>/#/…`, e.g. the inbox brief's session links) opens in place.
  const inApp = typeof window !== 'undefined' && href.startsWith(`${window.location.origin}/#/`)
  if (inApp) {
    return (
      <a href={href.slice(window.location.origin.length + 1)} className={linkClass}>
        {children}
      </a>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {children}
    </a>
  )
}

const codeClass = 'rounded-[5px] bg-foreground/[0.07] px-1 py-px font-mono text-[0.86em] [overflow-wrap:anywhere]'
const fileClass =
  'cursor-pointer underline decoration-primary/35 decoration-dotted underline-offset-[3px] hover:decoration-primary hover:decoration-solid focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring'

/** A path that exists on the session's host: opens the preview (a button, not an href). */
function FileLink({ links, raw, source, children }: { links: FileLinkApi; raw: string; source: FileLinkSource; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      title={`Preview ${raw}`}
      className={cn(fileClass, source !== 'code' && 'text-primary')}
      onClick={(e) => {
        e.stopPropagation()
        links.open(raw, source)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        links.open(raw, source)
      }}
    >
      {children}
    </span>
  )
}

function TextWithPaths({ v, links }: { v: string; links: FileLinkApi | null }) {
  if (!links) return <Highlighted v={v} />
  const parts = splitPaths(v, (raw) => links.isLink(raw, 'text'))
  if (parts.length === 1 && parts[0].t === 'text') return <Highlighted v={v} />
  return parts.map((p, i) =>
    p.t === 'path' ? (
      <FileLink key={i} links={links} raw={p.v} source="text">
        {p.v}
      </FileLink>
    ) : (
      <Highlighted key={i} v={p.v} />
    ),
  )
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  const links = useContext(FileLinksContext)
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return (
          <Fragment key={i}>
            <TextWithPaths v={n.v} links={links} />
          </Fragment>
        )
      case 'code': {
        const code = <code className={codeClass}>{n.v}</code>
        const raw = n.v.trim()
        return links?.isLink(raw, 'code') ? (
          <FileLink key={i} links={links} raw={raw} source="code">
            {code}
          </FileLink>
        ) : (
          <Fragment key={i}>{code}</Fragment>
        )
      }
      case 'file':
        return links?.isLink(n.href, 'file') ? (
          <FileLink key={i} links={links} raw={n.href} source="file">
            <FileLinksContext.Provider value={null}>
              <Inlines nodes={n.children} />
            </FileLinksContext.Provider>
          </FileLink>
        ) : (
          <Fragment key={i}>{n.raw}</Fragment>
        )
      case 'img': {
        const src = links?.imageSrc?.(n.src)
        if (src) return <img key={i} src={src} alt={n.alt} loading="lazy" className="my-1 inline-block max-w-full rounded-md border border-border/60" />
        return links?.isLink(n.src, 'file') ? (
          <FileLink key={i} links={links} raw={n.src} source="file">
            {n.alt || n.src}
          </FileLink>
        ) : (
          <Fragment key={i}>{n.raw}</Fragment>
        )
      }
      case 'wiki':
        return links?.isLink(n.target, 'wiki') ? (
          <FileLink key={i} links={links} raw={n.target} source="wiki">
            {n.label}
          </FileLink>
        ) : (
          <span key={i} title={`No note named “${n.target}”`} className="text-muted-foreground underline decoration-dimmer decoration-dashed underline-offset-[3px]">
            {n.label}
          </span>
        )
      case 'strong':
        return (
          <strong key={i} className="font-semibold text-foreground">
            <Inlines nodes={n.children} />
          </strong>
        )
      case 'em':
        return (
          <em key={i}>
            <Inlines nodes={n.children} />
          </em>
        )
      case 'link':
        return (
          <Link key={i} href={n.href}>
            {links ? (
              <FileLinksContext.Provider value={null}>
                <Inlines nodes={n.children} />
              </FileLinksContext.Provider>
            ) : (
              <Inlines nodes={n.children} />
            )}
          </Link>
        )
    }
  })
}

function Lines({ lines }: { lines: Inline[][] }) {
  return lines.map((l, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      <Inlines nodes={l} />
    </Fragment>
  ))
}

const HEADING = { 1: 'text-[1.14em]', 2: 'text-[1.07em]', 3: 'text-[1em] text-muted-foreground' } as const

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'p':
      return (
        <p>
          <Lines lines={b.lines} />
        </p>
      )
    case 'h':
      return (
        <div className={cn('mt-3 mb-1 leading-snug font-bold first:mt-0', HEADING[b.level])}>
          <Inlines nodes={b.content} />
        </div>
      )
    case 'hr':
      return <hr className="my-3 border-border" />
    case 'quote':
      return (
        <blockquote className="border-l-3 border-border pl-2.5 text-muted-foreground">
          <Lines lines={b.lines} />
        </blockquote>
      )
    case 'list': {
      const List = b.ordered ? 'ol' : 'ul'
      return (
        <List className={cn('space-y-0.5 pl-5', b.ordered ? 'list-decimal' : 'list-disc', 'marker:text-dimmer')}>
          {b.items.map((it, i) => {
            const Sub = it.sub?.ordered ? 'ol' : 'ul'
            return (
              <li key={i}>
                <Inlines nodes={it.content} />
                {it.sub ? (
                  <Sub className={cn('mt-0.5 space-y-0.5 pl-5', it.sub.ordered ? 'list-decimal' : 'list-[circle]')}>
                    {it.sub.items.map((s, j) => (
                      <li key={j}>
                        <Inlines nodes={s} />
                      </li>
                    ))}
                  </Sub>
                ) : null}
              </li>
            )
          })}
        </List>
      )
    }
    case 'table':
      return (
        <div className="no-scrollbar -mx-0.5 overflow-x-auto">
          <table className="border-collapse text-[0.88em]">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} className="border border-border bg-muted px-2 py-1 text-left font-semibold whitespace-nowrap">
                    <Inlines nodes={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border border-border px-2 py-1 whitespace-nowrap">
                      <Inlines nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 font-mono text-[0.84em] leading-relaxed">
          <code data-lang={b.lang || undefined}>{b.text}</code>
        </pre>
      )
  }
}

/**
 * Claude's markdown, rendered safely. Memoised: a poll that returns the same text re-renders nothing.
 * `notes`: the notes explorer's dialect (`[[wiki]]` links, h4–h6, comment lines dropped).
 */
export const Markdown = memo(function Markdown({ text, className, notes = false }: { text: string; className?: string; notes?: boolean }) {
  const links = useContext(FileLinksContext)
  const blocks = parseMarkdown(text, notes ? { notes: true } : links ? { files: true } : undefined)
  return (
    <div className={cn('space-y-2 [overflow-wrap:anywhere]', className)}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  )
})

/** Plain text with bare http(s) URLs as links (and, inside a provider, file paths) — user prompts, the terminal view. */
export const Linkified = memo(function Linkified({ text }: { text: string }) {
  const links = useContext(FileLinksContext)
  return linkify(text).map((n, i) =>
    n.t === 'link' ? (
      <Link key={i} href={n.href}>
        {n.href}
      </Link>
    ) : n.t === 'text' ? (
      <Fragment key={i}>
        <TextWithPaths v={n.v} links={links} />
      </Fragment>
    ) : null,
  )
})
