import type { MemoryPressureLevel } from '../../shared/types'

// THE MEMORY-PRESSURE BANNER: when it shows, what it says, and when lanes are suspended without
// being asked.
//
// Main polls the kernel's pressure level (electron/src/main/memory-pressure.ts) and pushes each
// change. At 2 (warn) the banner says memory is low and offers "Suspend idle lanes", which suspends
// every lane lib/idle-suspend allows with the quiet-time rule dropped (`'now'`). At 4 (critical)
// the eligible lanes are suspended without asking, unless idle suspension is Off in Tuning, and the
// banner says how many were. At 1 it goes away.
//
// The decisions are here, pure; DashboardView gathers the lanes and runs the suspends.

export interface PressureBanner {
  level: MemoryPressureLevel
  /** Closed by the person. Holds until the level returns to normal and rises again more than
   *  DISMISSAL_KEPT_MS later, or rises from warn to critical. */
  dismissed: boolean
  /** Lanes suspended since the level last rose from normal, by the button or automatically. */
  suspended: number
  /** At normal: when the level dropped to it, if the banner was dismissed at the time. */
  dismissedDropAt?: number
}

export const NORMAL_BANNER: PressureBanner = { level: 1, dismissed: false, suspended: 0 }

/** A dismissal survives a drop to normal and a rise back within this long (review L1). Main
 *  already holds a drop until it has lasted a minute; this covers a slower flap. */
export const DISMISSAL_KEPT_MS = 5 * 60_000

export type PressureEvent =
  | { type: 'level'; level: MemoryPressureLevel; at: number }
  | { type: 'dismiss' }
  | { type: 'suspended'; count: number }

export function reducePressure(s: PressureBanner, e: PressureEvent): PressureBanner {
  switch (e.type) {
    case 'level':
      if (e.level === s.level) return s
      // Back to normal: hidden, and the next rise starts clean unless it comes soon after.
      if (e.level === 1) return s.dismissed ? { ...NORMAL_BANNER, dismissedDropAt: e.at } : NORMAL_BANNER
      // A new rise from normal: shown again, unless it was dismissed and normal lasted only briefly.
      // A rise to critical always shows it, as warn to critical does.
      if (s.level === 1) {
        const kept = e.level === 2 && s.dismissedDropAt !== undefined && e.at - s.dismissedDropAt < DISMISSAL_KEPT_MS
        return { level: e.level, dismissed: kept, suspended: 0 }
      }
      // Warn to critical: shown again even if dismissed at warn, because lanes may now be
      // suspended without the person asking and they should see that it happened.
      if (e.level > s.level) return { ...s, level: e.level, dismissed: false }
      // Critical back to warn: as it was.
      return { ...s, level: e.level }
    case 'dismiss':
      return s.level === 1 ? s : { ...s, dismissed: true }
    case 'suspended':
      return e.count > 0 && s.level !== 1 ? { ...s, suspended: s.suspended + e.count } : s
  }
}

export function bannerVisible(s: PressureBanner): boolean {
  return s.level > 1 && !s.dismissed
}

/** Suspend without asking? Only at critical, and only while idle suspension is on in Tuning: Off
 *  means Operator never ends a lane on its own, and the button is still there. */
export function autoSuspendAllowed(level: MemoryPressureLevel, idleSuspendMinutes: number): boolean {
  return level === 4 && idleSuspendMinutes > 0
}

/** How often the eligible count is read again while the banner shows, and how often a critical
 *  level runs another automatic pass: a lane that finishes its turn while memory is still critical
 *  is suspended on the next one. */
export const PRESSURE_RECHECK_MS = 30_000

const idleLanes = (n: number) => (n === 1 ? '1 idle lane' : `${n} idle lanes`)

/** Sentences joined so that none begins with a word stranded at a line end (each sentence's
 *  first space is a no-break space) and the last word never sits alone (so is the last space). */
export function joinSentences(parts: readonly string[]): string {
  const bound = parts.map((p, i) => (i === 0 ? p : p.replace(' ', ' ')))
  const text = bound.join(' ')
  const last = text.lastIndexOf(' ')
  return last < 0 ? text : `${text.slice(0, last)} ${text.slice(last + 1)}`
}

export interface BannerCopy {
  text: string
  /** The button's label; absent when there is nothing for it to do. */
  action?: string
}

/** What the banner says. `running`: live lanes across every project. `eligible`: lanes the
 *  button would suspend now, undefined while it is being read. `autoOff`: idle suspension is Off. */
export function bannerCopy(s: PressureBanner, o: { running: number; eligible?: number; autoOff: boolean }): BannerCopy {
  const parts = [s.level === 4 ? 'Memory is critically low.' : 'Memory is low.']
  parts.push(o.running === 1 ? '1 lane is running.' : `${o.running} lanes are running.`)
  if (s.suspended > 0) parts.push(`Suspended ${idleLanes(s.suspended)}.`)
  else if (s.level === 4 && o.autoOff) parts.push('Idle suspension is off in Tuning.')
  if (o.running > 0 && o.eligible === 0) parts.push(s.suspended > 0 ? 'No other lane can be suspended right now.' : 'None of them can be suspended right now.')
  const action = o.eligible ? `Suspend ${idleLanes(o.eligible)}` : undefined
  return { text: joinSentences(parts), action }
}
