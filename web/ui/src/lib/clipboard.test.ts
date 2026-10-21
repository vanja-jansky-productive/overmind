import { describe, expect, test } from 'vitest'

import { attachCommand, canAttachInApp, sessionAttachCommand, sessionAttachLink, shellQuote } from './clipboard'

describe('shellQuote', () => {
  test('safe words stay plain', () => {
    expect(shellQuote('update-school-schedule')).toBe('update-school-schedule')
    expect(shellQuote('api_v2.1')).toBe('api_v2.1')
  })
  test('anything else is single-quoted, quotes escaped', () => {
    expect(shellQuote('my session')).toBe("'my session'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$HOME;rm')).toBe("'$HOME;rm'")
    expect(shellQuote('')).toBe("''")
  })
})

describe('attachCommand', () => {
  test('host and session name', () => {
    expect(attachCommand('workstation', 'overmind-web')).toBe('overmind -H workstation enter overmind-web')
    expect(attachCommand('laptop', 'a b')).toBe("overmind -H laptop enter 'a b'")
  })
  test('a name that looks like a flag goes after --', () => {
    expect(attachCommand('laptop', '-x')).toBe('overmind -H laptop enter -- -x')
  })
})

describe('sessionAttachCommand', () => {
  test('tmux-backed sessions only', () => {
    expect(sessionAttachCommand({ host: 'workstation', backend: 'tmux', tmux_session: 'api' })).toBe('overmind -H workstation enter api')
    expect(sessionAttachCommand({ host: 'laptop', backend: 'iterm', tmux_session: null })).toBeNull()
    expect(sessionAttachCommand({ host: 'laptop', backend: 'tmux', tmux_session: '' })).toBeNull()
    expect(sessionAttachCommand(null)).toBeNull()
  })
})

describe('sessionAttachLink', () => {
  test('encodes host and tmux session for tmux sessions only', () => {
    expect(sessionAttachLink({ host: 'workstation', backend: 'tmux', tmux_session: 'a b&c' })).toBe('overmind://attach?host=workstation&session=a+b%26c')
    expect(sessionAttachLink({ host: 'laptop', backend: 'iterm', tmux_session: null })).toBeNull()
    expect(sessionAttachLink(null)).toBeNull()
  })
})

describe('canAttachInApp', () => {
  test('reads data-attach', () => {
    expect(canAttachInApp({ documentElement: { dataset: { shell: 'desktop', attach: 'iterm' } } })).toBe(true)
    expect(canAttachInApp({ documentElement: { dataset: { shell: 'desktop' } } })).toBe(false)
    expect(canAttachInApp(undefined)).toBe(false)
  })
})
