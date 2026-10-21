import { describe, expect, it } from 'vitest'

import { MAX_TITLE, PENDING_TTL_MS, echoesTitle, renameFailure, sessionTitle, titleChanged, tmuxNote, validateTitle } from '@/lib/title'

describe('sessionTitle', () => {
  it('draws the CLI display_title, else (older CLIs) the name / generated title / short id', () => {
    expect(sessionTitle({ display_title: ' Fix login ', name: 'app-9d', gen_title: 'x' })).toBe('Fix login')
    expect(sessionTitle({ name: 'docs-refresh', gen_title: 'x' })).toBe('docs-refresh')
    expect(sessionTitle({ name: '  ', gen_title: 'cache-warmup' })).toBe('cache-warmup')
    expect(sessionTitle({ session_id: '0123456789abcdef' })).toBe('01234567')
    expect(sessionTitle(null)).toBe('(unnamed)')
  })

  it('shows an optimistic title until the overmind reflects it or it expires', () => {
    const s = { display_title: 'old' }
    const at = 1_000
    expect(sessionTitle(s, { title: 'new', at }, at + 10)).toBe('new')
    // Reflected: the server's title is the same — nothing to override.
    expect(sessionTitle({ display_title: 'new' }, { title: 'new', at }, at + 10)).toBe('new')
    // Expired: whatever the server says wins (a rename that never landed).
    expect(sessionTitle(s, { title: 'new', at }, at + PENDING_TTL_MS + 1)).toBe('old')
    expect(sessionTitle(s, null)).toBe('old')
  })
})

describe('validateTitle / titleChanged', () => {
  it('trims and enforces one line of 1..64 characters', () => {
    expect(validateTitle('  Fix login  ')).toEqual({ ok: true, title: 'Fix login' })
    expect(validateTitle('   ').ok).toBe(false)
    expect(validateTitle('a\nb').ok).toBe(false)
    expect(validateTitle('x'.repeat(MAX_TITLE)).ok).toBe(true)
    expect(validateTitle('x'.repeat(MAX_TITLE + 1)).ok).toBe(false)
    // Counted in characters, not UTF-16 units.
    expect(validateTitle('🚀'.repeat(MAX_TITLE)).ok).toBe(true)
  })

  it('only a valid, different title is worth saving', () => {
    expect(titleChanged('new', 'old')).toBe(true)
    expect(titleChanged(' old ', 'old')).toBe(false)
    expect(titleChanged('', 'old')).toBe(false)
  })
})

describe('rename feedback', () => {
  it('a held (409) rename says nothing was typed, and why', () => {
    expect(renameFailure(409, 'x is waiting on you — nothing sent').title).toMatch(/waiting on you/)
    expect(renameFailure(409, '').description).toMatch(/Nothing was typed/)
  })

  it('other failures carry the server message', () => {
    expect(renameFailure(502, 'rename failed: tmux: boom')).toEqual({ title: 'Rename failed', description: 'rename failed: tmux: boom' })
    expect(renameFailure(0, '').description).toBe('request failed')
  })

  it('reports the tmux session only when it was renamed', () => {
    expect(tmuxNote({ renamed: true, to: 'fix-login' })).toBe('tmux session → fix-login')
    expect(tmuxNote({ renamed: false, note: 'left `work` alone' })).toBe('')
    expect(tmuxNote(null)).toBe('')
  })

  it('hides a subtitle that only repeats the title', () => {
    expect(echoesTitle('why-is-the-statusline-blank', 'Why is the statusline blank?')).toBe(true)
    expect(echoesTitle('fix-login', 'please fix the login flow')).toBe(false)
    expect(echoesTitle('', '')).toBe(false)
  })
})
