import { LayersIcon } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/api/client'
import type { Session } from '@/api/types'
import { HostBadge } from '@/components/HostBadge'
import { StatusDot } from '@/components/StatusDot'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useOvermind } from '@/hooks/useOvermind'
import { shortCwd } from '@/lib/format'
import { paletteFilter } from '@/lib/palette'
import { allSessions, byLastActivity, findSession } from '@/lib/sessions'
import { sessionKey } from '@/lib/shortcuts'
import { linkPlan, stackErrorMessage, type LinkPlan } from '@/lib/stacks'
import { sessionTitle } from '@/lib/title'

async function runLink(plan: LinkPlan, source: Session, other: Session, refresh: () => void) {
  if (plan.kind === 'same' || plan.kind === 'conflict') return
  const what = `${sessionTitle(source)} + ${sessionTitle(other)}`
  const id = toast.loading(plan.kind === 'create' ? `Creating a stack for ${what}…` : `Adding to ${plan.label}…`)
  try {
    const r =
      plan.kind === 'create'
        ? await api.linkToStack(plan.host, plan.sessionId, plan.other)
        : await api.addToStack(plan.host, plan.stackId, plan.other)
    toast.success(plan.kind === 'create' ? `Stack created: ${r.stack.label}` : `Linked into ${r.stack.label}`, { id })
    refresh()
  } catch (err) {
    toast.error(`Not linked: ${stackErrorMessage(err)}`, { id })
  }
}

/**
 * "Link with a session…": pick another live session to share a stack with this one. Joins the
 * stack either of them is in, or creates one around this session (one model call).
 */
export function StackLinkDialog({ target, onClose }: { target: { host: string; id: string } | null; onClose: () => void }) {
  const { overmind, refresh } = useOvermind()
  const found = target ? findSession(overmind, target.host, target.id) : null
  const source = found && target ? { ...found, host: target.host } : null
  const candidates = source
    ? allSessions(overmind)
        .filter((s) => sessionKey(s) !== sessionKey(source))
        .map((s) => ({ s, plan: linkPlan(source, s) }))
        .filter((c) => c.plan.kind !== 'same')
        .sort((x, y) => byLastActivity(x.s, y.s))
    : []
  const hint = source?.stack?.id
    ? `The picked session joins ${source.stack.label || source.stack.id}.`
    : 'Joins the picked session’s stack, or creates a new one around this session.'
  return (
    <Dialog open={target != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[18%] translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-xl" showCloseButton={false}>
        <div className="px-4 pt-3.5">
          <DialogTitle className="flex items-center gap-1.5 text-sm">
            <LayersIcon className="size-4 text-primary" />
            Link {source ? sessionTitle(source) : 'session'} with…
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">{hint}</DialogDescription>
        </div>
        <Command loop filter={paletteFilter} className="**:data-[slot=command-input-wrapper]:p-2">
          <CommandInput placeholder="Find a session…" aria-label="Session" />
          <CommandList className="max-h-[min(60vh,28rem)]">
            <CommandEmpty>{source ? 'No matches.' : 'This session is not live.'}</CommandEmpty>
            {candidates.length ? (
              <CommandGroup heading="Sessions">
                {candidates.map(({ s, plan }) => {
                  const key = sessionKey(s)
                  return (
                    <CommandItem
                      key={key}
                      value={`session ${key}`}
                      disabled={plan.kind === 'conflict'}
                      keywords={[s.display_title ?? '', s.name ?? '', s.gen_title ?? '', s.title ?? '', s.cwd ?? '', s.tmux_session ?? '', s.host].filter(Boolean)}
                      onSelect={() => {
                        onClose()
                        if (source) void runLink(plan, source, s, refresh)
                      }}
                      className="gap-2.5 py-2"
                    >
                      <StatusDot status={s.status} className="size-2" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{sessionTitle(s)}</span>
                        {s.cwd ? <span className="ml-2 font-mono text-[0.6875rem] text-dimmer">{shortCwd(s.cwd, 40)}</span> : null}
                      </span>
                      {s.stack?.id ? (
                        <span className="inline-flex max-w-[35%] shrink items-center gap-1 text-[0.6875rem] text-primary" title={plan.kind === 'conflict' ? 'Already in another stack' : undefined}>
                          <LayersIcon className="size-3 shrink-0" />
                          <span className="truncate">{s.stack.label || s.stack.id}</span>
                        </span>
                      ) : null}
                      <HostBadge host={s.host} className="h-4 px-1 text-[0.625rem]" />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
