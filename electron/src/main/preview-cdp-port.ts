// A Chrome DevTools Protocol port per lane, for projects that are Electron apps.
//
// Preview shows an Electron app by attaching to its renderer over CDP (preview-cdp.ts). That needs
// the app to be started with `--remote-debugging-port`, and Operator cannot add a switch to an
// arbitrary npm script. So a lane in an Electron project gets a port reserved for it and exported as
// OPERATOR_CDP_PORT, and its launch note tells the agent the one-line opt-in the app needs. This is the
// same shape as OPERATOR_DEV_PORT: a verified-free port, stated at spawn, read by the app.
//
// Its own window, away from the dev-server window (1420..1520) and from Chrome's customary 9222, so a
// dev server and a debugging port can never be handed the same number.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CDP_PORT_BASE = 9340
export const CDP_PORT_MAX = 9440

/** Does this parsed package.json depend on Electron (dependencies or devDependencies)? Pure. */
export function dependsOnElectron(pkg: unknown): boolean {
  if (!pkg || typeof pkg !== 'object') return false
  const p = pkg as { dependencies?: unknown; devDependencies?: unknown }
  for (const deps of [p.dependencies, p.devDependencies]) {
    if (deps && typeof deps === 'object' && Object.prototype.hasOwnProperty.call(deps, 'electron')) return true
  }
  return false
}

/** Where an Electron dependency is looked for: the project's own package.json, and one level down
 *  (an `electron/` or `app/` package beside a web package — Operator's own layout). */
export const PACKAGE_JSON_DIRS = ['.', 'electron', 'app', 'desktop']

/** Is the project at `cwd` an Electron app? Never throws; an unreadable package.json is "no". */
export async function isElectronProject(cwd: string): Promise<boolean> {
  for (const dir of PACKAGE_JSON_DIRS) {
    try {
      if (dependsOnElectron(JSON.parse(await readFile(join(cwd, dir, 'package.json'), 'utf8')))) return true
    } catch { /* absent or not JSON */ }
  }
  return false
}

/** The first port in the window that this process has not handed out and that binds free right now.
 *  `undefined` when the window is exhausted. */
export async function allocateCdpPort(
  inUse: ReadonlySet<number>,
  isFree: (port: number) => Promise<boolean>,
  base = CDP_PORT_BASE,
  max = CDP_PORT_MAX,
): Promise<number | undefined> {
  for (let p = base; p <= max; p++) {
    if (inUse.has(p)) continue
    if (await isFree(p)) return p
  }
  return undefined
}

/** The line a lane in an Electron project gets in its launch note. */
export function cdpLaunchNote(port: number): string {
  return `This project is an Electron app. Operator reserved port ${port} (env OPERATOR_CDP_PORT) so the `
    + `Preview panel can show and inspect the running app over Chrome DevTools Protocol. The app must `
    + `enable it before \`app\` is ready: \`app.commandLine.appendSwitch('remote-debugging-port', `
    + `process.env.OPERATOR_CDP_PORT)\` in the main process (guard it for development builds), or start `
    + `Electron with \`--remote-debugging-port=${port}\`. Do not use this port for anything else.`
}

/** OPERATOR'S OWN OPT-IN: the port a dev build of Operator should open for debugging, or null.
 *
 *  A lane working on Operator itself gets OPERATOR_CDP_PORT like any Electron project's lane, and a
 *  dev build it starts opens that port so the lane's Preview can show it. Never in a packaged app
 *  (a released Operator must not expose its renderer), never on the `--mcp-serve` path (that process
 *  is spawned inside a lane and inherits the same variable, and would take the port first), and only
 *  for a port number. Pure. */
export function ownCdpPort(isPackaged: boolean, env: Record<string, string | undefined>, argv: readonly string[]): string | null {
  if (isPackaged || argv.includes('--mcp-serve')) return null
  const port = (env.OPERATOR_CDP_PORT ?? '').trim()
  return /^\d{2,5}$/.test(port) ? port : null
}
