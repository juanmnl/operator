// Pure formatting helpers shared across the dashboard, usage, and activity views.
// Extracted from the components (which previously each carried their own copy) so
// the rounding/threshold rules have one definition and a unit test.

/** "just now" / "5m ago" / "2h ago" / "3d ago" from an ISO timestamp.
 *  Pass `subMinuteSeconds` to render "12s ago" instead of "just now" under a minute. */
export function relativeTime(iso: string, opts: { subMinuteSeconds?: boolean } = {}): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return opts.subMinuteSeconds ? `${s}s ago` : 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Collapse the user's home directory to `~` for display: /Users/me/dev/app → ~/dev/app.
 *  Pattern-based (no fs/home lookup) so it stays a pure formatter: matches the macOS and
 *  Linux home layouts only, and returns anything else unchanged. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** Dollar cost, precision scaled to magnitude: $123 / $12.34 / $0.123. */
export function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(3)}`
}

/** Token count with SI suffix: 1.23B / 4.5M / 12.3k / 999. */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${n}`
}

/** Display label for a model id: strips the "claude-" prefix, dashes → spaces.
 *  (Id-style, for the usage view. For a family label — "Opus"/"Sonnet" — see
 *  lib/roster's modelFamilyLabel.) */
export function modelLabel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-/g, ' ')
}

/** True for Claude Code's injected plumbing turns (<local-command-*>, <command-*>,
 *  <system-reminder>, …) that masquerade as user prompts in the transcript. Mirrors the
 *  backend filter in transcript.rs — keep the two prefix lists in sync. A genuine prompt
 *  may legitimately start with '<' ("<Modal> crashes on mount"), so match exact prefixes,
 *  not just the bracket. */
const INJECTED_PREFIXES = ['<local-command-', '<command-name>', '<command-message>', '<command-args>', '<system-reminder>', '<task-notification>', '<synthetic>']
export function isInjectedTurn(text: string): boolean {
  const t = text.trimStart()
  return INJECTED_PREFIXES.some((p) => t.startsWith(p))
}

/** Coarse duration for the usage view: — / 45s / 12m / 2h 30m. Non-positive → em dash. */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Fine duration for the activity timeline: 999ms / 1.5s / 35s / 1m 5s.
 *  Sub-10s keeps one decimal; ≥60s drops the seconds when they round to zero. */
export function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}
