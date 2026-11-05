// Interaction latency of the web UI in headless WebKit, against the frozen demo API (#39).
//
//   node scripts/perf/interaction.mjs [--dist web/ui/dist] [--runs 5] [--switches 30] [--chars 120] [--renders] [--json]
//
// Per run: a fresh WebKit at 1440×900 (DesktopShell), load a session, settle 2 s, then
//   - switch: click `--switches` sidebar rows in turn (6 demo sessions, round robin), 400 ms apart;
//   - type:   focus the composer of the open session and type `--chars` characters, 40 ms apart.
// Each input is timed in the page, INP-style: from its capture-phase listener (window, so before
// React's) to the first task after the next animation frame (≈ the frame that shows it). WebKit
// stamps Playwright's clicks with an epoch `timeStamp`, so the clock starts at the listener. `settledP50` is click → the last DOM
// mutation within 1 s (the new pane's fetches and follow-up renders included). `cpuS` is the WebKit
// CPU of each phase. Prints one line per run and the medians (of each run's p50 / p95).
//
// --renders: a separate mode that installs a React DevTools hook stub before load and counts commits
// and component renders (fibers that did work) per phase. The hook walks the tree on each commit, so
// its timings are not comparable: run it on its own.
//
// Also prints the dist's JS/CSS bytes (raw, gzip, brotli).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { webkit } from 'playwright-core'
import { BASE, ROOT, median, quantile, startMock, webkitCpu } from './lib.mjs'

// Demo sessions of scripts/guide/mock.mjs that the desktop sidebar lists as rows (host, id): change them together.
const SESSIONS = [
  ['workstation', 'a1b2c3d4-1111-4000-8000-000000000001'],
  ['workstation', 'a1b2c3d4-1111-4000-8000-000000000002'],
  ['workstation', 'a1b2c3d4-1111-4000-8000-000000000003'],
  ['workstation', 'a1b2c3d4-1111-4000-8000-000000000005'],
  ['workstation', 'a1b2c3d4-1111-4000-8000-000000000006'],
  ['laptop', 'c3d4e5f6-3333-4000-8000-000000000002'],
]
const READY = 'Root cause' // in the first session's chat
const TEXT = 'The rounding fix looks right; please also check JPY and KWD totals before you push. '

const { values: opts } = parseArgs({
  options: {
    dist: { type: 'string', default: path.join(ROOT, 'web/ui/dist') },
    runs: { type: 'string', default: '5' },
    switches: { type: 'string', default: '30' },
    chars: { type: 'string', default: '120' },
    renders: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
})

/** Installed before any page script: per-input latency and DOM-mutation clock. */
function inPage() {
  const w = /** @type {any} */ (window)
  w.__perf = { lat: [], lastMutation: 0 }
  const time = () => {
    const t0 = performance.now()
    requestAnimationFrame(() => setTimeout(() => w.__perf.lat.push(performance.now() - t0)))
  }
  addEventListener('click', time, true)
  addEventListener('keydown', time, true)
  new MutationObserver(() => (w.__perf.lastMutation = performance.now())).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
}

/** React DevTools hook stub: counts commits and components that rendered (the PerformedWork flag). */
function rendersHook() {
  const w = /** @type {any} */ (window)
  const COMPONENT = new Set([0, 1, 11, 14, 15]) // function, class, forwardRef, memo, simple memo
  w.__renders = { commits: 0, components: 0 }
  const walk = (f) => {
    for (; f; f = f.sibling) {
      if (COMPONENT.has(f.tag) && (!f.alternate || f.flags & 1)) w.__renders.components++
      // A subtree React bailed out of keeps its old child: nothing in it rendered.
      if (f.child && (!f.alternate || f.child !== f.alternate.child)) walk(f.child)
    }
  }
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) {
      this.renderers.set(1, r)
      return 1
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      w.__renders.commits++
      walk(root.current.child)
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }
}

const snap = (page) => page.evaluate(() => ({ lat: [...window.__perf.lat], renders: window.__renders ? { ...window.__renders } : null }))
const resetLat = (page) => page.evaluate(() => (window.__perf.lat = []))

async function measure() {
  const wk = webkitCpu()
  const server = await webkit.launchServer({ headless: true })
  const browser = await webkit.connect(server.wsEndpoint())
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addInitScript(inPage)
    if (opts.renders) await ctx.addInitScript(rendersHook)
    const page = await ctx.newPage()
    const [h0, id0] = SESSIONS[0]
    await page.goto(`${BASE}#/s/${h0}/${id0}`)
    await page.waitForFunction((t) => document.body?.innerText?.includes(t), READY, { timeout: 30_000, polling: 25 })
    wk.freeze()
    await page.waitForTimeout(2000)
    const out = {}

    // Switch sessions by clicking sidebar rows.
    await resetLat(page)
    const r0 = (await snap(page)).renders
    const settled = []
    let c0 = wk.cpu()
    for (let i = 1; i <= Number(opts.switches); i++) {
      const [host, id] = SESSIONS[i % SESSIONS.length]
      const row = page.locator(`a[href$="/s/${encodeURIComponent(host)}/${encodeURIComponent(id)}"]`).first()
      const t0 = await page.evaluate(() => performance.now())
      await row.click()
      await page.waitForTimeout(1000)
      settled.push(await page.evaluate((t) => Math.max(0, window.__perf.lastMutation - t), t0))
      await page.waitForTimeout(400)
    }
    const s = await snap(page)
    out.switch = { cpuS: +(wk.cpu() - c0).toFixed(2), ...stats(s.lat), settledP50: +median(settled).toFixed(1), renders: diff(s.renders, r0) }

    // Type into the composer of the open session (back on the first one).
    await page.locator(`a[href$="/s/${h0}/${id0}"]`).first().click()
    await page.waitForTimeout(1500)
    const box = page.locator('textarea[aria-label="Message"]').first()
    await box.click()
    await page.waitForTimeout(500)
    await resetLat(page)
    const r1 = (await snap(page)).renders
    c0 = wk.cpu()
    const chars = Number(opts.chars)
    await page.keyboard.type(TEXT.repeat(Math.ceil(chars / TEXT.length)).slice(0, chars), { delay: 40 })
    await page.waitForTimeout(500)
    const t = await snap(page)
    out.type = { cpuS: +(wk.cpu() - c0).toFixed(2), ...stats(t.lat), renders: diff(t.renders, r1) }
    return out
  } finally {
    await browser.close()
    await server.close()
  }
}

const stats = (lat) => ({ n: lat.length, p50: +median(lat).toFixed(1), p95: +quantile(lat, 0.95).toFixed(1), max: +Math.max(...lat).toFixed(1) })
const diff = (a, b) => (a && b ? { commits: a.commits - b.commits, components: a.components - b.components } : undefined)

function bundle(dist) {
  const dir = path.join(dist, 'assets')
  const out = {}
  for (const ext of ['js', 'css']) {
    const files = readdirSync(dir).filter((f) => f.endsWith(`.${ext}`))
    const bufs = files.map((f) => readFileSync(path.join(dir, f)))
    const sum = (fn) => bufs.reduce((a, b) => a + fn(b).length, 0)
    out[ext] = { files: files.length, raw: sum((b) => b), gzip: sum((b) => gzipSync(b, { level: 9 })), brotli: sum((b) => brotliCompressSync(b)) }
  }
  return out
}

const mock = await startMock(opts.dist)
const rs = []
try {
  for (let i = 0; i < Number(opts.runs); i++) {
    const r = await measure()
    rs.push(r)
    if (!opts.json) console.log(JSON.stringify(r))
  }
} finally {
  mock.kill()
}
const med = (phase, k) => +median(rs.map((r) => r[phase][k])).toFixed(1)
const medRenders = (phase) => (rs[0][phase].renders ? { commits: median(rs.map((r) => r[phase].renders.commits)), components: median(rs.map((r) => r[phase].renders.components)) } : undefined)
const summary = {
  dist: path.resolve(opts.dist),
  runs: rs.length,
  mode: opts.renders ? 'renders' : 'timing',
  median: Object.fromEntries(['switch', 'type'].map((p) => [p, { cpuS: med(p, 'cpuS'), p50: med(p, 'p50'), p95: med(p, 'p95'), ...(p === 'switch' ? { settledP50: med(p, 'settledP50') } : {}), renders: medRenders(p) }])),
  bundle: bundle(path.resolve(opts.dist)),
}
console.log(JSON.stringify(summary, null, opts.json ? 2 : 0))
