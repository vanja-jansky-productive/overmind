// File paths in chat messages: which tokens look like a path (so the UI asks the server
// whether they exist and links only those), their `:line[:col]` suffix, and the small
// POSIX path helpers the preview needs (links relative to the previewed file). Pure.

import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'

export interface PathRef {
  path: string
  line?: number
  col?: number
}

// What a path token may contain: letters, digits and `_ . ~ / @ + - %`, plus a trailing
// `:12`, `:12:3` or `#L12(-L20)`. No spaces, quotes, brackets, `\`, `*`, `$`, `=`, `,` …
const PATH_CHARS = /^[\p{L}\p{N}_.~/@+%-]+$/u
const POS_SUFFIX = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:-L?\d+)?)$/
const EXT = /\.([A-Za-z][A-Za-z0-9_+-]{0,9}|[0-9][A-Za-z][A-Za-z0-9]{0,8})$/
const DOMAIN = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co|sh|me|gov|edu|so|xyz|info)(?:\/|$)/i
const LEADING = /^[([{<"'“‘«@]+/
const TRAILING = /[.,;:!?)\]}>"'”’»…]+$/

/** Split a `:line[:col]` / `#L12` suffix off. → { path, line?, col? } */
export function parsePathRef(raw: string): PathRef {
  const s = String(raw ?? '').trim()
  const m = POS_SUFFIX.exec(s)
  if (!m || m.index === 0) return { path: s }
  const line = Number(m[1] ?? m[3])
  const col = m[2] !== undefined ? Number(m[2]) : undefined
  return { path: s.slice(0, m.index), ...(line ? { line } : {}), ...(col ? { col } : {}) }
}

/**
 * Does `token` (already trimmed of surrounding punctuation) look like a file path worth
 * asking the server about? Needs a `/` or a file extension; URLs, domains, flags, Windows
 * paths, `//comments`, versions / numbers and `e.g.` are out.
 */
export function isPathLike(token: string): boolean {
  const t = String(token ?? '')
  if (t.length < 3 || t.length > 1024) return false
  if (t.includes('://') || /^[a-z][a-z0-9+.-]*:[^0-9]/i.test(t)) return false // scheme:… (not a :12 suffix)
  if (/^[A-Za-z]:[\\/]/.test(t) || t.includes('\\')) return false
  const { path } = parsePathRef(t)
  if (!PATH_CHARS.test(path)) return false
  if (path.startsWith('-') || path.startsWith('//') || path.includes('//')) return false
  if (/^[~./]+$/.test(path)) return false // `~`, `./`, `..`, `/`
  if (DOMAIN.test(path)) return false
  const base = path.split('/').filter(Boolean).pop() ?? ''
  if (path.includes('/')) {
    // `and/or`, `yes/no`: plain words on both sides are fine (the server will just say no),
    // but a bare `1/2` or `/` noise is not.
    return /[\p{L}_]/u.test(path)
  }
  // No slash: a dotfile (`.gitignore`), or a real extension with a name before it that is
  // not a version or a number.
  if (/^\.[\p{L}][\p{L}\p{N}_.-]*$/u.test(base)) return true
  if (!EXT.test(base)) return false
  const stem = base.replace(EXT, '')
  if (!stem || /^[\d.]+$/.test(stem) || /^v?\d+(\.\d+)*$/i.test(base)) return false
  if (/^(?:e\.g|i\.e|etc|vs|a\.m|p\.m)\.?$/i.test(base)) return false
  return true
}

export interface PathToken {
  /** Offsets into the text of the trimmed token. */
  start: number
  end: number
  /** The token as written, `:line` included. */
  raw: string
}

/** Path-looking tokens in plain text (whitespace-separated, surrounding punctuation trimmed). */
export function pathTokens(text: string): PathToken[] {
  const s = String(text ?? '')
  const out: PathToken[] = []
  for (const m of s.matchAll(/\S+/g)) {
    let tok = m[0]
    let start = m.index ?? 0
    const lead = LEADING.exec(tok)?.[0].length ?? 0
    tok = tok.slice(lead)
    start += lead
    // Trailing punctuation goes; a `:12` suffix ends in a digit, so it stays (`a.md:12.` → `a.md:12`).
    tok = tok.replace(TRAILING, '')
    if (!tok || !isPathLike(tok)) continue
    out.push({ start, end: start + tok.length, raw: tok })
  }
  return out
}

/** Text split into plain runs and the tokens `isLink(raw)` accepts. */
export function splitPaths(text: string, isLink: (raw: string) => boolean): ({ t: 'text'; v: string } | { t: 'path'; v: string })[] {
  const s = String(text ?? '')
  const out: ({ t: 'text'; v: string } | { t: 'path'; v: string })[] = []
  let last = 0
  for (const tok of pathTokens(s)) {
    if (!isLink(tok.raw)) continue
    if (tok.start > last) out.push({ t: 'text', v: s.slice(last, tok.start) })
    out.push({ t: 'path', v: tok.raw })
    last = tok.end
  }
  if (last < s.length || out.length === 0) out.push({ t: 'text', v: s.slice(last) })
  return out
}

/** Path candidates in plain text (user prompts, the terminal), in order, unique. */
export function textPathCandidates(text: string): string[] {
  return [...new Set(pathTokens(text).map((t) => t.raw))]
}

function collectInline(nodes: Inline[], out: Set<string>) {
  for (const n of nodes) {
    if (n.t === 'code') {
      const v = n.v.trim()
      if (isPathLike(v)) out.add(v)
    } else if (n.t === 'text') for (const tok of pathTokens(n.v)) out.add(tok.raw)
    else if (n.t === 'file') out.add(n.href)
    else if (n.t === 'strong' || n.t === 'em' || n.t === 'link') collectInline(n.children, out)
  }
}

function collectBlock(b: Block, out: Set<string>) {
  switch (b.t) {
    case 'p':
    case 'quote':
      for (const l of b.lines) collectInline(l, out)
      break
    case 'h':
      collectInline(b.content, out)
      break
    case 'list':
      for (const it of b.items) {
        collectInline(it.content, out)
        for (const sub of it.sub?.items ?? []) collectInline(sub, out)
      }
      break
    case 'table':
      for (const c of b.head) collectInline(c, out)
      for (const r of b.rows) for (const c of r) collectInline(c, out)
      break
    // fenced code: left alone
  }
}

const candidateCache = new Map<string, string[]>()

/** Every path candidate in a markdown message (code spans, text, `[t](rel)` links), in order, unique. Cached per text. */
export function pathCandidates(markdown: string): string[] {
  const key = String(markdown ?? '')
  const hit = candidateCache.get(key)
  if (hit) return hit
  const out = new Set<string>()
  for (const b of parseMarkdown(key, { files: true })) collectBlock(b, out)
  const list = [...out]
  if (candidateCache.size > 500) candidateCache.clear()
  candidateCache.set(key, list)
  return list
}

// --- POSIX path helpers ------------------------------------------------------------

/** Normalize `.` / `..` / duplicate slashes; keeps a leading `/` or `~`. */
export function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..' && parts[parts.length - 1] !== '~') parts.pop()
      else if (!abs) parts.push('..')
    } else parts.push(seg)
  }
  const joined = parts.join('/')
  return abs ? `/${joined}` : joined || '.'
}

export function dirname(p: string): string {
  const s = p.replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  if (i < 0) return '.'
  return i === 0 ? '/' : s.slice(0, i)
}

export function basename(p: string): string {
  const s = p.replace(/\/+$/, '')
  return s.slice(s.lastIndexOf('/') + 1)
}

/**
 * A link target inside a previewed file → the path to ask for: absolute and `~/` stay,
 * anything else is relative to `fromFile`'s directory. `#anchor` / `?query` are dropped;
 * `%20` is decoded. → { path, line? } or null for an empty target.
 */
export function resolveFrom(fromFile: string, href: string): PathRef | null {
  let h = String(href ?? '').trim().replace(/[?#](?!L\d).*$/, '')
  try {
    h = decodeURIComponent(h)
  } catch {
    // keep as written
  }
  if (!h) return null
  const ref = parsePathRef(h)
  const p = ref.path.startsWith('/') || ref.path.startsWith('~') ? ref.path : `${dirname(fromFile)}/${ref.path}`
  return { ...ref, path: normalizePath(p) }
}
