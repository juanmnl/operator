import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

// Spike-local config — the root `vite.config.ts` is NOT touched (and is Tauri's, pointed at
// Tauri's dev port). Two entries: the real App, and the measurement bench.
//
// `server.fs.allow` is the only unusual line: the entries live under `electron/` but
// import `src/renderer/*` and `dev/mock-bridge.ts` from above it, which Vite refuses to serve
// by default. Allowing the repo root — not `/` — is the narrow version of that.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Electron loads the built renderer from disk with `file://`, where absolute asset paths
  // resolve against the filesystem root and every chunk 404s.
  base: './',
  server: {
    port: Number(process.env.OPERATOR_ELECTRON_PORT) || 1450,
    strictPort: true,
    fs: { allow: [repoRoot] },
    watch: {
      // `out/`, `dist/` and `measurements/` sit INSIDE the Vite root, so by default the dev
      // server watches them — and packaging (or a bench writing a PNG every 15 minutes) then
      // triggers a full page reload. That is not cosmetic: a reload remounts every terminal
      // and hands xterm a fresh WebGL context, which is precisely the state a long atlas-
      // corruption test must never be silently returned to. Cost one M1 run before it was
      // caught, hence the size of this comment.
      ignored: ['**/out/**', '**/dist/**', '**/measurements/**'],
    },
  },
  build: {
    outDir: resolve(here, 'out', 'renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        bench: resolve(here, 'bench.html'),
      },
    },
  },
})
