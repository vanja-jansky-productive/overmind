import { IdCardIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * A session that acts on GitHub as a GitHub App (`gh_identity`): GitHub icon + the identity name.
 * Nothing for a session acting as the user. Not a link — rows and cards are links already.
 */
export function GhIdentityChip({ session: s, className }: { session: Pick<Session, 'gh_identity'>; className?: string }) {
  const id = s.gh_identity
  if (!id) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Acts on GitHub as ${id}`}
          className={cn(
            'inline-flex h-4.5 max-w-[40%] min-w-0 shrink items-center gap-1 rounded-[5px] border border-primary/40 px-1 text-[0.6875rem] text-primary',
            className,
          )}
        >
          <IdCardIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{id}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Acts on GitHub as {id}, not as you</TooltipContent>
    </Tooltip>
  )
}
