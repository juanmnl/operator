// HOW MUCH MEMORY THE MAC HAS LEFT, as the kernel grades it.
//
// On 2026-10-16 the Mac ran out of memory and rebooted with 19 lane CLIs running, and Operator
// had read nothing about system memory before it happened (dev/results/memory-footprint-research-
// 2026-10-16.md, Q5). This module reads the kernel's own pressure grade and tells the renderer when
// it changes; the renderer shows the banner and suspends idle lanes (lib/memory-pressure).
//
// THE SOURCE IS `sysctl`. `kern.memorystatus_vm_pressure_level` is the grade jetsam acts on: 1
// normal, 2 warn, 4 critical. `kern.memorystatus_level` is the percent of memory the kernel counts
// as available. Electron has no pressure API: `process.getSystemMemoryInfo()` reports free pages,
// which on macOS sit near zero whenever the file cache is warm and say nothing about pressure, and
// Chromium's own dispatch-source monitor is not exposed to JS. One `sysctl` exec reads both names
// and takes about 2 ms, so polling it is cheap: every 20 s at normal, every 5 s above it.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { MemoryPressure, MemoryPressureLevel } from '../../../src/shared/types'

/** Poll interval while the level is normal. Pressure builds over minutes as lanes start. */
export const NORMAL_POLL_MS = 20_000
/** Poll interval above normal, so a rise to critical and the fall back are seen within seconds. */
export const ELEVATED_POLL_MS = 5_000

const LEVELS: ReadonlySet<number> = new Set([1, 2, 4])

/** `sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level` prints two lines: the
 *  level, then the percent available. Null when the level is missing or not one the kernel uses. */
export function parsePressure(out: string): { level: MemoryPressureLevel; freePercent?: number } | null {
  const [levelLine, freeLine] = out.split('\n').map((l) => l.trim())
  if (!levelLine || !/^\d+$/.test(levelLine)) return null
  const level = Number(levelLine)
  if (!LEVELS.has(level)) return null
  const free = freeLine && /^\d+$/.test(freeLine) ? Number(freeLine) : NaN
  return { level: level as MemoryPressureLevel, freePercent: free >= 0 && free <= 100 ? free : undefined }
}

const readSysctl = () => new Promise<string>((resolve, reject) => {
  execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level'], { timeout: 5_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
})

/** A dev build reads the level from this file instead of `sysctl`, so the banner can be shown
 *  without starving the Mac of memory. Never in a packaged build. */
export function fakePressureFile(isPackaged: boolean, env: Record<string, string | undefined>): string | null {
  if (isPackaged) return null
  return env.OPERATOR_MEMORY_PRESSURE_FILE || null
}

/** Where the sample comes from: the fake file in a dev build that names one, `sysctl` otherwise. */
export function pressureSource(fakeFile: string | null): () => Promise<string> {
  return fakeFile ? () => readFile(fakeFile, 'utf8') : readSysctl
}

export class MemoryPressureWatcher {
  private last: MemoryPressure | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly onChange: (p: MemoryPressure) => void,
    private readonly sample: () => Promise<string> = readSysctl,
    private readonly now: () => number = Date.now,
  ) {}

  /** The latest reading, for a renderer that loads after the last change went out. */
  current(): MemoryPressure | null {
    return this.last
  }

  start(): void {
    this.stopped = false
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One reading. A failed read keeps the last level and is tried again at the normal interval. */
  async poll(): Promise<void> {
    let parsed: ReturnType<typeof parsePressure> = null
    try { parsed = parsePressure(await this.sample()) } catch { /* kept */ }
    if (this.stopped) return
    if (parsed) {
      const changed = parsed.level !== this.last?.level
      this.last = { level: parsed.level, freePercent: parsed.freePercent, at: this.now() }
      if (changed) {
        console.error(`[memory] pressure level ${parsed.level}${parsed.freePercent === undefined ? '' : `, ${parsed.freePercent}% available`}`)
        this.onChange(this.last)
      }
    }
    const next = (this.last?.level ?? 1) > 1 ? ELEVATED_POLL_MS : NORMAL_POLL_MS
    this.timer = setTimeout(() => { void this.poll() }, next)
    this.timer.unref?.()
  }
}
