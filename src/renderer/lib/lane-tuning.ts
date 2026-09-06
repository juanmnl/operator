// TUNING A LIVE LANE — the two slash commands that change a running session's model and effort,
// and the one guard on the free-typed model id.
//
// This is the seam the composer used to own. It moved to the session toolbar when the Chat view
// was removed, and it landed HERE rather than in the toolbar component because the interesting
// half is a string that goes straight into a pty, and a component is not testable in this repo.
//
// THESE BUILD THE LINE, NOT THE SUBMISSION. The trailing CR belongs to the transport —
// `submitQueue.submitTyped`, via `typedSequence` — and putting one here too is how these came to
// send `/model opus\r\r`: a second bare Return straight after the command, which is a keystroke
// into a live lane and exactly the hazard routing through the queue was meant to remove. Caught
// by QA-2 (`dev/results/qa-2-simplify-batch.md` §4), and my own test had asserted the doubled
// output rather than the intended one, which is why it survived a suite that was otherwise green.
//
// WHY TYPED AND NOT PASTED, which is the rule that still matters: Claude Code treats a line as a
// slash command only when it was TYPED. Wrapped in the bracketed-paste sequence the queue uses
// for prose, `/effort high` arrives as a message that reads "/effort high" and the lane's effort
// never changes — a failure with no error anywhere. `submitTyped` is the path that does not
// paste; it still serializes behind pastes on the same terminal, which is why these go through
// the queue at all rather than straight to `terminalWrite`.

import type { EffortLevel } from '../../shared/types'

/** `/effort <level>` — the LINE, without a terminator. Applies from the next turn. */
export function effortCommand(level: EffortLevel): string {
  return `/effort ${level}`
}

/** `/model <id>` for this lane's pty. Takes an alias (`opus`) or a full id — Claude Code
 *  resolves an alias to the current point release itself, which is why the preset list does not
 *  need updating when a tier ships a new version. */
export function modelCommand(id: string): string {
  return `/model ${id}`
}

/** Clean a hand-typed model id, or refuse it.
 *
 *  The "Other…" field exists so a tier the CLI already accepts is usable before Operator has a
 *  preset for it — which means arbitrary text reaching a pty. A CR or LF in the middle would
 *  submit the tail as its own line: `sonnet\rrm -rf .` is two commands, not one bad model id.
 *  So: collapse inner whitespace away entirely and reject anything with a control character,
 *  rather than trying to escape it. Returns null for "there is nothing here to send". */
export function normalizeModelId(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null
  if (/\s/.test(trimmed)) return null
  return trimmed
}
