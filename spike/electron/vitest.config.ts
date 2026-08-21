import { defineConfig } from 'vitest/config'

// Node environment, not jsdom: what is tested here is main-process code — git, the filesystem,
// process spawning. The renderer half of this shell has no logic of its own to test; it composes
// the real renderer, whose tests live in the repo root.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], globals: false, testTimeout: 30_000 },
})
