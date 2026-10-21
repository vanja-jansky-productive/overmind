import { useEffect, useRef, type KeyboardEvent, type Ref } from 'react'
import { PlusIcon, SearchIcon, XIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { BoardColumns } from '@/components/board/BoardColumns'
import { DormantSection } from '@/components/DormantSection'
import { GroupsStatus } from '@/components/board/GroupsStatus'
import { ModuleButtons } from '@/components/ModuleNav'
import { HostDot } from '@/components/HostBadge'
import { StatusFilterLabel } from '@/components/JobChip'
import { StatusDot } from '@/components/StatusDot'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ViewToggle } from '@/components/ViewToggle'
import type { GroupsState } from '@/hooks/useGroups'
import { ALL_HOSTS, type SessionListState } from '@/hooks/useSessionList'
import type { BoardColumn, ViewMode } from '@/lib/groups'
import { allSessions, visibleStatusFilters, type StatusFilterId } from '@/lib/sessions'
import { ariaShortcut, sessionKey, shortcutHint, withHint } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

const chip = cn(
  'h-7 shrink-0 gap-1 rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground',
  'data-[state=on]:border-primary/50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
)

export interface BoardProps {
  list: SessionListState
  groups: GroupsState
  columns: BoardColumn[]
  /** Reorder: column `id` just before `before` (null: to the end) — a header drag. */
  onMoveColumn: (id: string, before: string | null) => void
  now: number
  cursorKey: string | null
  selectedKey: string | null
  /**
   * Width (px) of the session flyout over the board's right edge, 0 when none. The columns keep
   * their size and place; the board can scroll the last ones out from under it, and the cursor
   * card is scrolled clear of it.
   */
  overlayInset: number
  searchRef: Ref<HTMLInputElement>
  onSearchNav: (action: 'next' | 'prev' | 'open') => void
  onOpen: (s: Session) => void
  onNew: () => void
  view: ViewMode
  onView: (v: ViewMode) => void
}

/**
 * Desktop board: a header (summary, List | Board, search, filters, last grouping run,
 * Regroup) over horizontal Kanban columns — one per group, cards = sessions. The same
 * search / status / host filters as the list apply to the cards. Columns can be renamed,
 * reordered and cards dragged between them (BoardColumns).
 */
export function Board({ list, groups, columns, onMoveColumn, now, cursorKey, selectedKey, overlayInset, searchRef, onSearchNav, onOpen, onNew, view, onView }: BoardProps) {
  const { overmind, error, query, setQuery, status, setStatus, setHostFilter, hosts, hostNames, host, view: lv, hostCounts, summary, unreachable, note } = list
  const boardRef = useRef<HTMLDivElement>(null)

  // The cursor card scrolls into view, clear of the flyout (↑/↓, ⌘K). A click moves the cursor
  // too, but the clicked card is on screen already: it stays put even if the flyout covers it.
  const clickedRef = useRef<string | null>(null)
  const openCard = (s: Session) => {
    clickedRef.current = sessionKey(s)
    onOpen(s)
  }
  useEffect(() => {
    const board = boardRef.current
    const el = cursorKey ? board?.querySelector<HTMLElement>(`[data-session-key="${CSS.escape(cursorKey)}"]`) : null
    const clicked = clickedRef.current === cursorKey
    clickedRef.current = null
    if (!board || !el) return
    if (clicked) {
      const r = el.getBoundingClientRect()
      const b = board.getBoundingClientRect()
      const col = (el.parentElement ?? board).getBoundingClientRect()
      if (r.left >= b.left && r.right <= b.right && r.top >= col.top && r.bottom <= col.bottom) return
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [cursorKey])

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      onSearchNav(e.key === 'ArrowDown' ? 'next' : 'prev')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onSearchNav('open')
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        data-tauri-drag-region="deep"
        className="titlebar-lead flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 pt-3 pb-2.5 [--titlebar-pad:1rem]"
      >
        <h1 className="text-lg font-bold tracking-tight">Overmind</h1>
        {overmind ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums" aria-label="Status summary">
            {summary.waiting > 0 ? (
              <span className="flex items-center gap-1 font-semibold text-status-waiting" title="Needs you">
                <StatusDot status="waiting" className="size-2" />
                {summary.waiting}
              </span>
            ) : null}
            <span className="flex items-center gap-1" title="Busy">
              <StatusDot status="busy" className="size-2" />
              {summary.busy}
            </span>
            <span className="flex items-center gap-1" title="Idle">
              <StatusDot status="idle" className="size-2" />
              {summary.idle}
            </span>
          </div>
        ) : null}
        <ViewToggle value={view} onChange={onView} />

        <div className="relative w-64 min-w-40">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-dimmer" />
          <Input
            ref={searchRef}
            type="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Search name, title, cwd…"
            aria-label="Search sessions"
            aria-keyshortcuts={ariaShortcut('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            className="h-8 rounded-lg bg-card pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-lg text-dimmer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <XIcon className="size-4" />
            </button>
          ) : (
            <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">{shortcutHint('search')}</Kbd>
          )}
        </div>

        <ToggleGroup type="single" value={status} onValueChange={(v) => v && setStatus(v as StatusFilterId)} aria-label="Filter by status">
          {visibleStatusFilters(overmind ? lv.counts : null, status).map((f) => (
            <ToggleGroupItem key={f.id} value={f.id} className={chip} title={f.id === 'scheduled' ? 'Sessions started by bots' : undefined}>
              <StatusFilterLabel filter={f} />
              <span className="text-[0.6875rem] text-dimmer tabular-nums group-data-[state=on]/toggle:text-accent-foreground/70">
                {overmind ? lv.counts[f.id] : ''}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {hostNames.length > 1 ? (
          <ToggleGroup type="single" value={host ?? ALL_HOSTS} onValueChange={(v) => v && setHostFilter(v)} aria-label="Filter by host">
            <ToggleGroupItem value={ALL_HOSTS} className={chip}>
              All
            </ToggleGroupItem>
            {hosts.map((h) => (
              <ToggleGroupItem key={h.name} value={h.name} className={chip}>
                <HostDot host={h.name} />
                <span className={cn(h.ok === false && 'text-destructive')}>{h.name}</span>
                <span className="text-[0.6875rem] text-dimmer tabular-nums">{h.ok === false ? '!' : (hostCounts.get(h.name) ?? 0)}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <GroupsStatus state={groups} now={now} />
          <span className={cn('hidden truncate text-[0.6875rem] tabular-nums xl:inline', note.error ? 'text-destructive' : 'text-dimmer')}>{note.text}</span>
          <ModuleButtons className="shrink-0 text-muted-foreground" />
          <Button size="icon" aria-label="New session" title={withHint('New session', 'new')} onClick={onNew} className="shrink-0 rounded-full">
            <PlusIcon />
          </Button>
        </div>
      </div>

      {error || unreachable.length ? (
        <div className="shrink-0 space-y-2 px-4 pt-2">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {overmind ? `Refresh failed: ${error} — showing last known data` : `Could not reach overmind web: ${error}`}
              </AlertDescription>
            </Alert>
          ) : null}
          {unreachable.map((h) => (
            <Alert key={h.name} variant="destructive">
              <AlertDescription className="break-words">
                {h.name} unreachable: {h.error || 'no response'}
              </AlertDescription>
            </Alert>
          ))}
        </div>
      ) : null}

      <div
        ref={boardRef}
        data-session-list
        className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overscroll-x-contain p-3"
        style={overlayInset ? { scrollPaddingRight: overlayInset + 12 } : undefined}
      >
        {!overmind ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-64 w-72 shrink-0 rounded-xl" />)
        ) : columns.length === 0 ? (
          <div className="w-full px-4 py-10 text-center text-sm text-dimmer">
            {allSessions(overmind).length > 0 ? 'Nothing matches.' : 'No Claude sessions running.'}
          </div>
        ) : (
          <BoardColumns
            columns={columns}
            now={now}
            cursorKey={cursorKey}
            selectedKey={selectedKey}
            onOpen={openCard}
            editable={groups.editable}
            onEdit={groups.edit}
            onMoveColumn={onMoveColumn}
          />
        )}
        {overmind ? <DormantSection now={now} host={host} query={query} desktop className="max-h-full w-72 shrink-0 overflow-y-auto rounded-xl border border-dashed p-2" /> : null}
        {overmind && columns.length && overlayInset ? <div aria-hidden className="shrink-0" style={{ width: overlayInset }} /> : null}
      </div>
    </div>
  )
}
