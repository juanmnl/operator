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
// this is judged from the keys: a printable key or a paste starts a draft, Enter or Ctrl+C ends it.
// A draft deleted with Backspace still reads as a draft. That errs toward keeping a lane running.

const drafts = new Set<string>()

/** What one keydown does to the composer, as far as the key alone can tell. Pure. */
export function draftEffect(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): 'draft' | 'clear' | null {
  if (e.key === 'Enter') return e.shiftKey || e.altKey ? 'draft' : 'clear'
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) return 'clear'
  if (e.metaKey && (e.key === 'v' || e.key === 'V')) return 'draft'
  if (e.metaKey || e.ctrlKey) return null
  return e.key.length === 1 ? 'draft' : null
}

export function noteDraftKey(terminalId: string, e: Parameters<typeof draftEffect>[0]): void {
  const effect = draftEffect(e)
  if (effect === 'draft') drafts.add(terminalId)
  else if (effect === 'clear') drafts.delete(terminalId)
}

/** A paste lands in the composer too. */
export function notePaste(terminalId: string): void {
  drafts.add(terminalId)
}

/** Has someone typed into this lane's composer without sending it? */
export function hasUnsentInput(terminalId: string): boolean {
  return drafts.has(terminalId)
}
