import { useState, type DragEvent } from 'react'
import { LayersIcon, PlusIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { BoardCard } from '@/components/board/BoardCard'
import { DormantCard } from '@/components/board/DormantCard'
import { InlineEdit, InlineField } from '@/components/InlineEdit'
import { StatusSummaryDots } from '@/components/board/StatusSummaryDots'
import { StackColumnMenu } from '@/components/stack/StackColumnMenu'
import { useRenameStack, useStackLabel } from '@/hooks/useStackLabels'
import { PENDING_PREFIX, memberId, type BoardColumn, type GroupEdit } from '@/lib/groups'
import { MAX_STACK_LABEL, stackLabelChanged } from '@/lib/stacks'
import { sessionKey } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

/** `overmind group` caps a hand-written label at this many characters. */
const GROUP_LABEL_MAX = 48

/** Our drags carry this type, so text, links or files dragged over the board are ignored. */
const DRAG_TYPE = 'application/x-overmind-board'

/** A column that is a group: sessions can be dropped on it, it can be renamed through `onEdit` (not Ungrouped, not a session stack — a stack renames through its own route, StackColumnTitle). */
const isGroup = (c: BoardColumn) => !c.ungrouped && c.source !== 'stack'

type Drag = { kind: 'session'; session: Session; from: string } | { kind: 'column'; id: string }
/** Where the drag would land: a column (a session drop, or a column drop on one of its sides) or the "New group" zone. */
type Over = { id: string; side?: 'before' | 'after' } | { id: 'new' }

export interface BoardColumnsProps {
  columns: BoardColumn[]
  cursorKey: string | null
  selectedKey: string | null
  onOpen: (s: Session) => void
  /** Groups can be renamed and sessions moved (the server's groups — not the repo fallback). */
  editable: boolean
  onEdit: (e: GroupEdit) => void
  /** Move column `id` just before `before` (null: to the end). */
  onMoveColumn: (id: string, before: string | null) => void
}

/**
 * The board's Kanban columns. Drag a card onto another column to move the session there (or
 * onto "New group" to start one), drag a column's header to reorder the columns, click a
 * column's name to rename it (a stack column renames the stack). "+ New group" at the end makes an empty column (a group of the
 * user's: it stays until "Delete group"). Ungrouped takes no drops and stays last.
 */
export function BoardColumns({ columns, cursorKey, selectedKey, onOpen, editable, onEdit, onMoveColumn }: BoardColumnsProps) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  /** A session dropped on "New group", waiting for the group's name. */
  const [naming, setNaming] = useState<{ session: Session | null } | null>(null)
  /** The column whose name is being edited (its header stops being draggable meanwhile). */
  const [renaming, setRenaming] = useState<string | null>(null)

  const start = (e: DragEvent, d: Drag) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE, d.kind === 'session' ? sessionKey(d.session) : d.id)
    setDrag(d)
  }
  const end = () => {
    setDrag(null)
    setOver(null)
  }
  const ours = (e: DragEvent) => !!drag && e.dataTransfer.types.includes(DRAG_TYPE)

  /** Can the current drag land on column `c`, and where? */
  const target = (e: DragEvent, c: BoardColumn): Over | null => {
    if (!drag || !ours(e)) return null
    if (drag.kind === 'session') return isGroup(c) && c.id !== drag.from ? { id: c.id } : null
    if (c.id === drag.id) return null
    if (c.ungrouped) return { id: c.id, side: 'before' }
    const r = e.currentTarget.getBoundingClientRect()
    return { id: c.id, side: e.clientX < r.left + r.width / 2 ? 'before' : 'after' }
  }

  const onColumnDragOver = (e: DragEvent, c: BoardColumn) => {
    const t = target(e, c)
    if (!t) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (over?.id !== t.id || ('side' in over && over.side) !== ('side' in t && t.side)) setOver(t)
  }
  const onLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
  }
  const onColumnDrop = (e: DragEvent, c: BoardColumn) => {
    const t = target(e, c)
    if (!t || !drag) return
    e.preventDefault()
    if (drag.kind === 'session') {
      onEdit({ op: 'move', host: drag.session.host, session: memberId(drag.session), to: c.id })
    } else {
      // "After c" is "before the next column" (the dragged one left out).
      const rest = columns.filter((x) => x.id !== drag.id)
      const i = rest.findIndex((x) => x.id === c.id)
      const before = 'side' in t && t.side === 'after' ? (rest[i + 1]?.id ?? null) : c.id
      onMoveColumn(drag.id, before)
    }
    end()
  }

  const showNew = editable && drag?.kind !== 'column'

  return (
    <>
      {columns.map((c) => {
        const hit = over && over.id === c.id ? over : null
        const side = hit && 'side' in hit ? hit.side : undefined
        const canDragColumn = !c.ungrouped && renaming !== c.id
        return (
          <section
            key={c.id}
            aria-label={`${c.label}: ${c.sessions.length} sessions`}
            onDragOver={(e) => onColumnDragOver(e, c)}
            onDragLeave={onLeave}
            onDrop={(e) => onColumnDrop(e, c)}
            className={cn(
              'relative flex max-h-full w-72 shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors',
              c.ungrouped && 'border-dashed',
              c.stack && 'border-primary/25',
              drag?.kind === 'column' && drag.id === c.id && 'opacity-50',
              hit && !side && 'border-primary/60 bg-accent/50',
            )}
          >
            {side ? (
              <div aria-hidden className={cn('absolute inset-y-1 w-0.5 rounded-full bg-primary', side === 'before' ? '-left-[7px]' : '-right-[7px]')} />
            ) : null}
            <header
              draggable={canDragColumn}
              onDragStart={canDragColumn ? (e) => start(e, { kind: 'column', id: c.id }) : undefined}
              onDragEnd={end}
              className={cn('shrink-0 px-3 pt-2.5 pb-2', canDragColumn && 'cursor-grab active:cursor-grabbing')}
              title={c.description ?? undefined}
            >
              <div className="flex min-w-0 items-center gap-2">
                {c.stack ? <LayersIcon aria-label="Session stack" className="size-3.5 shrink-0 text-primary" /> : null}
                {c.stack ? (
                  <StackColumnTitle stack={c.stack} label={c.label} editing={renaming === c.id} onEditing={(on) => setRenaming(on ? c.id : null)} />
                ) : (
                  <ColumnTitle
                    column={c}
                    editable={editable && isGroup(c)}
                    editing={renaming === c.id}
                    onEditing={(on) => setRenaming(on ? c.id : null)}
                    onRename={(label) => onEdit({ op: 'rename', id: c.id, label })}
                  />
                )}
                <StatusSummaryDots summary={c.summary} />
                <span className="rounded-md bg-muted px-1.5 text-[0.6875rem] text-muted-foreground tabular-nums">{c.sessions.length}</span>
                {c.stack ? <StackColumnMenu stack={c.stack} label={c.label} sessions={c.sessions} className="-my-1 -mr-1.5" /> : null}
              </div>
              {c.description ? <p className="mt-0.5 line-clamp-2 text-[0.6875rem] text-dimmer">{c.description}</p> : null}
            </header>
            <div className="flex min-h-0 flex-col gap-1.5 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2 pb-2">
              {c.sessions.length === 0 && !c.dormant?.length ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-3 text-xs text-dimmer">
                  <span>Drag sessions here</span>
                  {!c.id.startsWith(PENDING_PREFIX) ? (
                    <button
                      type="button"
                      onClick={() => onEdit({ op: 'delete', id: c.id })}
                      className="rounded-sm outline-none hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      Delete group
                    </button>
                  ) : null}
                </div>
              ) : null}
              {c.sessions.map((s) => {
                const key = sessionKey(s)
                return (
                  <BoardCard
                    key={key}
                    session={s}
                    selected={key === selectedKey}
                    cursor={key === cursorKey && key !== selectedKey}
                    onOpen={onOpen}
                    drag={
                      editable && isGroup(c)
                        ? { dragging: drag?.kind === 'session' && sessionKey(drag.session) === key, onStart: (e) => start(e, { kind: 'session', session: s, from: c.id }), onEnd: end }
                        : undefined
                    }
                  />
                )
              })}
              {c.dormant?.map((m) => <DormantCard key={`${m.host}/${m.id}`} member={m} desktop />)}
            </div>
          </section>
        )
      })}
      {showNew ? (
        <section
          aria-label="New group"
          onDragOver={(e) => {
            if (drag?.kind !== 'session' || !ours(e)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (over?.id !== 'new') setOver({ id: 'new' })
          }}
          onDragLeave={onLeave}
          onDrop={(e) => {
            if (drag?.kind !== 'session' || !ours(e)) return
            e.preventDefault()
            setNaming({ session: drag.session })
            end()
          }}
          className={cn(
            'flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-dashed p-3 text-sm text-muted-foreground transition-colors',
            over?.id === 'new' && 'border-primary/60 bg-accent/50 text-foreground',
          )}
        >
          {naming ? (
            <span className="flex py-1 text-sm font-semibold text-foreground">
              <InlineField
                placeholder="New group name"
                label="New group name"
                maxLength={GROUP_LABEL_MAX}
                onCommit={(label) => {
                  const s = naming.session
                  setNaming(null)
                  if (!label) return
                  onEdit(s ? { op: 'move', host: s.host, session: memberId(s), label } : { op: 'create', label })
                }}
                onCancel={() => setNaming(null)}
              />
            </span>
          ) : drag?.kind === 'session' ? (
            <span className="flex items-center gap-1.5 py-1">
              <PlusIcon className="size-4" /> Drop here for a new group
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setNaming({ session: null })}
              className="-m-3 flex items-center gap-1.5 rounded-xl p-3 py-4 text-left outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <PlusIcon className="size-4" /> New group
            </button>
          )}
        </section>
      ) : null}
    </>
  )
}

/** A column's name; click it to rename (Enter or clicking away saves, Esc cancels). */
function ColumnTitle({
  column: c,
  editable,
  editing,
  onEditing,
  onRename,
}: {
  column: BoardColumn
  editable: boolean
  editing: boolean
  onEditing: (on: boolean) => void
  onRename: (label: string) => void
}) {
  return (
    <h2 className="flex min-w-0 flex-1">
      <InlineEdit
        value={c.label}
        editing={editing}
        onEdit={editable ? () => onEditing(true) : undefined}
        onCommit={(label) => {
          onEditing(false)
          if (label && label !== c.label) onRename(label)
        }}
        onCancel={() => onEditing(false)}
        className={cn('text-sm font-semibold', c.ungrouped && 'text-muted-foreground')}
        label="Group name"
        hint="Rename group"
        maxLength={GROUP_LABEL_MAX}
      />
    </h2>
  )
}

/**
 * A stack column's name: the stack's label (optimistic while a rename is in flight); click it to
 * rename the stack (`POST …/stacks/:id/rename`, hooks/useStackLabels.ts) — never a group edit.
 */
function StackColumnTitle({
  stack,
  label: server,
  editing,
  onEditing,
}: {
  stack: { id: string; host: string }
  label: string
  editing: boolean
  onEditing: (on: boolean) => void
}) {
  const { label, saving } = useStackLabel(stack.host, stack.id, server)
  const rename = useRenameStack()
  return (
    <h2 className="flex min-w-0 flex-1">
      <InlineEdit
        value={label}
        editing={editing}
        onEdit={saving ? undefined : () => onEditing(true)}
        onCommit={(text) => {
          onEditing(false)
          if (stackLabelChanged(text, label)) void rename(stack.host, stack.id, text)
        }}
        onCancel={() => onEditing(false)}
        className={cn('text-sm font-semibold', saving && 'opacity-70')}
        label="Stack name"
        hint="Rename stack"
        maxLength={MAX_STACK_LABEL}
      />
    </h2>
  )
}
