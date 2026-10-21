import { Loader2Icon } from 'lucide-react'

import type { Session } from '@/api/types'
import { InlineEdit } from '@/components/InlineEdit'
import { openTitleEditor, stopEditing, useEditing, useRename, useSessionTitle, type TitleScope } from '@/hooks/useTitles'
import { sessionKey, withHint } from '@/lib/shortcuts'
import { MAX_TITLE, titleChanged } from '@/lib/title'
import { cn } from '@/lib/utils'

export interface EditableTitleProps {
  session: Session | null
  scope: TitleScope
  /** When there is no session object yet (a pane opened before the overmind loaded). */
  fallbackKey?: string
  /** Text style of the title (size, weight). */
  className?: string
  /**
   * Does a tap on a touch screen edit? `false` (rows, cards): the tap opens the session,
   * long-press edits. The session header: `true`.
   */
  tapToEdit?: boolean
}

/**
 * A session's one title (`sessionTitle`), editable in place (InlineEdit): click it, Enter or
 * clicking away saves, Esc cancels. Saving is optimistic (hooks/useTitles.ts) and rolls back
 * with a toast when the session is busy or the rename fails.
 */
export function EditableTitle({ session, scope, fallbackKey, className, tapToEdit = false }: EditableTitleProps) {
  const key = session ? sessionKey(session) : (fallbackKey ?? '')
  const { title, saving } = useSessionTitle(session, fallbackKey)
  const editing = useEditing(scope, key) && !!session
  const rename = useRename()

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <InlineEdit
        value={title}
        editing={editing}
        onEdit={session && !saving ? () => openTitleEditor(scope, key) : undefined}
        onCommit={(text) => {
          stopEditing()
          if (session && titleChanged(text, title)) void rename(session, text)
        }}
        onCancel={stopEditing}
        className={cn(className, saving && 'opacity-70')}
        label="Session title"
        hint={withHint('Rename', 'rename')}
        maxLength={MAX_TITLE}
        tapToEdit={tapToEdit}
      />
      {saving ? <Loader2Icon aria-label="Saving" className="size-3 shrink-0 animate-spin text-dimmer" /> : null}
    </span>
  )
}
