// WHEN A PERSON LAST TYPED INTO A LANE, per terminal.
//
// Dispatch may retire a lane that released its worktree (lib/dispatch). The transcript shows a
// prompt only after it is submitted and tailed, about a second later, and a half-typed line never
// shows at all. A keystroke is the earliest sign someone is at that lane, so a lane typed into
// recently is not retired. Recorded from the pane's real key events, the same hook that disarms
// the submit rescue (TerminalPane), because xterm's `onData` also carries terminal replies.

const lastAt = new Map<string, number>()

export function noteKeystroke(terminalId: string, now = Date.now()): void {
  lastAt.set(terminalId, now)
}

/** Has anyone typed into this lane in the last `ms`? */
export function typedWithin(terminalId: string, ms: number, now = Date.now()): boolean {
  const at = lastAt.get(terminalId)
  return at !== undefined && now - at < ms
}

/** When anyone last typed into this lane, or undefined. */
export function lastKeystrokeAt(terminalId: string): number | undefined {
  return lastAt.get(terminalId)
}

// UNSENT INPUT. Idle-lane suspension (lib/idle-suspend) must not end a lane while text sits in its
// composer, because the new process starts with an empty one. The TUI's composer cannot be read, so
// this is judged from the keys: a printable key or a paste starts a draft; Enter, Ctrl+C or a double
// Esc ends it. A draft deleted with Backspace still reads as a draft. That errs toward keeping a lane
// running.
// The submit queue reads it too (lib/submit-queue `hasUnsentInput`): a message pasted into a draft
// is merged with it and submitted, so deliveries wait until the draft is sent or cleared.
//
// MIRRORED IN MAIN (review F1, 2026-10-24). This set dies with the renderer, while the pty and the
// text in its composer survive a crash or reload. Every change is told to the listeners
// (`onDraftChange`); DashboardView sends it to main, and after a reload `restoreDrafts` puts back
// the ones main kept, marked unknown: the person may have sent or cleared them since, and nothing
// here can see that.

const drafts = new Set<string>()
// Restored after a reload and not typed into since: the draft may or may not still be there.
const unknown = new Set<string>()
// The previous keydown per lane, for the two-key sequences below. Modifier-only keydowns are not
// recorded: Shift on its own changes nothing in the composer.
const prevKey = new Map<string, { key: string; at: number }>()
const listeners = new Set<(terminalId: string, on: boolean) => void>()

/** Claude Code's double-press window, from the 2.1.310 binary (`var a=800` before the
 *  double-press hook that clears the input on "double tap esc to clear input"; inclusive). */
export const DOUBLE_ESC_MS = 800

type DraftKey = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** What one keydown does to the composer, as far as the key and the one before it can tell. Pure.
 *
 *  `\` then Enter is a newline in Claude Code ("backslash (\\) + return to add newlines", in the
 *  binary), not a send. Esc twice within `DOUBLE_ESC_MS` clears the input. */
export function draftEffect(e: DraftKey, prev?: { key: string; at: number }, now = Date.now()): 'draft' | 'clear' | null {
  if (e.key === 'Enter') return e.shiftKey || e.altKey || prev?.key === '\\' ? 'draft' : 'clear'
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return prev?.key === 'Escape' && now - prev.at <= DOUBLE_ESC_MS ? 'clear' : null
  }
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) return 'clear'
  if (e.metaKey && (e.key === 'v' || e.key === 'V')) return 'draft'
  if (e.metaKey || e.ctrlKey) return null
  return e.key.length === 1 ? 'draft' : null
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

function setDraft(terminalId: string, on: boolean): void {
  if (on === drafts.has(terminalId)) return
  if (on) drafts.add(terminalId)
  else drafts.delete(terminalId)
  for (const fn of listeners) { try { fn(terminalId, on) } catch { /* a listener must never break key tracking */ } }
}

export function noteDraftKey(terminalId: string, e: DraftKey, now = Date.now()): void {
  if (MODIFIER_KEYS.has(e.key)) return
  const effect = draftEffect(e, prevKey.get(terminalId), now)
  // A third Esc after a clearing pair starts a new pair, as in the TUI.
  if (effect === 'clear' && e.key === 'Escape') prevKey.delete(terminalId)
  else prevKey.set(terminalId, { key: e.key, at: now })
  if (effect === 'draft') { unknown.delete(terminalId); setDraft(terminalId, true) }
  else if (effect === 'clear') { unknown.delete(terminalId); setDraft(terminalId, false) }
}

/** A paste lands in the composer too. */
export function notePaste(terminalId: string): void {
  prevKey.delete(terminalId)
  unknown.delete(terminalId)
  setDraft(terminalId, true)
}

/** Has someone typed into this lane's composer without sending it? */
export function hasUnsentInput(terminalId: string): boolean {
  return drafts.has(terminalId)
}

/** Is this lane's draft one restored after a reload (`restoreDrafts`) and not typed into since? */
export function draftUnknown(terminalId: string): boolean {
  return unknown.has(terminalId)
}

/** Forget a lane's draft: its process ended or was restarted, so its composer is gone. The submit
 *  queue holds deliveries while a draft is flagged (lib/submit-queue), and a flag left on a dead
 *  terminal id would hold them forever. Also the forced delivery's clear: its CR sent the draft. */
export function clearUnsentInput(terminalId: string): void {
  unknown.delete(terminalId)
  prevKey.delete(terminalId)
  setDraft(terminalId, false)
}

/** After a reload: the lanes main last knew to have a draft. Each is flagged again and marked
 *  unknown, so deliveries to it wait as they did before the reload. */
export function restoreDrafts(terminalIds: Iterable<string>): void {
  for (const id of terminalIds) {
    unknown.add(id)
    setDraft(id, true)
  }
}

/** Called on every draft change, with the lane and whether it now has one. Returns the unsubscribe. */
export function onDraftChange(fn: (terminalId: string, on: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
