import { createContext, useContext } from 'react'

import type { DormantMember, HostDormant } from '@/lib/dormant'

export interface DormantState {
  /** Hosts with dormant or recently closed sessions (others left out), in overmind order. */
  hosts: HostDormant[]
  /** Dormant Claude sessions by `host/sessionId` (the Board's dimmed cards). */
  index: Map<string, DormantMember>
  count: number
  /** Recently closed entries over every host. */
  closedCount: number
  /** `host/target` (or `host/*` for all; `host/closed/target` for a closed one) of the requests in flight. */
  busy: ReadonlySet<string>
  /** Bring one back (`target`: the tmux name or a session id). Starts agents. Toasts the result. */
  resume: (host: string, target: string) => Promise<void>
  resumeAll: (host: string) => Promise<void>
  forget: (host: string, target: string) => Promise<void>
  /** A recently closed session: resume (starts agents) / forget. No "all" for these. */
  resumeClosed: (host: string, target: string) => Promise<void>
  forgetClosed: (host: string, target: string) => Promise<void>
  refresh: () => void
}

const EMPTY: DormantState = {
  hosts: [],
  index: new Map(),
  count: 0,
  closedCount: 0,
  busy: new Set(),
  resume: async () => {},
  resumeAll: async () => {},
  forget: async () => {},
  resumeClosed: async () => {},
  forgetClosed: async () => {},
  refresh: () => {},
}

export const DormantContext = createContext<DormantState | null>(null)

/** The dormant sessions of every reachable host (providers/DormantProvider.tsx); empty outside the provider. */
export function useDormant(): DormantState {
  return useContext(DormantContext) ?? EMPTY
}
