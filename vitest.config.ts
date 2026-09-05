import { defineConfig } from 'vitest/config'

// Standalone from vite.config.ts: the app config is an async Tauri-tuned config
// (fixed dev port, strictPort) that we don't want the test runner to inherit.
// Tests cover the pure logic extracted into src/renderer/lib (and the exported
// theme helpers) — no Tauri/IPC, no real DOM rendering. jsdom is here only so the
// few browser globals some helpers touch (localStorage, atob, TextDecoder) exist.
//
// `setupFiles` repairs one of those globals on Node 26+, which ships an inert
// `localStorage` that shadows jsdom's — see src/test-setup.ts for the whole story.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
  },
})
