// QA-ONLY entry for dev/briefs/qa-plan-bar-and-bus.md item 2 — the session footer's plan cell.
// Reuses dev/qa-real-bridge.ts's real project/roster data verbatim (no changes to that file —
// it is shared with other QA drivers) and layers a controllable `planLimits` on top, selected
// by `?limits=<case>` so dev/drive-plan-bar.mjs can reload into each case. Never bundled into
// the app; DEV-ONLY, throwaway.
import { createRoot } from 'react-dom/client'
import { installRealBridge } from './qa-real-bridge'
import App from '../src/renderer/App'
import '../src/renderer/styles.css'

installRealBridge()

const now = new Date()
const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString()

const PLAN_FIXTURES: Record<string, unknown> = {
  // Each of the three limits binding in turn — the other two present but lower, so `bindingLimit`
  // must actually compare rather than default to the session row.
  'session-binding': { sessionPct: 92, sessionResets: 'in 45 min', weekPct: 30, weekResets: 'in 3 days', modelPct: 10, modelLabel: 'Opus', modelResets: 'in 3 days', fetchedAt: iso() },
  'week-binding': { sessionPct: 20, sessionResets: 'in 45 min', weekPct: 88, weekResets: 'in 3 days', modelPct: 15, modelLabel: 'Opus', modelResets: 'in 3 days', fetchedAt: iso() },
  'model-binding': { sessionPct: 20, sessionResets: 'in 45 min', weekPct: 30, weekResets: 'in 3 days', modelPct: 95, modelLabel: 'Opus', modelResets: 'in 3 days', fetchedAt: iso() },
  // No limits at all (an API-billed account, or a CLI that never answered).
  absent: {},
  // A real reading, but old enough that `freshnessOf` reports `expired` via `isStale` (STALE_MS =
  // 1h) — NOT via `windowEnded` (the reset clause is deliberately far enough past the fetch time
  // that it still resolves to a moment in the FUTURE, so this exercises the plain-staleness path
  // rather than the separate "window closed" one).
  stale: { sessionPct: 40, sessionResets: 'in 90 min', weekPct: 40, weekResets: 'in 3 days', fetchedAt: iso(-65 * 60_000) },
}

const which = new URLSearchParams(location.search).get('limits') ?? 'session-binding'
;(window.operator as unknown as { planLimits: (force?: boolean) => Promise<unknown> }).planLimits =
  async (_force?: boolean) => PLAN_FIXTURES[which] ?? null

createRoot(document.getElementById('root')!).render(<App />)
