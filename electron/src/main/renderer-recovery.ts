// What to do when the window's renderer process dies, and the durable record of each time it did.
//
// On 2026-10-06 the 0.27.1 renderer died after 7 days of uptime (EXC_BREAKPOINT/SIGTRAP) and the
// `render-process-gone` handler only logged to stderr, so the window stayed black until the user
// quit — which killed every lane. The ptys live in main and survive a renderer death; a reload
// lets the renderer's reattach path (`terminalList` + history replay) bring them back.
//
// The decision is pure so the crash-loop budget can be tested without a window. Packaged stderr is
// not kept when the app is launched from Finder, so each event also goes to a file.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { operatorDir } from './store'

/** At most this many automatic reloads inside `RELOAD_WINDOW_MS`. One more crash inside the window
 *  shows the error page instead: a renderer that dies on every load must not reload forever. */
export const RELOAD_LIMIT = 3
export const RELOAD_WINDOW_MS = 60_000

export type RecoveryAction = 'reload' | 'error-page' | 'none'

export interface GoneInput {
  /** `RenderProcessGoneDetails.reason`. */
  reason: string
  /** The dead renderer was showing the error page, not the app. */
  onErrorPage: boolean
}

/** Decide, given the times of the automatic reloads so far, what to do about a dead renderer.
 *  Returns the reload times to keep: entries older than the window are dropped, and a reload
 *  decided now is added.
 *
 *  - `clean-exit` is a renderer that ended on purpose (a window closing, the app quitting): nothing.
 *  - The error page itself dying gets nothing either, or a crashing error page would load forever.
 *  - Otherwise reload, unless `RELOAD_LIMIT` reloads already happened inside the window. */
export function decideRecovery(
  input: GoneInput,
  reloads: readonly number[],
  now: number,
): { action: RecoveryAction; reloads: number[] } {
  const recent = reloads.filter((t) => now - t < RELOAD_WINDOW_MS)
  if (input.reason === 'clean-exit' || input.onErrorPage) return { action: 'none', reloads: recent }
  if (recent.length >= RELOAD_LIMIT) return { action: 'error-page', reloads: recent }
  return { action: 'reload', reloads: [...recent, now] }
}

/** The in-page link the error page's Reload button follows. Main watches for it with
 *  `did-navigate-in-page`, so the page needs no script and no preload API. */
export const RELOAD_HASH = '#operator-reload'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The page shown once the reload budget is spent, as a `data:` URL. */
export function errorPageUrl(reason: string, logFile: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Operator</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#c9ccd1;font:14px/1.5 -apple-system,system-ui,sans-serif;-webkit-app-region:drag}
main{max-width:440px;padding:24px}h1{font-size:16px;font-weight:600;margin:0 0 8px;color:#e6e8eb}p{margin:0 0 16px}
code{font:12px ui-monospace,Menlo,monospace;word-break:break-all}
a{-webkit-app-region:no-drag;display:inline-block;padding:6px 14px;border-radius:6px;background:#2a2f36;color:#e6e8eb;text-decoration:none}a:hover{background:#353b44}
</style></head><body><main>
<h1>The Operator window keeps crashing</h1>
<p>It crashed ${RELOAD_LIMIT + 1} times in a minute (last reason: ${escapeHtml(reason)}), so Operator stopped reloading&nbsp;it. Your&nbsp;lanes are still running and come back when the window&nbsp;reloads.</p>
<p>Each crash is recorded in <code>${escapeHtml(logFile)}</code></p>
<a href="${RELOAD_HASH}">Reload</a>
</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export const rendererGoneLogFile = (): string => join(operatorDir(), 'logs', 'renderer-gone.log')

export interface GoneEvent {
  at: string
  reason: string
  exitCode: number
  reloaded: boolean
}

/** Append one JSON line per renderer death. Never throws: the recovery must not depend on the log. */
export async function logRendererGone(event: GoneEvent): Promise<void> {
  try {
    await mkdir(join(operatorDir(), 'logs'), { recursive: true })
    await appendFile(rendererGoneLogFile(), `${JSON.stringify(event)}\n`)
  } catch { /* stderr still has it */ }
}
