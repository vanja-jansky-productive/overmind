import type { ScreenFrame } from '@/api/types'

// oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI_RE =/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * One frame of the pane as a write for xterm.js: every row repainted in place (no clear, so no
 * flicker), the app's input modes mirrored — application cursor keys, mouse tracking + SGR — so
 * xterm encodes arrows, clicks and the wheel the way the app expects, then the cursor put back.
 * Mouse tracking is mirrored as clicks only (1000), whatever the app asked for: motion reports
 * would be a request per mouse move.
 */
export function frameToAnsi(f: ScreenFrame): string {
  let out = '\x1b[?25l'
  out += f.appCursor ? '\x1b[?1h' : '\x1b[?1l'
  // Pastes arrive bracketed, so a multi-line paste is not submitted at its first newline.
  out += '\x1b[?2004h'
  out += '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'
  if (f.mouse.tracking !== 'none') {
    out += '\x1b[?1000h'
    if (f.mouse.sgr) out += '\x1b[?1006h'
  }
  f.lines.forEach((line, i) => {
    // Erase first: an erase after a full-width row would hit its last cell (pending wrap).
    out += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${line}\x1b[0m`
  })
  out += `\x1b[${f.cursor.y + 1};${f.cursor.x + 1}H`
  if (f.cursor.visible) out += '\x1b[?25h'
  return out
}

export interface MenuOption {
  n: number
  label: string
}

export interface Menu {
  options: MenuOption[]
  /** 0-based index of the highlighted option (❯ / ›), null when none is marked. */
  current: number | null
}

const OPTION_RE = /^[\s│┃|]*([❯›>▶➤●]\s*)?(\d{1,2})[.)]\s+(\S.*?)[\s│┃|]*$/

/**
 * The numbered option menu the agent shows at the bottom of its screen — Claude Code's
 * permission and question prompts (`❯ 1. Yes`), Codex's approvals (`› 1. Yes, proceed`) — or
 * null. Options must count up from 1; wrapped description lines may sit between them.
 */
export function parseMenu(lines: string[]): Menu | null {
  const plain = lines.map(stripAnsi)
  let best: Menu | null = null
  let run: { options: MenuOption[]; current: number | null; last: number } | null = null
  plain.forEach((line, i) => {
    const m = OPTION_RE.exec(line)
    if (!m) return
    const n = Number(m[2])
    const option = { n, label: m[3] }
    if (run && n === run.options.length + 1 && i - run.last <= 4) {
      if (m[1]) run.current = run.options.length
      run.options.push(option)
      run.last = i
    } else if (n === 1) {
      run = { options: [option], current: m[1] ? 0 : null, last: i }
    } else {
      return
    }
    if (run.options.length >= 2) best = { options: [...run.options], current: run.current }
  })
  return best
}

/**
 * The input that picks option `index` from `menu`: arrow presses from the highlighted option,
 * then Enter — each a separate write, so the TUI reads them as keys and not as a paste. With no
 * highlighted option, the option's number (Claude Code and Codex both select by digit).
 */
export function menuInput(menu: Menu, index: number, appCursor: boolean): string[] {
  if (menu.current == null) return [String(menu.options[index].n)]
  const delta = index - menu.current
  const arrow = delta > 0 ? (appCursor ? '\x1bOB' : '\x1b[B') : appCursor ? '\x1bOA' : '\x1b[A'
  return [...Array<string>(Math.abs(delta)).fill(arrow), '\r']
}

/** Same menu (labels and highlight) — the screen still shows what the user clicked on. */
export function sameMenu(a: Menu | null, b: Menu | null): boolean {
  if (!a || !b || a.current !== b.current || a.options.length !== b.options.length) return false
  return a.options.every((o, i) => o.label === b.options[i].label)
}
