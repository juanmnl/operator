// Per-session accent overrides — the colour picked on an agent that ISN'T on a roster lane.
//
// A lane's colour belongs to the Role (the roster is the source of truth, so every surface
// recolours at once). A session with no lane has nowhere durable to put one, so it gets an
// override here, keyed by the session's SAVED key — stable across restarts, unlike the
// per-run `local-<terminalId>` session id, which gets recycled onto the next run's first
// agent (the same trap that once leaked stale custom names).
import { DEFAULT_LANE_ACCENTS } from './lane-accents'

export const SESSION_ACCENTS_KEY = 'operator.sessionAccents'

export type SessionAccents = Record<string, string>

/** Parse the stored map, tolerating absent/corrupt/non-object JSON and dropping any
 *  entry whose value isn't a colour string (hand-edited localStorage, older shapes). */
export function parseSessionAccents(raw: string | null): SessionAccents {
  if (!raw) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: SessionAccents = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k && typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

/** Set (or, with no accent, CLEAR) one session's override. Returns a new map — clearing
 *  removes the key entirely so the session falls back to the default colour rather than
 *  persisting an empty string. */
export function withSessionAccent(map: SessionAccents, key: string, accent?: string): SessionAccents {
  const next = { ...map }
  if (!key) return next
  if (accent && accent.trim()) next[key] = accent.trim()
  else delete next[key]
  return next
}

export function loadSessionAccents(): SessionAccents {
  try { return parseSessionAccents(localStorage.getItem(SESSION_ACCENTS_KEY)) } catch { return {} }
}

export function persistSessionAccents(map: SessionAccents): void {
  try { localStorage.setItem(SESSION_ACCENTS_KEY, JSON.stringify(map)) } catch { /* quota / private mode */ }
}

/** Apply one override to what is CURRENTLY stored, persist that, and return the merged map.
 *
 *  Two app instances share one localStorage, so writing a component's in-memory map back
 *  wholesale silently dropped every accent the OTHER instance had picked since this one
 *  loaded — last writer won the whole map, not just its own key. Re-reading first narrows
 *  that to the single key actually being changed. */
export function saveSessionAccent(key: string, accent?: string): SessionAccents {
  const merged = withSessionAccent(loadSessionAccents(), key, accent)
  persistSessionAccents(merged)
  return merged
}

/** Suggest a starting colour for a lane-less session so the picker doesn't open on
 *  "nothing selected" — deterministic per key, so the same agent always proposes the same
 *  swatch rather than flickering between renders. */
export function suggestedAccent(key: string): string {
  if (!key) return DEFAULT_LANE_ACCENTS[0]
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return DEFAULT_LANE_ACCENTS[h % DEFAULT_LANE_ACCENTS.length]
}
