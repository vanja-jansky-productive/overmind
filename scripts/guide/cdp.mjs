// Minimal Chrome DevTools Protocol driver (headless Chrome, Node's built-in WebSocket) for the
// feature-guide screenshots. No puppeteer: launch, emulate a device, navigate, click, type, shoot.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const BASE = process.env.GUIDE_BASE || 'http://127.0.0.1:7799/'
const SP = process.env.GUIDE_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-guide-'))
export const OUT = process.env.GUIDE_SHOTS || path.join(SP, 'shots')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch(port = 9333) {
  const prof = fs.mkdtempSync(path.join(SP, 'prof-'))
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--lang=en-US', 'about:blank'], { stdio: 'ignore' })
  let ver
  for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break } catch { await sleep(200) } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0; const pend = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  const close = () => { try { ws.close() } catch {} proc.kill(); try { fs.rmSync(prof, { recursive: true, force: true }) } catch {} }
  return page(send, close)
}

function page(send, close) {
  const P = {
    send, close, sleep,
    async setup({ w, h, mobile = false, dark = false, scale = 2 }) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile })
      await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'pointer', value: mobile ? 'coarse' : 'fine' }, { name: 'hover', value: mobile ? 'none' : 'hover' }] })
      if (mobile) await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' })
      await send('Page.enable'); await send('Runtime.enable')
    },
    async go(url, ls = {}) {
      await send('Page.navigate', { url: BASE + 'favicon.svg' }); await sleep(300)
      await P.eval(`localStorage.clear(); ${Object.entries(ls).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`).join('')}`)
      await send('Page.navigate', { url }); await sleep(2200)
    },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed'); return r.result.value },
    async hash(h, ms = 1500) { await P.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(ms) },
    /** Click the innermost visible element whose text (or aria-label/title) matches. */
    async click(text, { sel = 'button,a,[role=button],[role=tab],[role=option],[role=menuitem],[role=radio],[role=checkbox],label,div,span,li', nth = 0, ms = 700 } = {}) {
      const ok = await P.eval(`(() => { const t = ${JSON.stringify(text)}; const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => { const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = (e.getAttribute('aria-label')||'') + '|' + (e.getAttribute('title')||'') + '|' + (e.innerText||'').trim(); return t.startsWith('=') ? ((e.innerText||'').trim() === t.slice(1) || e.getAttribute('aria-label') === t.slice(1) || e.getAttribute('title') === t.slice(1)) : s.includes(t) });
        const inner = els.filter(e => !els.some(o => o !== e && e.contains(o))); const el = inner[${nth}]; if (!el) return false; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2] })()`)
      if (!ok) throw new Error(`click: not found: ${text}`)
      await P.mouse(ok[0], ok[1]); await sleep(ms)
    },
    async mouse(x, y) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    },
    async swipe(x1, y1, x2, y2, ms = 700) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] })
      for (let i = 1; i <= 10; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2 - x1) * i / 10, y: y1 + (y2 - y1) * i / 10 }] }); await sleep(16) }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(ms)
    },
    async tap(x, y, ms = 700) { await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(ms) },
    async hover(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) },
    /** key('k', {meta:true}) */
    async key(key, { meta = false, shift = false, alt = false, ctrl = false, ms = 600 } = {}) {
      const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)
      const named = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8, Tab: 9 }
      const code = named[key] ?? key.toUpperCase().charCodeAt(0)
      const k = named[key] ? key : key
      const codeName = named[key] ? key : /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key === '/' ? 'Slash' : key === '\\' ? 'Backslash' : key === '?' ? 'Slash' : ''
      const text = !named[key] && !meta && !ctrl ? key : undefined
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: codeName, windowsVirtualKeyCode: code, modifiers, text })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: codeName, windowsVirtualKeyCode: code, modifiers })
      await sleep(ms)
    },
    async type(text, ms = 400) { await send('Input.insertText', { text }); await sleep(ms) },
    async shot(name, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); console.log('shot', name)
    },
  }
  return P
}
