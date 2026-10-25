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
// What was typed or pasted into the composer since it was last known empty, as far as the keys can
// follow it (review S2, 2026-10-25). Only its last character is read: it is the one before the cursor
// while the cursor is at the end. `UNSEEN` stands for text these keys cannot see, after the cursor
// moved or a paste whose text was not given; it is never `\`. Kept to the last `TAIL_MAX` characters.
const tail = new Map<string, string>()
const UNSEEN = '\u0000'
const TAIL_MAX = 256
// Lanes where Claude Code's suggestion list may be open: the `@` file picker or the `/` command menu
// (review S1, 2026-10-25). The composer cannot be read, so this is set by any key or paste that can
// open one and stays set until an Esc, an Enter or a Ctrl+C. Wrong only toward keeping a draft.
const pickerMaybe = new Set<string>()
const listeners = new Set<(terminalId: string, on: boolean) => void>()

/** Claude Code's double-press window, from the 2.1.310 binary (`var a=800` before the
 *  double-press hook that clears the input on "double tap esc to clear input"; inclusive). */
export const DOUBLE_ESC_MS = 800

type DraftKey = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** What the keys before this one left in the lane's composer, as `draftEffect` reads it. */
export interface DraftKeyState {
  /** The previous keydown, for the double Esc. */
  prev?: { key: string; at: number }
  /** The character before the cursor, when the keys can tell. */
  before?: string
  /** A suggestion list may be open. */
  picker?: boolean
}

/** What one keydown does to the composer, as far as the keys before it can tell. Pure.
 *
 *  `\` then Enter is a newline in Claude Code ("backslash (\\) + return to add newlines", in the
 *  binary), not a send. The binary reads the character before the cursor (`b.text[b.offset-1]`),
 *  whatever key or paste put it there, so `before` does too.
 *
 *  Esc twice within `DOUBLE_ESC_MS` clears the input, except while a suggestion list is open. The
 *  2.1.310 binary passes `disableEscapeDoublePress` while it has suggestions (`U_=Uf.length>0`),
 *  and the first Esc only closes the list (`case"escape":if(Z)return`). So with `picker` set the Esc
 *  starts no pair. */
export function draftEffect(e: DraftKey, state: DraftKeyState = {}, now = Date.now()): 'draft' | 'clear' | null {
  if (e.key === 'Enter') return e.shiftKey || e.altKey || state.before === '\\' ? 'draft' : 'clear'
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (state.picker) return null
    const prev = state.prev
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

/** Keys that type nothing and leave the cursor where it was, so the character before it stays known. */
const CURSOR_KEEPS = new Set(['Escape', 'Enter', 'Backspace', 'Delete', 'Insert'])
// Characters that open a suggestion list: `@` the file picker, `/` the command menu.
const opensPicker = (text: string) => text.includes('@') || text.includes('/')

function append(terminalId: string, text: string): void {
  const t = (tail.get(terminalId) ?? '') + text
  tail.set(terminalId, t.length > TAIL_MAX ? UNSEEN + t.slice(-TAIL_MAX) : t)
}

export function noteDraftKey(terminalId: string, e: DraftKey, now = Date.now()): void {
  if (MODIFIER_KEYS.has(e.key)) return
  const picker = pickerMaybe.has(terminalId)
  const effect = draftEffect(e, { prev: prevKey.get(terminalId), before: tail.get(terminalId)?.slice(-1), picker }, now)
  // A third Esc after a clearing pair starts a new pair, as in the TUI. An Esc that closed a
  // suggestion list is not the first of a pair either.
  if (e.key === 'Escape' && (effect === 'clear' || picker)) prevKey.delete(terminalId)
  else prevKey.set(terminalId, { key: e.key, at: now })
  if (e.key === 'Escape' || effect === 'clear') pickerMaybe.delete(terminalId)
  if (effect === 'clear') tail.set(terminalId, '')
  else if (e.key === 'Enter') {
    pickerMaybe.delete(terminalId)
    // A newline; after `\` the TUI replaces the backslash with it.
    const t = tail.get(terminalId) ?? ''
    tail.set(terminalId, (t.endsWith('\\') ? t.slice(0, -1) : t) + '\n')
  } else if (e.key === 'Backspace') {
    const t = tail.get(terminalId) ?? ''
    // What was before the unseen text is still unseen.
    tail.set(terminalId, t === UNSEEN ? t : t.slice(0, -1))
  } else if (effect === 'draft' && !e.metaKey) {
    append(terminalId, e.key)
    if (opensPicker(e.key)) pickerMaybe.add(terminalId)
  } else if (!CURSOR_KEEPS.has(e.key) && !(e.metaKey && (e.key === 'v' || e.key === 'V'))) {
    // Arrows, Home/End, history, Tab completion, Ctrl+A/E/K/U: the cursor or the text moved in a
    // way these keys cannot follow. Tab can also open the file list.
    tail.set(terminalId, UNSEEN)
    if (e.key === 'Tab') pickerMaybe.add(terminalId)
  }
  if (effect === 'draft') { unknown.delete(terminalId); setDraft(terminalId, true) }
  else if (effect === 'clear') { unknown.delete(terminalId); setDraft(terminalId, false) }
}

/** A paste lands in the composer too. `text` is what was pasted, when known: its last character is
 *  then the one before the cursor, and an `@` or `/` in it may open a suggestion list. */
export function notePaste(terminalId: string, text?: string): void {
  prevKey.delete(terminalId)
  unknown.delete(terminalId)
  if (text) {
    append(terminalId, text.replace(/\r\n?/g, '\n'))
    if (opensPicker(text)) pickerMaybe.add(terminalId)
  } else {
    tail.set(terminalId, UNSEEN)
  }
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
  tail.delete(terminalId)
  pickerMaybe.delete(terminalId)
  setDraft(terminalId, false)
}

/** After a reload: the lanes main last knew to have a draft. Each is flagged again and marked
 *  unknown, so deliveries to it wait as they did before the reload. Its text and any suggestion
 *  list are unknown too, so a suggestion list is taken to be open. */
export function restoreDrafts(terminalIds: Iterable<string>): void {
  for (const id of terminalIds) {
    unknown.add(id)
    tail.set(id, UNSEEN)
    pickerMaybe.add(id)
    setDraft(id, true)
  }
}

/** Called on every draft change, with the lane and whether it now has one. Returns the unsubscribe. */
export function onDraftChange(fn: (terminalId: string, on: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
