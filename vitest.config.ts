import { defineConfig } from 'vitest/config'

// Standalone from vite.config.ts: the app config is an async Tauri-tuned config
// (fixed dev port, strictPort) that we don't want the test runner to inherit.
// Tests cover the pure logic extracted into src/renderer/lib (and the exported
// theme helpers) — no Tauri/IPC, no real DOM rendering. jsdom is here only so the
// few browser globals some helpers touch (localStorage, atob, TextDecoder) exist.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
