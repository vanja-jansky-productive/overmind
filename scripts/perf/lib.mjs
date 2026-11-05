// Shared by idle-cpu.mjs and interaction.mjs: the frozen demo API, WebKit CPU, medians.
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '../..')
export const PORT = 7798
export const BASE = `http://127.0.0.1:${PORT}/`

/** CPU seconds of each running Playwright WebKit process, by pid. */
function webkitProcs() {
  const rows = execFileSync('ps', ['-axo', 'pid=,time=,command=']).toString().trim().split('\n')
  const secs = (t) => t.split(':').reduce((a, x) => a * 60 + Number(x), 0)
  const out = new Map()
  for (const l of rows) {
    if (!l.includes('ms-playwright/webkit')) continue
    const [pid, time] = l.trim().split(/\s+/)
    out.set(Number(pid), secs(time))
  }
  return out
}

/**
 * CPU of one browser's WebKit processes (WebContent / Networking / GPU are XPC services, not children
 * of the browser, so they are told apart by pid): call before launching, then `cpu()` sums the
 * processes started since (until `freeze()`, which pins the set once the page has loaded: a browser
 * someone else starts later is not counted). `cpu()` is 0 for a process that has exited.
 */
export function webkitCpu() {
  const before = new Set(webkitProcs().keys())
  let own = null
  return {
    cpu() {
      let sum = 0
      for (const [pid, s] of webkitProcs()) if (own ? own.has(pid) : !before.has(pid)) sum += s
      return sum
    },
    freeze() {
      own = new Set([...webkitProcs().keys()].filter((pid) => !before.has(pid)))
    },
  }
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

export const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

/** scripts/guide/mock.mjs with GUIDE_FREEZE=1 (every poll answers a byte-identical body), serving `dist`. */
export async function startMock(dist) {
  const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/guide/mock.mjs')], {
    env: { ...process.env, GUIDE_FREEZE: '1', GUIDE_PORT: String(PORT), OVERMIND_WEB_UI: path.resolve(dist) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}api/health`)).ok) return mock
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  mock.kill()
  throw new Error(`mock did not answer on :${PORT}`)
}
