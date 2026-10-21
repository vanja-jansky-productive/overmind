import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: `npm run dev` proxies /api to a running overmind web server
// (OVERMIND_WEB_URL, default http://127.0.0.1:7878).
const target = process.env.OVERMIND_WEB_URL || 'http://127.0.0.1:7878'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    proxy: { '/api': { target, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
