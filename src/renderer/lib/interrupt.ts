import { submitQueue } from './submit-queue'

/** Claude Code's own interrupt: a bare ESC to the pty. NOT a kill — the process keeps
 *  running and the session survives; the agent just stops what it is doing and hands the
 *  turn back. Shared by the composer's stop action and the transcript's status line so the
 *  two can never diverge into different key sequences. */
export const INTERRUPT_SEQ = '\x1b'

export function interruptSession(terminalId: string | null | undefined): void {
  if (!terminalId) return
  // FIRST disarm the submit queue's pending watchdog CR for this terminal, THEN interrupt.
  // Claude Code restores the draft into the composer when interrupted, so a nudge landing
  // after the ESC re-submits that draft and the turn starts over — the user sees "stop did
  // nothing". Cancel before the ESC, so there is no window where the CR can still win.
  submitQueue.cancelNudge(terminalId)
  window.operator.terminalWrite(terminalId, INTERRUPT_SEQ)
}
