import { useMemo } from 'react'
import { useLocation } from 'wouter'

import { StatusDot } from '@/components/StatusDot'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useOvermind } from '@/hooks/useOvermind'
import { formatPath } from '@/lib/attach'
import { setDraft } from '@/lib/drafts'
import { shortCwd } from '@/lib/format'
import { allSessions, byLastActivity, sessionHref, statusLabel } from '@/lib/sessions'
import { sessionTitle } from '@/lib/title'

/**
 * Pick a session on the note's host: it opens with the note's absolute path in its composer
 * (nothing is sent — the user finishes the prompt). Sessions on other hosts can't read the file.
 */
export function SendNoteDialog({ open, onOpenChange, host, absPath }: { open: boolean; onOpenChange: (o: boolean) => void; host: string; absPath: string }) {
  const { overmind } = useOvermind()
  const [, navigate] = useLocation()
  const sessions = useMemo(() => allSessions(overmind).filter((s) => s.host === host && s.status !== 'unknown').sort(byLastActivity), [overmind, host])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="border-b px-4 py-3">
          <DialogTitle className="text-[0.9375rem]">Send to a session on {host}</DialogTitle>
          <DialogDescription className="text-xs">The note’s path goes into its composer; nothing is sent until you do.</DialogDescription>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto p-1.5">
          {sessions.length === 0 ? <li className="px-3 py-6 text-center text-sm text-dimmer">No sessions running on {host}.</li> : null}
          {sessions.map((s) => (
            <li key={s.session_id}>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => {
                  setDraft(`${s.host}/${s.session_id}`, `${formatPath(absPath)} `)
                  onOpenChange(false)
                  navigate(sessionHref(s))
                }}
              >
                <StatusDot status={s.status} className="size-2" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{sessionTitle(s)}</span>
                  {s.cwd ? <span className="block truncate font-mono text-[0.6875rem] text-dimmer">{shortCwd(s.cwd, 48)}</span> : null}
                </span>
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{statusLabel(s)}</span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
