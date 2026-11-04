import { useState } from 'react'
import { ChevronRightIcon, LayersIcon } from 'lucide-react'

import { DormantCard } from '@/components/board/DormantCard'
import { StatusSummaryDots } from '@/components/board/StatusSummaryDots'
import { SessionRow } from '@/components/SessionRow'
import { StackColumnMenu } from '@/components/stack/StackColumnMenu'
import { useStackLabel } from '@/hooks/useStackLabels'
import { parseIdList, type BoardColumn } from '@/lib/groups'
import { sessionKey } from '@/lib/shortcuts'
import { storage } from '@/lib/storage'
import { cn } from '@/lib/utils'

const COLLAPSED_KEY = 'overmind.groupsCollapsed'

/** Mobile board: one collapsible section per group / session stack (collapsed ids persist in `overmind.groupsCollapsed`); stacks get a ⋯ menu. */
export function GroupedList({ columns }: { columns: BoardColumn[] }) {
  const [collapsed, setCollapsed] = useState<string[]>(() => parseIdList(storage.getJSON(COLLAPSED_KEY)))
  const toggle = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]
    setCollapsed(next)
    storage.setJSON(COLLAPSED_KEY, next)
  }

  return (
    <div className="flex flex-col gap-3">
      {columns.map((c) => {
        const open = !collapsed.includes(c.id)
        const bodyId = `group-${c.id}`
        return (
          <section key={c.id} aria-label={c.label} className="relative">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => toggle(c.id)}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronRightIcon className={cn('size-4 shrink-0 text-dimmer transition-transform', open && 'rotate-90')} />
              <span className="min-w-0 flex-1">
                <span className={cn('flex min-w-0 items-center gap-1.5 text-[0.9375rem] font-semibold', c.ungrouped && 'text-muted-foreground')}>
                  {c.stack ? <LayersIcon aria-label="Session stack" className="size-3.5 shrink-0 text-primary" /> : null}
                  <ColumnLabel column={c} />
                </span>
                {c.description ? <span className="block truncate text-xs text-dimmer">{c.description}</span> : null}
              </span>
              <StatusSummaryDots summary={c.summary} />
              <span className="rounded-md bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{c.sessions.length}</span>
              {/* Room for the stack menu, which sits over the button (no button inside a button). */}
              {c.stack ? <span aria-hidden className="w-9 shrink-0" /> : null}
            </button>
            {c.stack ? (
              <div className="absolute top-0 right-0 flex h-11 items-center">
                <StackColumnMenu stack={c.stack} label={c.label} sessions={c.sessions} className="size-10 rounded-lg" />
              </div>
            ) : null}
            {open ? (
              <div id={bodyId} className="mt-1 flex flex-col gap-2">
                {c.sessions.map((s) => (
                  <SessionRow key={sessionKey(s)} session={s} />
                ))}
                {c.dormant?.map((m) => <DormantCard key={`${m.host}/${m.id}`} member={m} />)}
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/** A section's name — a stack's optimistic label while a rename is in flight (hooks/useStackLabels.ts). */
function ColumnLabel({ column: c }: { column: BoardColumn }) {
  const { label } = useStackLabel(c.stack?.host, c.stack?.id, c.label)
  return <span className="min-w-0 truncate">{label}</span>
}
