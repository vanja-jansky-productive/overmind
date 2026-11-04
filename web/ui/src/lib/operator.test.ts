import { describe, expect, it } from 'vitest'

import type { Message, Session } from '@/api/types'
import { conversation, newlyWaiting, replyToSpeak, sessionKey, waitingAnnouncement, waitingKeys } from './operator'

const msg = (m: Partial<Message>): Message => ({ role: 'assistant', kind: 'assistant', text: 'x', ...m })
const ses = (id: string, status: string, title = id): Session => ({ host: 'laptop', session_id: id, status, display_title: title })

describe('conversation', () => {
  it('keeps prompts and final replies, drops narration, commands and blanks', () => {
    const turns = conversation([
      msg({ role: 'user', kind: 'user', text: 'što radimo?' }),
      msg({ text: 'Gledam…', final: false }),
      msg({ role: 'user', kind: 'command', text: '/clear' }),
      msg({ text: '  ' }),
      msg({ text: 'Tri sesije rade.', final: true }),
    ])
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'što radimo?'],
      ['assistant', 'Tri sesije rade.'],
    ])
  })
})

describe('replyToSpeak', () => {
  const turns = conversation([msg({ role: 'user', kind: 'user', text: 'q' }), msg({ text: 'a' })])
  it('is the last reply once the operator is done, and only once', () => {
    expect(replyToSpeak(turns, 'idle', null)?.text).toBe('a')
    expect(replyToSpeak(turns, 'busy', null)).toBeNull()
    expect(replyToSpeak(turns, 'idle', turns[1].key)).toBeNull()
    expect(replyToSpeak(turns.slice(0, 1), 'idle', null)).toBeNull()
  })
  it('reads a final reply while the status still says busy, when told the turn is final', () => {
    expect(replyToSpeak(turns, 'busy', null, { final: true })?.text).toBe('a')
    expect(replyToSpeak(turns, 'busy', turns[1].key, { final: true })).toBeNull()
  })
})

describe('speechChunks', () => {
  it('keeps a short reply whole', async () => {
    const { speechChunks } = await import('./operator')
    expect(speechChunks('Tri sesije rade. Jedna te čeka.')).toEqual(['Tri sesije rade. Jedna te čeka.'])
    expect(speechChunks('```\ncode\n```')).toEqual([])
  })
  it('starts with a short piece and groups the rest', async () => {
    const { speechChunks } = await import('./operator')
    const s = (n: number) => `${'riječ '.repeat(n).trim()}.`
    const text = [s(3), s(10), s(20), s(30), s(40), s(10)].join(' ')
    const parts = speechChunks(text)
    expect(parts.join(' ')).toBe(text)
    expect(parts[0]).toBe(`${s(3)} ${s(10)}`)
    expect(parts.slice(1).every((p) => p.length <= 500)).toBe(true)
    expect(parts.length).toBeGreaterThan(2)
    expect(speechChunks(`Gotovo. ${s(60)} ${s(5)}`)[0]).toBe(`Gotovo. ${s(60)}`)
    const long = `${'riječ '.repeat(15).trim()}, ${s(40)} ${s(5)}`
    expect(speechChunks(long)[0]).toBe(`${'riječ '.repeat(15).trim()},`)
    expect(speechChunks(long).join(' ')).toBe(long)
  })
})

describe('waiting sessions', () => {
  it('finds the ones that just started waiting, never the operator', () => {
    const before = waitingKeys([ses('a', 'waiting'), ses('b', 'busy')])
    const now = [ses('a', 'waiting'), ses('b', 'waiting'), ses('op', 'waiting'), ses('c', 'idle')]
    expect(newlyWaiting(now, before, sessionKey(ses('op', 'x'))).map((s) => s.session_id)).toEqual(['b'])
  })
  it('announces them in one sentence', () => {
    expect(waitingAnnouncement([])).toBe('')
    expect(waitingAnnouncement([ses('a', 'waiting', 'overmind docs')])).toBe('overmind docs te čeka.')
    expect(waitingAnnouncement([ses('a', 'waiting', 'A'), ses('b', 'waiting', 'B'), ses('c', 'waiting', 'C')])).toBe('Čekaju te: A, B i C.')
  })
})

describe('browser voice', () => {
  it('reads plain text in the right language', async () => {
    const { plainSpeech, speechLang } = await import('./operator')
    expect(plainSpeech('## Stanje\n- **overmind** [PR](http://x)\n```\ncode\n```')).toBe('Stanje overmind PR')
    expect(speechLang('Dvije sesije te čekaju.')).toBe('hr-HR')
    expect(speechLang('Two sessions are waiting.')).toBe('en-US')
  })
})

describe('session lists', () => {
  it('leave the voice operators out', async () => {
    const { allSessions, findSession } = await import('./sessions')
    const overmind = { self: 'a', hosts: [{ name: 'a', ok: true, sessions: [ses('x', 'idle'), { ...ses('op', 'idle'), operator: true }] }] }
    expect(allSessions(overmind as never).map((s) => s.session_id)).toEqual(['x'])
    expect(findSession(overmind as never, 'a', 'op')?.session_id).toBe('op')
  })
})

describe('reading speed', () => {
  it('cycles and parses', async () => {
    const { nextRate, parseRate } = await import('./operator')
    expect([1, 1.25, 1.5, 2].map(nextRate)).toEqual([1.25, 1.5, 2, 1])
    expect(parseRate('1.5')).toBe(1.5)
    expect(parseRate('3')).toBeUndefined()
  })
})
