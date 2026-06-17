import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Operator hands each worktree session its own dev port via OPERATOR_DEV_PORT so
// parallel agents don't collide on 1420. The `tauri` wrapper (scripts/tauri.mjs)
// keeps tauri's devUrl pointed at the same port. Plain `npm run dev` → 1420.
// @ts-expect-error process is a nodejs global
const devPort = Number(process.env.OPERATOR_DEV_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      // SPIKE: @xterm/addon-canvas@0.8.0-beta.48 ships a broken package.json —
      // its `module` field points at lib/addon-canvas.mjs but the built file is
      // lib/xterm-addon-canvas.mjs. Point the bare specifier at the real ESM file.
      "@xterm/addon-canvas": "@xterm/addon-canvas/lib/xterm-addon-canvas.mjs",
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: devPort + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
