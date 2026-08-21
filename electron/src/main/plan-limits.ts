// The plan's session/weekly limits. Ported from `src-tauri/src/planlimits.rs`.
//
// There is no API for these and no derivation from the transcripts — but there IS a supported
// way to ASK: `claude -p "/usage"` prints them. So this shells out, parses prose, and caches.
// Parsing prose is fragile by nature, which is why an unexpected answer comes back as a `note`
// on an otherwise-empty result rather than as an error or, worse, as zeroes: an empty meter
// with no explanation is indistinguishable from a broken one.
import { execFile } from 'node:child_process'
import { loginShell } from './login-shell'

export interface PlanLimits {
  sessionPct?: number | null
  sessionResets?: string | null
  weekPct?: number | null
  weekResets?: string | null
  modelLabel?: string | null
  modelPct?: number | null
  modelResets?: string | null
  plan?: string | null
  fetchedAt: string
  note?: string | null
}

/** The number immediately before a `%`. Read backwards from the sign so "Current session: 47%"
 *  and "…(47%)" both work without a pattern per phrasing. */
export function percentIn(line: string): number | null {
  const idx = line.indexOf('%')
  if (idx < 0) return null
  const m = line.slice(0, idx).match(/(\d+)$/)
  if (!m) return null
  return Math.min(100, Number.parseInt(m[1], 10))
}

export function resetsIn(line: string): string | null {
  const at = line.indexOf('resets')
  if (at < 0) return null
  const rest = line.slice(at + 'resets'.length).trim()
  return rest || null
}

export function parenLabel(line: string): string | null {
  const open = line.indexOf('(')
  if (open < 0) return null
  const close = line.indexOf(')', open)
  if (close < 0) return null
  return line.slice(open + 1, close).trim() || null
}

export function parseUsage(stdout: string): PlanLimits {
  const out: PlanLimits = { fetchedAt: new Date().toISOString() }
  let sawAny = false

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.toLowerCase()

    if (out.plan == null && lower.includes('subscription') && !lower.includes('%')) {
      out.plan = line
      continue
    }
    // Everything past this heading is the breakdown, not the meters.
    if (lower.startsWith("what's contributing") || lower.startsWith('whats contributing')) break

    if (lower.includes('current session')) {
      sawAny = true
      out.sessionPct = percentIn(line)
      out.sessionResets = resetsIn(line)
    } else if (lower.includes('current week')) {
      sawAny = true
      const label = parenLabel(line)
      // An UNLABELLED weekly line is the overall one; a labelled one names whichever model the
      // plan meters separately — carried rather than hardcoded, because "Fable" today is not a
      // promise about tomorrow.
      const isAll = label == null || label.toLowerCase().includes('all model')
      if (isAll) {
        out.weekPct = percentIn(line)
        out.weekResets = resetsIn(line)
      } else {
        out.modelLabel = label
        out.modelPct = percentIn(line)
        out.modelResets = resetsIn(line)
      }
    }
  }

  if (!sawAny) {
    const head = stdout.trim().split('\n').slice(0, 2).join(' ')
    out.note = head ? `\`claude -p "/usage"\` said: ${head}` : '`claude -p "/usage"` returned nothing.'
  }
  return out
}

let cache: { at: number; value: PlanLimits } | null = null
const TTL_MS = 5 * 60 * 1000
const TIMEOUT_MS = 30_000

/** Never rejects. An unreadable answer comes back with empty fields and a `note`, because the
 *  caller is a meter in the UI and a rejected promise there shows nothing at all. */
export async function fetchPlanLimits(force = false): Promise<PlanLimits> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value
  const value = await new Promise<PlanLimits>((resolve) => {
    // THE USER'S login shell, for the same reason terminals use one: `claude` is usually on a
    // PATH that only an interactive login shell sets up, and `/bin/sh` reads `~/.profile`
    // instead of `~/.zshrc` — which is how the shipped 0.17.0 got `claude: command not found`.
    const child = execFile(loginShell(), ['-ilc', "claude -p '/usage'"], { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
          resolve({
            fetchedAt: new Date().toISOString(),
            note: timedOut
              ? `\`claude -p "/usage"\` didn't answer within ${TIMEOUT_MS / 1000}s.`
              : `\`claude -p "/usage"\` failed: ${err.message}`,
          })
          return
        }
        resolve(parseUsage(stdout))
      })
    // Close stdin, as `planlimits.rs:281` does with `Stdio::null()`. An interactive shell holding
    // an open pipe it can read from is a shell that can sit there until the timeout.
    child.stdin?.end()
  })
  cache = { at: Date.now(), value }
  return value
}
