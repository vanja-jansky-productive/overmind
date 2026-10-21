import { describe, expect, it } from 'vitest'

import type { HarnessInfo } from '@/api/types'

import { harnessLabel, modelKey, offeredHarnesses, pickHarness, sessionHarness } from './harness'

const claudeModels = [
  { id: '', label: 'Default' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
]

describe('offeredHarnesses', () => {
  it('keeps installed harnesses, Claude first with the configured models', () => {
    const rows: HarnessInfo[] = [
      { id: 'pi', label: 'pi', command: 'pi', installed: true, models: [{ id: '', label: 'Default' }, { id: 'openai/gpt-5.5', label: 'gpt-5.5 (openai)' }] },
      { id: 'codex', label: 'Codex', command: 'codex', installed: false, models: [] },
      { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [{ id: 'x', label: 'X' }] },
    ]
    const got = offeredHarnesses(rows, claudeModels)
    expect(got.map((h) => h.id)).toEqual(['claude', 'pi'])
    expect(got[0].models).toBe(claudeModels)
    expect(got[1].models.map((m) => m.id)).toEqual(['', 'openai/gpt-5.5'])
  })
  it('falls back to Claude alone when the host says nothing', () => {
    expect(offeredHarnesses(null, claudeModels).map((h) => h.id)).toEqual(['claude'])
  })
})

describe('pickHarness / labels', () => {
  it('remembers an offered choice, else Claude', () => {
    const offered = offeredHarnesses(null, claudeModels)
    expect(pickHarness(offered, 'codex')).toBe('claude')
    expect(harnessLabel('codex')).toBe('Codex')
    expect(harnessLabel(undefined)).toBe('Claude')
    expect(sessionHarness({})).toBe('claude')
    expect(modelKey('claude')).toBe('overmind.spawnModel')
    expect(modelKey('pi')).toBe('overmind.spawnModel.pi')
  })
})
