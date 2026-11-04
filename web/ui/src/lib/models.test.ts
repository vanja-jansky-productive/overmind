import { describe, expect, it } from 'vitest'

import { DEFAULT_MODELS, normalizeModels, pickModel } from './models'

describe('normalizeModels', () => {
  it('falls back to the defaults for absent / empty / broken input', () => {
    expect(normalizeModels(undefined)).toBe(DEFAULT_MODELS)
    expect(normalizeModels([])).toBe(DEFAULT_MODELS)
    expect(normalizeModels([null, 3, { label: 'x' }])).toBe(DEFAULT_MODELS)
  })
  it('keeps well-formed entries, dedupes ids and fills missing labels', () => {
    expect(normalizeModels([{ id: '', label: '' }, { id: 'claude-sonnet-5', label: 'Sonnet' }, { id: 'claude-sonnet-5', label: 'dup' }, { id: 'x' }])).toEqual([
      { id: '', label: 'Default' },
      { id: 'claude-sonnet-5', label: 'Sonnet' },
      { id: 'x', label: 'x' },
    ])
  })
})

describe('pickModel', () => {
  it('uses the remembered id only while it is offered', () => {
    expect(pickModel(DEFAULT_MODELS, 'sonnet')).toBe('sonnet')
    expect(pickModel(DEFAULT_MODELS, '')).toBe('')
    expect(pickModel(DEFAULT_MODELS, 'gone')).toBe('')
    expect(pickModel(DEFAULT_MODELS, null)).toBe('')
    expect(pickModel([{ id: 'a', label: 'A' }], 'gone')).toBe('a')
    expect(pickModel([], 'x')).toBe('')
  })
})
