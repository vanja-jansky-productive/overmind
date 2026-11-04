import { describe, expect, test } from 'vitest'

import {
  clockTime,
  modelLabel,
  ctxLevel,
  ctxSummary,
  firstLine,
  fmtTokens,
  hostColorSlot,
  relTime,
  sessionSubtitle,
  shortCwd,
} from './format'

describe('relTime', () => {
  const now = 1_000_000_000_000
  test('seconds, minutes, hours, days', () => {
    expect(relTime(now - 5_000, now)).toBe('5s')
    expect(relTime(now - 5 * 60_000, now)).toBe('5m')
    expect(relTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relTime(now - 47 * 3_600_000, now)).toBe('47h')
    expect(relTime(now - 4 * 86_400_000, now)).toBe('4d')
  })
  test('future clamps to 0s; missing is empty', () => {
    expect(relTime(now + 10_000, now)).toBe('0s')
    expect(relTime(0, now)).toBe('')
    expect(relTime(null, now)).toBe('')
    expect(relTime(Number.NaN, now)).toBe('')
  })
})

test('clockTime: time today, date + time otherwise', () => {
  const now = new Date(2026, 6, 3, 18, 0).getTime()
  expect(clockTime(new Date(2026, 6, 3, 14, 3).getTime(), now)).toBe('14:03')
  expect(clockTime(new Date(2026, 6, 2, 9, 5).getTime(), now)).toBe('2.7. 09:05')
  expect(clockTime(undefined, now)).toBe('')
})

test('shortCwd: home → ~, head-truncated', () => {
  expect(shortCwd('/Users/someone/Code/project')).toBe('~/Code/project')
  expect(shortCwd('/home/someone/src')).toBe('~/src')
  expect(shortCwd('/srv/app')).toBe('/srv/app')
  const long = `/srv/${'a'.repeat(60)}/tail`
  const out = shortCwd(long)
  expect(out.length).toBe(46)
  expect(out.startsWith('…')).toBe(true)
  expect(out.endsWith('/tail')).toBe(true)
  expect(shortCwd(null)).toBe('')
})

test('firstLine / sessionSubtitle', () => {
  expect(firstLine('\n  \n  hello \nworld')).toBe('hello')
  expect(firstLine(undefined)).toBe('')
  // The generated title is part of the one title now, never the subtitle.
  expect(sessionSubtitle({ title: 'first prompt' })).toBe('first prompt')
  expect(sessionSubtitle({ title: '\nfirst prompt\nmore' })).toBe('first prompt')
  expect(sessionSubtitle({ title: 'x'.repeat(300) })).toBe(`${'x'.repeat(240)}…`)
})

test('hostColorSlot: stable, in range', () => {
  // hash = (hash * 31 + codePoint) >>> 0, slot = hash % 4
  const expected = (s: string) => {
    let h = 0
    for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0
    return h % 4
  }
  for (const name of ['laptop', 'workstation', 'local', '', 'ÄÖ-host']) {
    expect(hostColorSlot(name)).toBe(expected(name))
  }
  expect(hostColorSlot('laptop')).toBe(hostColorSlot('laptop'))
})

describe('context usage', () => {
  test('bands match the CLI', () => {
    expect(ctxLevel(0)).toBe('low')
    expect(ctxLevel(59)).toBe('low')
    expect(ctxLevel(60)).toBe('warn')
    expect(ctxLevel(85)).toBe('warn')
    expect(ctxLevel(86)).toBe('hot')
  })
  test('token counts are compact', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(124_300)).toBe('124k')
    expect(fmtTokens(200_000)).toBe('200k')
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtTokens(1_250_000)).toBe('1.3M')
  })
  test('summary', () => {
    expect(ctxSummary({ used: 124_000, window: 200_000, pct: 62, model: 'claude-x' })).toBe('124k / 200k · 62%')
    expect(ctxSummary(null)).toBe('')
    expect(ctxSummary(undefined)).toBe('')
  })
})

describe('modelLabel', () => {
  test('shortens Claude model ids', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('sonnet')).toBe('Sonnet')
    expect(modelLabel('opus[1m]')).toBe('Opus 1M')
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
    expect(modelLabel('some-other-model')).toBe('some-other-model')
    expect(modelLabel(null)).toBe('')
  })
})
