#!/usr/bin/env node
// Wrapper around the Tauri CLI that keeps the Vite dev-server port and tauri's
// devUrl in sync per worktree. Operator hands each session a unique
// OPERATOR_DEV_PORT (so parallel agents never collide on 1420); if it's unset
// (a plain manual run) we grab the first free port ourselves. For `tauri dev`
// we inject a matching devUrl via --config so the webview loads from the right
// port. Every other subcommand (build, etc.) passes straight through.
import { spawn } from "node:child_process";
import net from "node:net";

const args = process.argv.slice(2);
const isDev = args[0] === "dev";

function isFree(port) {
  // Check BOTH loopbacks (parity with the backend's dual-stack port_free): a port held
  // on [::1] only — Vite's usual bind here — must not read as free on 127.0.0.1.
  const freeOn = (host) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, host);
    });
  return freeOn("127.0.0.1").then((v4) => (v4 ? freeOn("::1") : false));
}

async function pickPort() {
  const reserved = Number(process.env.OPERATOR_DEV_PORT);
  if (reserved) return reserved; // Operator already reserved a unique port
  for (let p = 1420; p < 1520; p++) {
    if (await isFree(p)) return p;
  }
  return 1420;
}

const env = { ...process.env };
const extra = [];
if (isDev) {
  const port = await pickPort();
  env.OPERATOR_DEV_PORT = String(port);
  extra.push("--config", JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }));
  console.log(`[operator] dev server → http://localhost:${port}`);
}

const bin = process.platform === "win32" ? "node_modules\\.bin\\tauri.cmd" : "node_modules/.bin/tauri";
const child = spawn(bin, [...args, ...extra], { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
