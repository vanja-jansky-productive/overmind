import { describe, expect, test } from 'vitest'

import { basename, dirname, isPathLike, normalizePath, parsePathRef, pathCandidates, pathTokens, resolveFrom, splitPaths } from './paths'

describe('parsePathRef', () => {
  test('line / col / #L suffixes', () => {
    expect(parsePathRef('a/b.md:12')).toEqual({ path: 'a/b.md', line: 12 })
    expect(parsePathRef('a/b.md:12:3')).toEqual({ path: 'a/b.md', line: 12, col: 3 })
    expect(parsePathRef('src/x.ts#L40-L52')).toEqual({ path: 'src/x.ts', line: 40 })
    expect(parsePathRef('README.md')).toEqual({ path: 'README.md' })
    expect(parsePathRef(':12')).toEqual({ path: ':12' })
  })
})

describe('isPathLike', () => {
  test.each([
    'knowledge/school/1c.md',
    'README.md',
    'src/lib/paths.ts:12',
    'src/lib/paths.ts:12:4',
    '~/notes/todo.md',
    '/abs/path/file.txt',
    './scripts/run.sh',
    '../other/a.json',
    'Makefile/x',
    '.gitignore',
    '.env.example',
    'web/ui/src',
    'package-lock.json',
    'docker-compose.yml',
    'file.d.ts',
    'img@2x.png',
  ])('yes: %s', (s) => expect(isPathLike(s)).toBe(true))

  test.each([
    'https://example.com/a.md',
    'http://x',
    'github.com/org/repo',
    'www.example.org/x.md',
    'example.com',
    'mailto:me',
    'C:\\Users\\x\\a.md',
    'C:/Users/x/a.md',
    'dir\\file.txt',
    '--flag',
    '-rf',
    '//comment',
    'a//b',
    '/',
    './',
    '..',
    '~',
    '1/2',
    '3.14',
    'v1.2.3',
    '1.2.3',
    'e.g.',
    'i.e',
    'etc.',
    'word',
    'foo(bar).md',
    'a=b/c',
    '$HOME/x.md',
    '*.md',
    'a,b.md',
    'x',
    'ab',
  ])('no: %s', (s) => expect(isPathLike(s)).toBe(false))
})

describe('pathTokens', () => {
  const raws = (s: string) => pathTokens(s).map((t) => t.raw)
  test('sentences with punctuation', () => {
    expect(raws('Updated knowledge/school/1c.md.')).toEqual(['knowledge/school/1c.md'])
    expect(raws('See docs/a.md, docs/b.md; and (src/c.ts).')).toEqual(['docs/a.md', 'docs/b.md', 'src/c.ts'])
    expect(raws('Changed "web/x.mjs" and ‘y/z.md’!')).toEqual(['web/x.mjs', 'y/z.md'])
    expect(raws('Look at a/b.md:12.')).toEqual(['a/b.md:12'])
    expect(raws('Look at a/b.md:12:5, then c.ts:9)')).toEqual(['a/b.md:12:5', 'c.ts:9'])
    expect(raws('ends with a colon: a/b.md:')).toEqual(['a/b.md'])
    expect(raws('[a/b.md]')).toEqual(['a/b.md'])
  })
  test('offsets point at the trimmed token', () => {
    const s = 'x (docs/a.md).'
    const [t] = pathTokens(s)
    expect(s.slice(t.start, t.end)).toBe('docs/a.md')
  })
  test('URLs and noise excluded', () => {
    expect(raws('open https://x.dev/a/b.md or C:\\x\\y.md now, e.g. 1.2.3 and v2.0')).toEqual([])
    expect(raws('run npm --prefix web/ui test')).toEqual(['web/ui'])
  })
})

describe('splitPaths', () => {
  test('only accepted tokens become paths', () => {
    const known = new Set(['docs/a.md', 'b.ts:3'])
    expect(splitPaths('see docs/a.md and nope/x.md, b.ts:3.', (r) => known.has(r))).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'path', v: 'docs/a.md' },
      { t: 'text', v: ' and nope/x.md, ' },
      { t: 'path', v: 'b.ts:3' },
      { t: 'text', v: '.' },
    ])
    expect(splitPaths('plain', () => true)).toEqual([{ t: 'text', v: 'plain' }])
    expect(splitPaths('', () => true)).toEqual([{ t: 'text', v: '' }])
  })
})

describe('pathCandidates', () => {
  test('code spans, text, relative links; not fenced code, not URLs, not commands', () => {
    const md = [
      'Updated `knowledge/school/1c.md` and web/lib/files.mjs:40.',
      '',
      '- **bold** src/App.tsx',
      '- see [the doc](docs/guide.md) and [site](https://x.dev/a.md)',
      '',
      '```',
      'cat hidden/in/fence.md',
      '```',
      '',
      'Run `npm run build` then `overmind web serve` · `README.md:3`',
    ].join('\n')
    expect(pathCandidates(md)).toEqual(['knowledge/school/1c.md', 'web/lib/files.mjs:40', 'src/App.tsx', 'docs/guide.md', 'README.md:3'])
  })
  test('cached per text (same array back)', () => {
    expect(pathCandidates('a/b.md')).toBe(pathCandidates('a/b.md'))
  })
})

describe('posix helpers', () => {
  test('normalizePath', () => {
    expect(normalizePath('/a/b/../c/./d.md')).toBe('/a/c/d.md')
    expect(normalizePath('/../x')).toBe('/x')
    expect(normalizePath('a//b/')).toBe('a/b')
    expect(normalizePath('~/a/../b.md')).toBe('~/b.md')
    expect(normalizePath('../x')).toBe('../x')
  })
  test('dirname / basename', () => {
    expect(dirname('/a/b/c.md')).toBe('/a/b')
    expect(dirname('/c.md')).toBe('/')
    expect(dirname('c.md')).toBe('.')
    expect(basename('/a/b/c.md')).toBe('c.md')
    expect(basename('c.md')).toBe('c.md')
  })
  test('resolveFrom: relative to the file, anchors dropped, #L kept, abs / ~ kept', () => {
    expect(resolveFrom('/h/p/docs/a.md', 'b.md')).toEqual({ path: '/h/p/docs/b.md' })
    expect(resolveFrom('/h/p/docs/a.md', '../README.md#setup')).toEqual({ path: '/h/p/README.md' })
    expect(resolveFrom('/h/p/docs/a.md', './img/My%20Shot.png')).toEqual({ path: '/h/p/docs/img/My Shot.png' })
    expect(resolveFrom('/h/p/a.md', 'src/x.ts#L12')).toEqual({ path: '/h/p/src/x.ts', line: 12 })
    expect(resolveFrom('/h/p/a.md', '/etc/hosts')).toEqual({ path: '/etc/hosts' })
    expect(resolveFrom('/h/p/a.md', '~/n.md')).toEqual({ path: '~/n.md' })
    expect(resolveFrom('/h/p/a.md', '#top')).toBeNull()
  })
})
