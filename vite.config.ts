import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// Single source of truth for the version shown on the splash — read package.json
// at build time and inject it into the HTML (%APP_VERSION%), so the splash never
// drifts from the released version. splashscreen.html has no JS bridge to query it.
const APP_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")).version;
const injectVersion = {
  name: "operator-inject-version",
  transformIndexHtml(html: string) {
    return html.replace(/%APP_VERSION%/g, APP_VERSION);
  },
};

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Operator hands each worktree session its own dev port via OPERATOR_DEV_PORT so
// parallel agents don't collide on 1420. The `tauri` wrapper (scripts/tauri.mjs)
// keeps tauri's devUrl pointed at the same port. Plain `npm run dev` → 1420.
// @ts-expect-error process is a nodejs global
const devPort = Number(process.env.OPERATOR_DEV_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), injectVersion],

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

  // Two HTML entries: the app (index.html) and the launch splash window
  // (splashscreen.html, loaded by the "splashscreen" Tauri window).
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        splashscreen: "splashscreen.html",
      },
    },
  },
}));
