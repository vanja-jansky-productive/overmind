import { describe, expect, it } from 'vitest'

import type { ScreenFrame } from '@/api/types'
import { frameToAnsi, menuInput, parseMenu, sameMenu, stripAnsi } from '@/lib/term'

const frame = (over: Partial<ScreenFrame> = {}): ScreenFrame => ({
  cols: 10,
  rows: 2,
  cursor: { x: 3, y: 1, visible: true },
  altScreen: false,
  appCursor: false,
  mouse: { tracking: 'none', sgr: false, utf8: false },
  lines: ['\x1b[31mred\x1b[0m', 'ok'],
  ...over,
})

describe('frameToAnsi', () => {
  it('repaints each row in place and restores the cursor', () => {
    const out = frameToAnsi(frame())
    expect(out).toContain('\x1b[1;1H\x1b[0m\x1b[2K\x1b[31mred\x1b[0m')
    expect(out).toContain('\x1b[2;1H\x1b[0m\x1b[2Kok')
    expect(out.endsWith('\x1b[2;4H\x1b[?25h')).toBe(true)
    expect(out).not.toContain('\x1b[2J')
  })

  it('mirrors mouse tracking and application cursor keys', () => {
    const out = frameToAnsi(frame({ appCursor: true, mouse: { tracking: 'all', sgr: true, utf8: false }, cursor: { x: 0, y: 0, visible: false } }))
    expect(out).toContain('\x1b[?1h')
    expect(out).toContain('\x1b[?1000h\x1b[?1006h')
    expect(out).not.toContain('\x1b[?1003h')
    expect(out.endsWith('\x1b[?25h')).toBe(false)
  })
})

describe('parseMenu', () => {
  const claude = [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for echo commands in this project",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
  ]

  it('finds a Claude Code permission prompt and its highlight', () => {
    expect(parseMenu(claude)).toEqual({
      options: [
        { n: 1, label: 'Yes' },
        { n: 2, label: "Yes, and don't ask again for echo commands in this project" },
        { n: 3, label: 'No, and tell Claude what to do differently (esc)' },
      ],
      current: 0,
    })
  })

  it('reads a real Claude Code write prompt (file preview, wrapped option, hint line)', () => {
    const m = parseMenu([
      '⏺ Write(\x1b]8;id=l9;file:///work/hello.txt\x1b\\hello.txt\x1b]8;;\x1b\\)',
      ' Create file',
      '  1 hi',
      ' Do you want to create hello.txt?',
      ' \x1b[38;5;153m❯\x1b[39m \x1b[38;5;153m1.\x1b[39m \x1b[38;5;153mYes\x1b[39m',
      '   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this',
      '      session (shift+tab)',
      '   3. No',
      ' Esc to cancel · Tab to amend',
    ])
    expect(m?.options.map((o) => o.n)).toEqual([1, 2, 3])
    expect(m?.options[2].label).toBe('No')
    expect(m?.current).toBe(0)
  })

  it('reads through colours, box borders and wrapped descriptions', () => {
    const m = parseMenu(['│ \x1b[36m› 1. Yes, proceed (y)\x1b[0m │', '│     runs the command │', '│   2. No (esc)        │'])
    expect(m?.options.map((o) => o.label)).toEqual(['Yes, proceed (y)', 'No (esc)'])
    expect(m?.current).toBe(0)
  })

  it('ignores numbered lists that are not menus', () => {
    expect(parseMenu(['Steps:', '2. build', '3. test'])).toBeNull()
    expect(parseMenu(['1. only one'])).toBeNull()
  })

  it('takes the menu nearest the bottom', () => {
    const m = parseMenu(['1. a', '2. b', 'text', 'more', 'text', 'text', '  1. Yes', '❯ 2. No'])
    expect(m).toEqual({ options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], current: 1 })
  })
})

describe('menuInput', () => {
  const menu = { options: [{ n: 1, label: 'a' }, { n: 2, label: 'b' }, { n: 3, label: 'c' }], current: 0 }

  it('moves from the highlight then presses Enter', () => {
    expect(menuInput(menu, 2, false)).toEqual(['\x1b[B', '\x1b[B', '\r'])
    expect(menuInput({ ...menu, current: 2 }, 0, true)).toEqual(['\x1bOA', '\x1bOA', '\r'])
    expect(menuInput(menu, 0, false)).toEqual(['\r'])
  })

  it('types the number when nothing is highlighted', () => {
    expect(menuInput({ ...menu, current: null }, 1, false)).toEqual(['2'])
  })
})

it('sameMenu compares labels and highlight', () => {
  const a = parseMenu([' ❯ 1. Yes', '   2. No'])
  expect(sameMenu(a, parseMenu([' ❯ 1. Yes', '   2. No']))).toBe(true)
  expect(sameMenu(a, parseMenu(['   1. Yes', ' ❯ 2. No']))).toBe(false)
  expect(sameMenu(a, null)).toBe(false)
})

it('stripAnsi drops SGR and OSC sequences', () => {
  expect(stripAnsi('\x1b[1;31mhi\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('hi link')
})
