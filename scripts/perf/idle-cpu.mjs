// Idle CPU of the web UI in headless WebKit, against the demo API with a frozen clock.
//
//   cd scripts/perf && npm install && npx playwright-core install webkit   # once
//   node scripts/perf/idle-cpu.mjs [--dist web/ui/dist] [--runs 3] [--idle 60] [--only list|session|mobile] [--port 7798] [--json]
//
// Starts scripts/guide/mock.mjs (GUIDE_FREEZE=1: every poll answers a byte-identical body, so this
// measures the "nothing changed" idle case) on GUIDE_PORT `--port` (7798), serving `--dist`. Per run: a fresh
// WebKit, load the scenario, wait for its ready text, settle 2 s, then sit idle for `--idle` s.
// CPU = the summed CPU time of the `ms-playwright/webkit` processes this run's browser started
// (WebContent / Networking / GPU are XPC services, not children of the browser, so they are told
// apart by pid: lib.mjs webkitCpu). Another WebKit started during our launch would still be counted,
// and its load slows ours: run nothing else heavy meanwhile. Prints one line per run and the median per scenario.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { webkit } from 'playwright-core'
import { ROOT, median, startMock, webkitCpu } from './lib.mjs'

// Session ids and ready texts are the demo data of scripts/guide/mock.mjs: change them together.
const SCENARIOS = {
  // DesktopShell, no session open.
  list: { hash: '#/', ready: 'Invoice rounding fix', context: { viewport: { width: 1440, height: 900 } } },
  // DesktopShell with a session pane (chat + the details column).
  session: { hash: '#/s/workstation/a1b2c3d4-1111-4000-8000-000000000001', ready: 'Root cause', context: { viewport: { width: 1440, height: 900 } } },
  // The mobile ListScreen (< 1024 px).
  mobile: { hash: '#/', ready: 'Invoice rounding fix', context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
}

const { values: opts } = parseArgs({
  options: {
    dist: { type: 'string', default: path.join(ROOT, 'web/ui/dist') },
    runs: { type: 'string', default: '3' },
    idle: { type: 'string', default: '60' },
    only: { type: 'string', multiple: true },
    json: { type: 'boolean', default: false },
    port: { type: 'string', default: '7798' },
  },
})
const PORT = Number(opts.port)
const BASE = `http://127.0.0.1:${PORT}/`
const runs = Number(opts.runs)
const idleS = Number(opts.idle)
const names = opts.only?.length ? opts.only : Object.keys(SCENARIOS)
for (const n of names) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n} (${Object.keys(SCENARIOS).join(', ')})`)

async function measure(name) {
  const sc = SCENARIOS[name]
  const wk = webkitCpu()
  const server = await webkit.launchServer({ headless: true })
  const browser = await webkit.connect(server.wsEndpoint())
  try {
    const page = await (await browser.newContext(sc.context)).newPage()
    let requests = 0
    let chatBytes = 0 // /messages response bodies: ~0 per poll once the chat speaks cursors (#37)
    page.on('request', () => requests++)
    page.on('response', (res) => {
      if (res.url().includes('/messages')) res.body().then((b) => (chatBytes += b.length), () => {})
    })
    const c0 = wk.cpu()
    const t0 = Date.now()
    await page.goto(BASE + sc.hash)
    await page.waitForFunction((t) => document.body?.innerText?.includes(t), sc.ready, { timeout: 30_000, polling: 25 })
    const readyMs = Date.now() - t0
    const loadCpuS = wk.cpu() - c0
    wk.freeze()
    await page.waitForTimeout(2000)
    const r0 = requests
    const b0 = chatBytes
    const c1 = wk.cpu()
    await page.waitForTimeout(idleS * 1000)
    const idleCpuS = wk.cpu() - c1
    return { scenario: name, readyMs, loadCpuS: +loadCpuS.toFixed(2), idleCpuS: +idleCpuS.toFixed(2), idleCorePct: +((100 * idleCpuS) / idleS).toFixed(2), idleRequests: requests - r0, idleChatBytes: chatBytes - b0 }
  } finally {
    await browser.close()
    await server.close()
  }
}

const mock = await startMock(opts.dist, PORT)
const results = {}
try {
  for (const name of names) {
    const rs = []
    for (let i = 0; i < runs; i++) {
      const r = await measure(name)
      rs.push(r)
      if (!opts.json) console.log(JSON.stringify(r))
    }
    results[name] = {
      runs: rs.length,
      readyMs: median(rs.map((r) => r.readyMs)),
      loadCpuS: median(rs.map((r) => r.loadCpuS)),
      idleCpuS: median(rs.map((r) => r.idleCpuS)),
      idleCorePct: median(rs.map((r) => r.idleCorePct)),
      idleRequests: median(rs.map((r) => r.idleRequests)),
      idleChatBytes: median(rs.map((r) => r.idleChatBytes)),
    }
  }
} finally {
  mock.kill()
}
console.log(JSON.stringify({ dist: path.resolve(opts.dist), idleSeconds: idleS, median: results }, null, opts.json ? 2 : 0))
