import { expect, test } from 'vitest'

import type { HarnessInfo, Message } from '@/api/types'
import { branchTargets, branchesFromPrompt, canBranchFrom, canBranchSession } from '@/lib/branch'

const m = (o: Partial<Message>): Message => ({ role: 'assistant', kind: 'assistant', text: 'x', ...o })

test('branching is offered on prompts and replies with a ref, for Claude and Codex sessions', () => {
  expect(canBranchFrom(m({ ref: 'a1' }))).toBe(true)
  expect(canBranchFrom(m({ role: 'user', kind: 'user', ref: 'u1' }))).toBe(true)
  expect(canBranchFrom(m({}))).toBe(false)
  expect(canBranchFrom(m({ role: 'user', kind: 'user', ref: 'u2', queued: true }))).toBe(false)
  expect(canBranchFrom(m({ role: 'system', kind: 'command', ref: 'c1' }))).toBe(false)
  expect(branchesFromPrompt(m({ role: 'user', kind: 'user' }))).toBe(true)
  expect(canBranchSession(null)).toBe(true)
  expect(canBranchSession('codex')).toBe(true)
  expect(canBranchSession('pi')).toBe(false)
})

test('a branch can start Claude or Codex, never pi', () => {
  const h = (id: string): HarnessInfo => ({ id, label: id, command: id, installed: true, models: [] })
  expect(branchTargets([h('claude'), h('codex'), h('pi')]).map((x) => x.id)).toEqual(['claude', 'codex'])
})
