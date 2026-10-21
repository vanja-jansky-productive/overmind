#!/usr/bin/env node
// Generate overmind's icons: an original take on StarCraft's Overmind — a pulsing brain mass on
// creep, folds lit from above, one glowing slit eye, bone spines along its crown — as SVG, then
// rendered to PNG with a headless Chrome / Chromium (no npm deps).
//
//   node scripts/icon/generate.mjs              # write every icon below
//   CHROME=/path/to/chrome node scripts/icon/generate.mjs
//
// Writes
//   crates/overmind-desktop/icons/icon.svg, icon.png      macOS grid: 824 px rounded square, 100 px margin, 1024²
//   web/ui/public/icon.svg, favicon.svg                   512², full bleed / rounded
//   web/ui/public/icon-512.png, icon-192.png, apple-touch-icon.png
//
// The art is drawn in a 512×512 box and deterministic (seeded noise), so a re-run is byte-stable.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const f = (n) => Number(n.toFixed(1));

// ------------------------------------------------------------------ geometry helpers

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A closed smooth path through points (Catmull-Rom → cubic Bézier). */
function smoothClosed(pts) {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d} Z`;
}

/** An open smooth path through points. */
function smoothOpen(pts) {
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** A tapered limb along a quadratic curve a → b (control c): width w0 at the root, a point at the tip. */
function tendril(a, c, b, w0) {
  const left = [];
  const right = [];
  const steps = 14;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t ** 2 * b[0];
    const y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t ** 2 * b[1];
    const dx = 2 * (1 - t) * (c[0] - a[0]) + 2 * t * (b[0] - c[0]);
    const dy = 2 * (1 - t) * (c[1] - a[1]) + 2 * t * (b[1] - c[1]);
    const len = Math.hypot(dx, dy) || 1;
    const w = (w0 / 2) * (1 - t) ** 1.3;
    left.push([x - (dy / len) * w, y + (dx / len) * w]);
    right.push([x + (dy / len) * w, y - (dx / len) * w]);
  }
  return `${smoothOpen([...left, ...right.reverse()])} Z`;
}

// ------------------------------------------------------------------ the art (512 × 512)

const CX = 256;
const CY = 232;
const RX = 176;
const RY = 148;

function blobOutline() {
  const pts = [];
  for (let i = 0; i < 48; i += 1) {
    const th = (i / 48) * Math.PI * 2;
    const wob = 1 + 0.045 * Math.sin(5 * th + 1.1) + 0.03 * Math.sin(9 * th + 2.3) + 0.018 * Math.sin(14 * th + 0.4);
    let y = CY + Math.sin(th) * RY * wob;
    if (y > CY + RY * 0.72) y = CY + RY * 0.72 + (y - CY - RY * 0.72) * 0.45; // it sits on the creep
    pts.push([CX + Math.cos(th) * RX * wob, y]);
  }
  return smoothClosed(pts);
}

/** Inside the mass (a little margin from its rim), and clear of the eye. */
function onBrain(x, y) {
  const e = ((x - CX) / (RX * 0.95)) ** 2 + ((y - CY) / (RY * 0.92)) ** 2;
  const nearEye = ((x - 256) / 104) ** 2 + ((y - 262) / 60) ** 2 < 1;
  return e < 1 && !nearEye && y < CY + RY * 0.7;
}

/**
 * The folds: meandering ridges (a random walk whose heading drifts), each half of the brain on
 * its own side of a central fissure — grooves drawn dark, a lit edge above each.
 */
function folds(rand) {
  const out = [];
  // Seeds on a jittered grid, so the coils cover the mass evenly.
  for (let gy = CY - RY; gy < CY + RY * 0.7; gy += 25) {
    for (let gx = CX - RX; gx < CX + RX; gx += 27) {
      let x = gx + rand() * 14;
      let y = gy + rand() * 12;
      if (!onBrain(x, y)) continue;
      const side = Math.sign(x - CX) || 1;
      let heading = rand() * Math.PI * 2;
      let turn = (rand() - 0.5) * 0.7;
      const pts = [[x, y]];
      const steps = 6 + Math.floor(rand() * 6);
      for (let i = 0; i < steps; i += 1) {
        turn += (rand() - 0.5) * 0.5;
        heading += turn;
        const nx = x + Math.cos(heading) * 12;
        const ny = y + Math.sin(heading) * 10;
        if (!onBrain(nx, ny) || Math.sign(nx - CX) !== side || Math.abs(nx - CX) < 12) break;
        x = nx;
        y = ny;
        pts.push([x, y]);
      }
      if (pts.length >= 3) out.push(smoothOpen(pts));
    }
  }
  return out;
}

/** The fissure between the two halves, from the crown down to the eye. */
function fissure() {
  const pts = [];
  for (let y = CY - RY - 6; y <= 206; y += 14) pts.push([CX + Math.sin(y * 0.09) * 5, y]);
  return smoothOpen(pts);
}

function art() {
  const rand = rng(0x0e1e7);
  const blob = blobOutline();
  const foldPaths = folds(rand);

  // Tendrils from under the mass, spreading over the creep.
  const tendrils = [
    [[150, 330], [70, 360], [10, 470], 46],
    [[200, 350], [150, 420], [120, 530], 40],
    [[256, 360], [262, 440], [240, 540], 44],
    [[312, 350], [360, 420], [390, 530], 40],
    [[362, 330], [442, 360], [505, 470], 46],
    [[110, 280], [30, 300], [-20, 360], 34],
    [[402, 280], [482, 300], [530, 360], 34],
  ]
    .map(([a, c, b, w]) => `<path d="${tendril(a, c, b, w)}" fill="url(#limb)"/>`)
    .join('\n    ');

  // Bone spines along the crown.
  const spines = [
    [-0.78, -0.6, 66],
    [-0.5, -1.0, 78],
    [-0.2, -1.25, 70],
    [0.2, -1.25, 70],
    [0.5, -1.0, 78],
    [0.78, -0.6, 66],
  ]
    .map(([u, lean, len]) => {
      const bx = CX + u * RX * 0.92;
      const by = CY - RY * Math.sqrt(1 - u * u) * 0.93;
      const tip = [bx + u * len * 1.1, by + lean * len * 0.9];
      const ctl = [bx + u * len * 0.15, by - len * 0.8];
      return `<path d="${tendril([bx, by + 14], ctl, tip, 30)}" fill="url(#bone)" stroke="#2a1708" stroke-width="2"/>`;
    })
    .join('\n    ');

  // Glowing pustules on the mass.
  const spots = Array.from({ length: 9 }, () => {
    const th = rand() * Math.PI * 2;
    const r = 0.35 + rand() * 0.5;
    const x = CX + Math.cos(th) * RX * r;
    const y = CY + Math.sin(th) * RY * r * 0.8;
    if (Math.abs(x - CX) < 90 && Math.abs(y - 262) < 60) return ''; // keep the eye clear
    return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(3 + rand() * 4)}" fill="#ffb8f0" opacity="0.75" filter="url(#soft)"/>`;
  }).join('');

  // Creep veins radiating over the ground.
  const veins = Array.from({ length: 16 }, (_, i) => {
    const th = Math.PI * (0.05 + (i / 15) * 0.9);
    const pts = [];
    for (let s = 0; s < 6; s += 1) {
      const r = 120 + s * 50;
      pts.push([CX + Math.cos(th + Math.sin(s + i) * 0.08) * r * 1.3, 330 + Math.sin(th) * r * 0.55]);
    }
    return `<path d="${smoothOpen(pts)}" fill="none" stroke="#7d2a74" stroke-width="${f(2 + (i % 3))}" opacity="0.35"/>`;
  }).join('\n    ');

  const eye = 'M174 262 Q256 196 338 262 Q256 328 174 262 Z';
  const socket = 'M156 262 Q256 178 356 262 Q256 346 156 262 Z';
  const pupil = 'M256 214 Q272 262 256 310 Q240 262 256 214 Z';

  return {
    defs: `
    <radialGradient id="sky" cx="0.5" cy="0.62" r="0.75">
      <stop offset="0" stop-color="#4a1a57"/>
      <stop offset="0.55" stop-color="#1a0826"/>
      <stop offset="1" stop-color="#07020c"/>
    </radialGradient>
    <radialGradient id="creep" cx="0.5" cy="0.2" r="0.8">
      <stop offset="0" stop-color="#6b1f62" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#2a0927" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="flesh" cx="0.4" cy="0.28" r="0.85" fx="0.38" fy="0.22">
      <stop offset="0" stop-color="#f08fe0"/>
      <stop offset="0.3" stop-color="#bc3fa0"/>
      <stop offset="0.68" stop-color="#6a1a60"/>
      <stop offset="1" stop-color="#2a0827"/>
    </radialGradient>
    <linearGradient id="limb" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8e2a80"/>
      <stop offset="1" stop-color="#360d33"/>
    </linearGradient>
    <linearGradient id="bone" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#7a6040"/>
      <stop offset="1" stop-color="#f1e2bd"/>
    </linearGradient>
    <radialGradient id="iris" cx="0.5" cy="0.5" r="0.55">
      <stop offset="0" stop-color="#fff6b0"/>
      <stop offset="0.35" stop-color="#ffc43a"/>
      <stop offset="0.75" stop-color="#ef6a1c"/>
      <stop offset="1" stop-color="#8f1d0a"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffb02e" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#ff5a1a" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="blur6" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
    <radialGradient id="shade" cx="0.4" cy="0.25" r="0.9">
      <stop offset="0" stop-color="#ffd6f6" stop-opacity="0.25"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#16031a" stop-opacity="0.65"/>
    </radialGradient>
    <clipPath id="mass"><path d="${blob}"/></clipPath>`,
    body: `
    <rect width="512" height="512" fill="url(#sky)"/>
    <ellipse cx="256" cy="420" rx="300" ry="150" fill="url(#creep)"/>
    ${veins}
    ${tendrils}
    <ellipse cx="256" cy="372" rx="190" ry="34" fill="#12030f" opacity="0.6" filter="url(#blur6)"/>
    ${spines}
    <path d="${blob}" fill="url(#flesh)"/>
    <g clip-path="url(#mass)">
      ${foldPaths
        .map(
          (d) =>
            `<path d="${d}" fill="none" stroke="#2b0729" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>` +
            `<path d="${d}" fill="none" stroke="#c24ea6" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` +
            `<path d="${d}" fill="none" stroke="#f7b8ec" stroke-width="3.5" stroke-linecap="round" opacity="0.5" transform="translate(-1.5 -3)"/>`,
        )
        .join('\n      ')}
      <path d="${blob}" fill="url(#shade)"/>
      <path d="${fissure()}" fill="none" stroke="#1d0419" stroke-width="10" stroke-linecap="round"/>
      <ellipse cx="256" cy="380" rx="230" ry="120" fill="#1c0519" opacity="0.55" filter="url(#blur6)"/>
      ${spots}
    </g>
    <path d="${blob}" fill="none" stroke="#1a0418" stroke-width="6"/>
    <ellipse cx="256" cy="262" rx="130" ry="80" fill="url(#glow)" opacity="0.85"/>
    <path d="${socket}" fill="#24061f"/>
    <path d="${socket}" fill="none" stroke="#a33a91" stroke-width="7" opacity="0.8"/>
    <path d="${eye}" fill="url(#iris)"/>
    <path d="${pupil}" fill="#140207"/>
    <ellipse cx="234" cy="244" rx="13" ry="7" fill="#fff" opacity="0.75" transform="rotate(-20 234 244)"/>`,
  };
}

// ------------------------------------------------------------------ the files

function svg({ size, inner, defs = '', label = 'Overmind' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${label}">
  <!-- generated by scripts/icon/generate.mjs — edit that, not this -->
  <defs>${defs}
  </defs>
  ${inner}
</svg>
`;
}

const a = art();
const fullBleed = svg({ size: 512, defs: a.defs, inner: `<g>${a.body}\n  </g>` });
const rounded = svg({
  size: 512,
  defs: `${a.defs}\n    <clipPath id="r"><rect width="512" height="512" rx="112"/></clipPath>`,
  inner: `<g clip-path="url(#r)">${a.body}\n  </g>`,
});
// macOS icon grid: an 824 px rounded square with a 100 px margin on a 1024 canvas.
const desktop = svg({
  size: 1024,
  defs: `${a.defs}\n    <clipPath id="r"><rect width="512" height="512" rx="114"/></clipPath>`,
  inner: `<g transform="translate(100 100) scale(1.609375)" clip-path="url(#r)">${a.body}\n  </g>`,
});

const out = {
  desktopSvg: path.join(root, 'crates/overmind-desktop/icons/icon.svg'),
  desktopPng: path.join(root, 'crates/overmind-desktop/icons/icon.png'),
  webSvg: path.join(root, 'web/ui/public/icon.svg'),
  favicon: path.join(root, 'web/ui/public/favicon.svg'),
};
fs.writeFileSync(out.desktopSvg, desktop);
fs.writeFileSync(out.webSvg, fullBleed);
fs.writeFileSync(out.favicon, rounded);

// ------------------------------------------------------------------ rendering

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  // Playwright's browsers, newest first.
  const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).sort().reverse()) {
      if (d.startsWith('chromium_headless_shell-')) {
        for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-mac']) {
          candidates.push(path.join(pw, d, sub, 'chrome-headless-shell'));
        }
      }
    }
  }
  return candidates.find((c) => c && fs.existsSync(c));
}

function render(svgText, size, file) {
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome/Chromium found — set CHROME=/path/to/chrome');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overmind-icon-'));
  const page = path.join(tmp, 'icon.html');
  // An HTML page sized to the icon: the SVG is scaled to fill it exactly, the rest transparent.
  fs.writeFileSync(
    page,
    `<!doctype html><html><body style="margin:0;background:transparent">${svgText.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`,
  );
  execFileSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${file}`,
    `file://${page}`,
  ], { stdio: 'ignore' });
  fs.rmSync(tmp, { recursive: true, force: true });
}

render(desktop, 1024, out.desktopPng);
render(fullBleed, 512, path.join(root, 'web/ui/public/icon-512.png'));
render(fullBleed, 192, path.join(root, 'web/ui/public/icon-192.png'));
render(fullBleed, 180, path.join(root, 'web/ui/public/apple-touch-icon.png'));
console.log('icons written');
