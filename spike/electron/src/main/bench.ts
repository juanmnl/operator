// Measurement instrumentation — OFF unless asked for by env var.
//
// Kept out of `ipc.ts` on purpose: none of this is part of the renderer's contract, and a
// shell that carries its benchmark hooks on the same channels as its API is a shell whose API
// you can no longer read. Activated by `OPERATOR_ELECTRON_CAPTURE` / `_METRICS`.
//
// `capturePage` is the instrument that matters for M1: it reads the COMPOSITED surface, so a
// WebGL texture-atlas fault shows up in the PNG. A DOM dump would not — the buffer is correct
// in every one of these failures; it is the picture that is wrong.
import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const CAPTURE_DIR = process.env.OPERATOR_ELECTRON_CAPTURE
const CAPTURE_MS = Number(process.env.OPERATOR_ELECTRON_CAPTURE_MS ?? 15 * 60 * 1000)
const METRICS_MS = Number(process.env.OPERATOR_ELECTRON_METRICS_MS ?? 30 * 1000)
const LABEL = process.env.OPERATOR_ELECTRON_LABEL ?? 'run'

/** A per-PROCESS stamp in every filename.
 *
 *  Without it a restart silently overwrites the previous run's frames and truncates its CSV —
 *  and under launchd, which relaunches a job that exits, restarts are exactly what happens. The
 *  first version of this file lost a 5-minute run that way and nearly lost the evidence that the
 *  restart had occurred at all. Each process now writes its own set, and `-loads.log` is the
 *  shared thread that records the restarts themselves. */
const RUN = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)

export function startBench(win: BrowserWindow): void {
  if (!CAPTURE_DIR) return
  const started = Date.now()

  // A RELOAD INVALIDATES THE RUN. Remounting the panes gives xterm a fresh WebGL context and
  // an empty atlas, so a corruption test that silently reloaded at minute 40 is a 40-minute
  // test wearing a 2-hour label. Vite's watcher did exactly that once (see vite.config.ts), so
  // reloads are now recorded rather than trusted not to happen — read this file before reading
  // the frames.
  let loads = 0
  win.webContents.on('did-finish-load', () => {
    loads++
    if (loads > 1) console.warn(`[bench] RENDERER RELOADED (load #${loads}) — this run is no longer continuous`)
    void appendFile(join(CAPTURE_DIR, `${LABEL}-loads.log`), `${new Date().toISOString()} load#${loads} t+${Math.round((Date.now() - started) / 1000)}s\n`)
      .catch(() => { /* dir not made yet on the first load */ })
  })
  const stamp = () => String(Math.round((Date.now() - started) / 60000)).padStart(4, '0')

  void mkdir(CAPTURE_DIR, { recursive: true }).then(async () => {
    // A frame at t=0 as well as on the interval: "was it ever right?" is the first question a
    // corrupted 90-minute frame raises, and without a baseline it has no answer.
    const shoot = async () => {
      if (win.isDestroyed()) return
      try {
        const img = await win.webContents.capturePage()
        await writeFile(join(CAPTURE_DIR, `${LABEL}-${RUN}-t${stamp()}m.png`), img.toPNG())
      } catch (e) { console.error('[bench] capture failed:', e) }
    }
    setTimeout(shoot, 5000)
    setInterval(shoot, CAPTURE_MS)

    // M2: renderer RSS on a fixed cadence. `getAppMetrics` reports EVERY process — the
    // renderer's own working set is the number the Tauri figures (1089/1196 MB kills) are
    // comparable to, and the sum is what M3's idle-RSS question is about. Log both; a single
    // number here would silently answer whichever question the reader had in mind.
    const csv = join(CAPTURE_DIR, `${LABEL}-${RUN}-memory.csv`)
    await writeFile(csv, 'elapsed_s,renderer_rss_kb,gpu_rss_kb,total_rss_kb,process_count\n')
    setInterval(() => {
      const metrics = app.getAppMetrics()
      const rss = (type: string) => metrics.filter((m) => m.type === type)
        .reduce((n, m) => n + (m.memory?.workingSetSize ?? 0), 0)
      const total = metrics.reduce((n, m) => n + (m.memory?.workingSetSize ?? 0), 0)
      const row = [Math.round((Date.now() - started) / 1000), rss('Tab'), rss('GPU'), total, metrics.length].join(',')
      void appendFile(csv, row + '\n')
    }, METRICS_MS)
  })
}
