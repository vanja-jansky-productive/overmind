import { describe, expect, it } from 'vitest'

import type { HarnessInfo } from '@/api/types'

import { overmindDefaultLabel, harnessLabel, modelKey, offeredHarnesses, pickHarness, sessionHarness, withOvermindDefault } from './harness'

const claudeModels = [
  { id: '', label: 'Default' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
]

describe('offeredHarnesses', () => {
  it("keeps installed harnesses, Claude first with the host's own model list", () => {
    const rows: HarnessInfo[] = [
      { id: 'pi', label: 'pi', command: 'pi', installed: true, models: [{ id: '', label: 'Default' }, { id: 'openai/gpt-5.5', label: 'gpt-5.5 (openai)' }] },
      { id: 'codex', label: 'Codex', command: 'codex', installed: false, models: [] },
      { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [{ id: 'x', label: 'X' }] },
    ]
    const got = offeredHarnesses(rows, claudeModels)
    expect(got.map((h) => h.id)).toEqual(['claude', 'pi'])
    expect(got[0].models).toEqual([{ id: 'x', label: 'X' }])
    expect(got[1].models.map((m) => m.id)).toEqual(['', 'openai/gpt-5.5'])
  })
  it('gives Claude the settings models when the host lists none (an older server)', () => {
    const rows: HarnessInfo[] = [{ id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [] }]
    expect(offeredHarnesses(rows, claudeModels)[0].models).toEqual(claudeModels)
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

describe('overmind defaults in the picker', () => {
  const models = [
    { id: '', label: 'Default' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  ]
  it('labels the default entry with the host default model and effort', () => {
    expect(overmindDefaultLabel({ defaultModel: 'claude-opus-5-5', defaultEffort: 'high' }, models)).toBe('Opus 5.5 · high')
    expect(overmindDefaultLabel({ defaultModel: 'unknown-x', defaultEffort: null }, models)).toBe('unknown-x')
    expect(overmindDefaultLabel({ defaultModel: null, defaultEffort: 'low' }, models)).toBe('low')
    expect(overmindDefaultLabel({}, models)).toBeNull()
    expect(withOvermindDefault(models, { defaultEffort: 'max' })[0]).toEqual({ id: '', label: 'Default · max' })
    expect(withOvermindDefault(models, {})).toBe(models)
  })
  it('offeredHarnesses carries it to every harness, Claude included', () => {
    const rows = [
      { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [], defaultModel: 'claude-opus-5-5', defaultEffort: 'high' },
      { id: 'codex', label: 'Codex', command: 'codex', installed: true, models: [{ id: '', label: 'Default (gpt-6)' }], defaultEffort: 'xhigh' },
    ]
    const got = offeredHarnesses(rows, models)
    expect(got[0].models[0].label).toBe('Default · Opus 5.5 · high')
    expect(got[1].models[0].label).toBe('Default · xhigh')
  })
})
