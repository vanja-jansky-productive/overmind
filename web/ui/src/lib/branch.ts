import type { HarnessInfo, Message } from '@/api/types'
import { msgKind } from '@/lib/chat'

/** The agents a branch can come from and go to (the server's lib/branch.mjs). */
export const BRANCH_HARNESSES = ['claude', 'codex']

export function canBranchSession(harness: string | null | undefined): boolean {
  return BRANCH_HARNESSES.includes(harness || 'claude')
}

/** A prompt or a reply with a ref; not a queued prompt (not in the transcript's history yet). */
export function canBranchFrom(m: Message): boolean {
  const kind = msgKind(m)
  return !!m.ref && !m.queued && (kind === 'user' || kind === 'assistant' || kind === 'question')
}

/** Branching from a prompt re-sends it; from a reply, the first message is optional. */
export function branchesFromPrompt(m: Message): boolean {
  return msgKind(m) === 'user'
}

/** The offered harnesses a branch can start. */
export function branchTargets(offered: HarnessInfo[]): HarnessInfo[] {
  return offered.filter((h) => BRANCH_HARNESSES.includes(h.id))
}
