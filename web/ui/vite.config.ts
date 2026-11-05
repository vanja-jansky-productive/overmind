import path from 'node:path'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: `npm run dev` proxies /api to a running overmind web server
// (OVERMIND_WEB_URL, default http://127.0.0.1:7878).
const target = process.env.OVERMIND_WEB_URL || 'http://127.0.0.1:7878'

// React Compiler (#39): auto-memoizes components and hooks. `REACT_COMPILER_REPORT=1 npm run build`
// prints one line per function it compiled, skipped or bailed out of (and why).
const report = process.env.REACT_COMPILER_REPORT === '1'
const logger = report
  ? {
      logEvent(file: string | null, e: { kind: string; fnName?: string | null; detail?: unknown; reason?: string }) {
        const rel = file ? path.relative(import.meta.dirname, file) : '?'
        const why = e.kind === 'CompileSuccess' ? '' : ` ${e.reason ?? JSON.stringify(e.detail ?? '')}`
        console.log(`[react-compiler] ${e.kind} ${rel} ${e.fnName ?? ''}${why}`.slice(0, 400))
      },
    }
  : undefined

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset({ logger })] }), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    proxy: { '/api': { target, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
