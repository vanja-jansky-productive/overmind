import { describe, expect, it } from 'vitest'

import type { HarnessInfo } from '@/api/types'

import { pickModel } from './models'
import { defaultEffortLabel, effortKey, effortLabel, effortsFor, overmindDefaultLabel, harnessLabel, modelKey, offeredHarnesses, pickEffort, pickHarness, sessionHarness, withOvermindDefault } from './harness'

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
  it('labels the default entry with the host default model only (the Effort row names the default effort)', () => {
    const opusHigh = { defaultModel: 'claude-opus-5-5', defaultEffort: 'high' }
    const lowOnly = { defaultModel: null, defaultEffort: 'low' }
    expect(overmindDefaultLabel(opusHigh, models)).toBe('Opus 5.5')
    expect(overmindDefaultLabel({ defaultModel: 'unknown-x' }, models)).toBe('unknown-x')
    expect(overmindDefaultLabel(lowOnly, models)).toBeNull()
    expect(overmindDefaultLabel({}, models)).toBeNull()
    expect(withOvermindDefault(models, opusHigh)[0]).toEqual({ id: '', label: 'Default · Opus 5.5' })
    expect(withOvermindDefault(models, lowOnly)).toBe(models)
    expect(withOvermindDefault(models, {})).toBe(models)
  })
  it('offeredHarnesses carries it to every harness, Claude included', () => {
    const rows = [
      { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, models: [], defaultModel: 'claude-opus-5-5', defaultEffort: 'high' },
      { id: 'codex', label: 'Codex', command: 'codex', installed: true, models: [{ id: '', label: 'Default' }], defaultEffort: 'xhigh' },
    ]
    const got = offeredHarnesses(rows, models)
    expect(got[0].models[0].label).toBe('Default · Opus 5.5')
    expect(got[1].models[0].label).toBe('Default')
  })
})

describe('Codex models (the host lists the newest of each family)', () => {
  const codex: HarnessInfo = {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    installed: true,
    models: [
      { id: '', label: 'Default' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ],
  }
  it('offers them as listed, in order', () => {
    const got = offeredHarnesses([codex], claudeModels).find((h) => h.id === 'codex')
    expect(got?.models).toEqual(codex.models)
  })
  it('its Default chip reads exactly as Claude\'s', () => {
    const got = offeredHarnesses([codex], claudeModels)
    expect(got.find((h) => h.id === 'codex')?.models[0]).toEqual(got.find((h) => h.id === 'claude')?.models[0])
  })
  it('a remembered older version the list no longer offers falls back to Default', () => {
    expect(pickModel(codex.models, 'gpt-5.6-sol')).toBe('')
    expect(pickModel(codex.models, 'gpt-6.1-terra')).toBe('gpt-6.1-terra')
  })
})

describe('effort chips (per harness, per model)', () => {
  const six = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const five = ['low', 'medium', 'high', 'xhigh', 'max']
  const codex: HarnessInfo = {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    installed: true,
    efforts: six,
    models: [
      { id: '', label: 'Default', efforts: five },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: six },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: five },
    ],
  }
  const claude: HarnessInfo = { id: 'claude', label: 'Claude Code', command: 'claude', installed: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: claudeModels }
  it("offers the picked model's own levels (Codex), else the harness's (Claude)", () => {
    const [cl, cx] = offeredHarnesses([claude, codex], claudeModels)
    expect(effortsFor(cx, 'gpt-6.1-sol')).toEqual(six)
    expect(effortsFor(cx, 'gpt-6-luna')).toEqual(five)
    expect(effortsFor(cx, ''), 'Default: the levels of the model it starts').toEqual(five)
    expect(effortsFor(cx, 'gpt-unknown')).toEqual(six)
    expect(effortsFor(cl, 'claude-opus-5-5')).toEqual(claude.efforts)
    expect(effortsFor({ ...claude, efforts: undefined }, ''), 'an older server: no row').toEqual([])
    expect(effortsFor(undefined, '')).toEqual([])
  })
  it('a remembered effort the model does not take falls back to Default, and comes back with a model that does', () => {
    expect(pickEffort(effortsFor(codex, 'gpt-6.1-sol'), 'ultra')).toBe('ultra')
    expect(pickEffort(effortsFor(codex, 'gpt-6-luna'), 'ultra')).toBe('')
    expect(pickEffort(five, null)).toBe('')
    expect(pickEffort(five, 'high')).toBe('high')
  })
  it('is remembered per harness; chips read like the model chips', () => {
    expect(effortKey('claude')).toBe('overmind.spawnEffort.claude')
    expect(effortKey('codex')).toBe('overmind.spawnEffort.codex')
    expect(['minimal', 'low', 'xhigh', 'max', 'ultra', 'off', 'weird'].map(effortLabel)).toEqual(['Minimal', 'Low', 'XHigh', 'Max', 'Ultra', 'Off', 'weird'])
    expect(defaultEffortLabel({ defaultEffort: 'xhigh' })).toBe('Default · XHigh')
    expect(defaultEffortLabel({})).toBe('Default')
  })
  it("keeps each model's levels through offeredHarnesses (normalizeModels)", () => {
    const got = offeredHarnesses([codex], claudeModels).find((h) => h.id === 'codex')
    expect(got?.models.map((m) => m.efforts)).toEqual([five, six, five])
  })
})
