import { describe, expect, it } from 'vitest'

import { applySuggestion, findTrigger, rankSuggestions, score, toSuggestions, type Suggestion } from './complete'

describe('findTrigger', () => {
  it('/ completes at the start or mid-sentence (marked inline), not inside a word or past a slash', () => {
    expect(findTrigger('/p-dev:re', 9)).toEqual({ kind: 'skills', query: 'p-dev:re', start: 0, end: 9 })
    expect(findTrigger('  /', 3)).toEqual({ kind: 'skills', query: '', start: 2, end: 3 })
    expect(findTrigger('then run /rev', 13)).toEqual({ kind: 'skills', query: 'rev', start: 9, end: 13, inline: true })
    expect(findTrigger('a/b', 3)).toBeNull()
    expect(findTrigger('see /etc/hosts', 14)).toBeNull()
    expect(findTrigger('/review now', 11)).toBeNull()
    expect(findTrigger('/rev', 4, { skills: false })).toBeNull()
  })

  it('@ and brain: complete at the start or after whitespace', () => {
    expect(findTrigger('read @docs/a', 12)).toEqual({ kind: 'files', query: 'docs/a', start: 5, end: 12 })
    expect(findTrigger('@', 1)).toEqual({ kind: 'files', query: '', start: 0, end: 1 })
    expect(findTrigger('me@host', 7)).toBeNull()
    expect(findTrigger('see brain:she', 13)).toEqual({ kind: 'brain', query: 'she', start: 4, end: 13 })
    expect(findTrigger('xbrain:she', 10)).toBeNull()
    expect(findTrigger('@docs/a.md then', 15)).toBeNull()
  })

  it('takes in the rest of the word under the caret', () => {
    expect(findTrigger('read @docs/arch.md please', 9)).toEqual({ kind: 'files', query: 'doc', start: 5, end: 18 })
  })
})

describe('applySuggestion', () => {
  it('replaces the word and adds one space', () => {
    const t = findTrigger('/rev', 4)!
    expect(applySuggestion('/rev', t, '/p-dev:review')).toEqual({ text: '/p-dev:review ', caret: 14 })
  })

  it('keeps the text after the word; reuses its space', () => {
    const text = 'read @doc please'
    expect(applySuggestion(text, findTrigger(text, 9)!, '@docs/a.md')).toEqual({ text: 'read @docs/a.md please', caret: 16 })
    const glued = 'x @do'
    expect(applySuggestion(glued, findTrigger(glued, 5)!, '@docs/a.md')).toEqual({ text: 'x @docs/a.md ', caret: 13 })
  })
})

describe('toSuggestions', () => {
  it('skills: project, user, plugin, then built-in; hint is the argument hint or the source', () => {
    const r = {
      host: 'h',
      id: 'i',
      kind: 'skills' as const,
      skills: [
        { name: 'clear', description: 'Clear', source: 'builtin' as const },
        { name: 'p:x', description: 'X', source: 'plugin' as const },
        { name: 'deploy', description: 'Ship', source: 'user' as const, argumentHint: '[env]' },
        { name: 'rel', description: '', source: 'project' as const },
      ],
    }
    expect(toSuggestions('skills', r).map((s) => [s.insert, s.hint, s.detail])).toEqual([
      ['/rel', 'project', undefined],
      ['/deploy', '[env]', 'Ship'],
      ['/p:x', 'plugin', 'X'],
      ['/clear', 'built-in', 'Clear'],
    ])
  })

  it('files and brain notes', () => {
    expect(toSuggestions('files', { host: 'h', id: 'i', kind: 'files', files: ['a.md'] })).toEqual([{ insert: '@a.md', label: 'a.md' }])
    const notes = [
      { ref: 'sheds', path: 'sheds.md', title: 'Sheds setup' },
      { ref: 'overmind', path: 'dev/overmind/overmind.md' },
      { ref: 'log', path: 'log.md', title: 'log' },
    ]
    expect(toSuggestions('brain', { host: 'h', id: 'i', kind: 'brain', notes }).map((s) => [s.insert, s.detail])).toEqual([
      ['brain:sheds', 'Sheds setup'],
      ['brain:overmind', 'dev/overmind/overmind.md'],
      ['brain:log', undefined],
    ])
    expect(toSuggestions('files', null)).toEqual([])
  })
})

describe('ranking', () => {
  it('prefix > word start > substring > subsequence', () => {
    expect(score('review', 'rev')).toBeGreaterThan(score('p-dev:review', 'rev'))
    expect(score('p-dev:review', 'rev')).toBeGreaterThan(score('prereview', 'rev'))
    expect(score('prereview', 'rev')).toBeGreaterThan(score('r-e-v', 'rev'))
    expect(score('r-e-v', 'rev')).toBeGreaterThan(0)
    expect(score('abc', 'xyz')).toBe(0)
  })

  it('filters and orders; the detail matches too, below the label', () => {
    const all: Suggestion[] = [
      { insert: '/simplify', label: '/simplify', detail: 'Review the diff' },
      { insert: '/p-dev:review', label: '/p-dev:review' },
      { insert: '/review', label: '/review' },
      { insert: '/clear', label: '/clear' },
    ]
    expect(rankSuggestions(all, 'rev').map((s) => s.insert)).toEqual(['/review', '/p-dev:review', '/simplify'])
    expect(rankSuggestions(all, '').map((s) => s.insert)).toEqual(all.map((s) => s.insert))
    expect(rankSuggestions(all, '', 2)).toHaveLength(2)
  })
})
