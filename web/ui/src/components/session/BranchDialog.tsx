import { useState } from 'react'
import { GitBranchIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/api/client'
import type { Message } from '@/api/types'
import { watchForSpawned } from '@/api/spawnWatch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useOvermind } from '@/hooks/useOvermind'
import { useHarnesses } from '@/hooks/useHarnesses'
import { useSettings } from '@/hooks/useSettings'
import { branchTargets, branchesFromPrompt } from '@/lib/branch'
import { defaultEffortLabel, effortLabel, effortsFor, harnessLabel, offeredHarnesses, pickEffort } from '@/lib/harness'
import { sessionHref } from '@/lib/sessions'

// Radix ToggleGroup treats '' as "nothing selected": the default model / effort needs a stand-in.
const DEFAULT_VALUE = '__default'
const CHIP = 'h-9 shrink-0 rounded-full border border-border bg-card px-3.5 text-sm data-[state=on]:border-primary/50 data-[state=on]:bg-accent'

export interface BranchDialogProps {
  host: string
  sessionId: string
  /** The source session's agent: the default for the branch. */
  harness: string
  /** The message branched from; null = closed. */
  from: Message | null
  onClose: () => void
  onOpenSession: (href: string) => void
}

/**
 * "Branch from here": a new session holding the conversation up to and including `from`, with
 * the same or another agent and model. A prompt branched from is sent again (editable).
 */
export function BranchDialog(p: BranchDialogProps) {
  return (
    <Dialog open={!!p.from} onOpenChange={(o) => !o && p.onClose()}>
      <DialogContent className="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg">
        {p.from ? <BranchForm key={p.from.ref} {...p} from={p.from} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function BranchForm({ host, sessionId, harness: source, from, onClose, onOpenSession }: BranchDialogProps & { from: Message }) {
  const { models: claudeModels } = useSettings()
  const { applyOvermind } = useOvermind()
  const targets = branchTargets(offeredHarnesses(useHarnesses(host).harnesses, claudeModels))
  const isPrompt = branchesFromPrompt(from)
  const [harness, setHarness] = useState(source)
  const [model, setModel] = useState('')
  // Not remembered, like the model: a branch starts from Default.
  const [effortChoice, setEffortChoice] = useState('')
  const [prompt, setPrompt] = useState(isPrompt ? from.text : '')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const target = targets.find((h) => h.id === harness)
  const models = target?.models ?? [{ id: '', label: 'Default' }]
  // The levels the picked model takes; a pick it doesn't take reads Default (and comes back with one that does).
  const efforts = effortsFor(target, model)
  const effort = pickEffort(efforts, effortChoice)
  const who = harnessLabel(harness)
  const crossAgent = harness !== source

  const start = async () => {
    if (!from.ref || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.branch(host, sessionId, {
        ref: from.ref,
        harness,
        model: model || undefined,
        effort: effort || undefined,
        prompt: isPrompt || prompt.trim() ? prompt : undefined,
        title: title.trim() || undefined,
      })
      onClose()
      const id = toast.loading(`Branching into ${res.spawn.name}…`, {
        description: `Waiting for ${who} to register`,
      })
      watchForSpawned(
        { host, name: res.spawn.name, tmuxSession: res.spawn.tmuxSession },
        {
          onOvermind: applyOvermind,
          onFound: (s) => {
            toast.success(`${res.spawn.name} is up`, {
              id,
              description: undefined,
            })
            onOpenSession(sessionHref(s))
          },
          onTimeout: () =>
            toast.error(`${res.spawn.name} has not shown up yet`, {
              id,
              description: 'Check the list in a moment',
            }),
        },
      )
    } catch (err) {
      setError((err as Error)?.message || 'Branch failed')
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <GitBranchIcon className="size-4" /> Branch from here
        </DialogTitle>
        <DialogDescription>
          {isPrompt
            ? 'A new session with the conversation before this prompt; the prompt is sent again.'
            : 'A new session with the conversation up to and including this reply.'}{' '}
          This session stays as it is.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        {targets.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label>Agent</Label>
            <ToggleGroup
              type="single"
              value={harness}
              onValueChange={(v) => {
                if (!v) return
                setHarness(v)
                setModel('')
                setEffortChoice('')
              }}
              aria-label="Agent"
              className="justify-start"
            >
              {targets.map((h) => (
                <ToggleGroupItem key={h.id} value={h.id} className={CHIP}>
                  {h.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {crossAgent ? (
              <p className="text-xs text-muted-foreground">{who} gets the conversation as a file to read — prompts and replies, without the tool calls.</p>
            ) : null}
          </div>
        ) : null}

        {models.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <ToggleGroup
              type="single"
              value={model || DEFAULT_VALUE}
              onValueChange={(v) => v && setModel(v === DEFAULT_VALUE ? '' : v)}
              aria-label="Model"
              className="no-scrollbar flex-wrap justify-start"
            >
              {models.map((m) => (
                <ToggleGroupItem
                  key={m.id || DEFAULT_VALUE}
                  value={m.id || DEFAULT_VALUE}
                  title={m.id || `${who}'s default model`}
                  className={CHIP}
                >
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        ) : null}

        {efforts.length ? (
          <div className="flex flex-col gap-1.5">
            <Label>Effort</Label>
            <ToggleGroup
              type="single"
              value={effort || DEFAULT_VALUE}
              onValueChange={(v) => v && setEffortChoice(v === DEFAULT_VALUE ? '' : v)}
              aria-label="Effort"
              className="no-scrollbar flex-wrap justify-start"
            >
              <ToggleGroupItem value={DEFAULT_VALUE} title={`${who}'s default effort`} className={CHIP}>
                {target ? defaultEffortLabel(target) : 'Default'}
              </ToggleGroupItem>
              {efforts.map((l) => (
                <ToggleGroupItem key={l} value={l} title={l} className={CHIP}>
                  {effortLabel(l)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch-title">
            Title <span className="font-normal text-dimmer">optional</span>
          </Label>
          <Input
            id="branch-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={64}
            placeholder="Leave empty for “<this session>-branch”"
            className="h-9"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branch-prompt">
            {isPrompt ? 'Prompt to send' : 'First message'} {isPrompt ? null : <span className="font-normal text-dimmer">optional</span>}
          </Label>
          <Textarea
            id="branch-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={isPrompt ? 5 : 3}
            placeholder={isPrompt ? '' : 'Leave empty to continue later'}
            className="max-h-64"
          />
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={start} disabled={busy || (isPrompt && !prompt.trim())}>
            {busy ? <Loader2Icon className="animate-spin" /> : <GitBranchIcon />}
            Branch
          </Button>
        </div>
      </div>
    </>
  )
}
