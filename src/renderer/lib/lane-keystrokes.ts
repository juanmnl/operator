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
