// TUNING A LIVE LANE — the two slash commands that change a running session's model and effort,
// and the one guard on the free-typed model id.
//
// This is the seam the composer used to own. It moved to the session toolbar when the Chat view
// was removed, and it landed HERE rather than in the toolbar component because the interesting
// half is a string that goes straight into a pty, and a component is not testable in this repo.
//
// THE COMMAND IS A BARE LINE + CR, NOT A BRACKETED PASTE. Claude Code treats a line as a slash
// command only when it was TYPED; wrapped in the bracketed-paste sequence the submit queue uses
// for prose, `/effort high` arrives as a message that reads "/effort high" and the lane's effort
// never changes — a failure with no error anywhere, which is why it gets a test rather than a
// comment. Same reason these do not go through `submitQueue`: that queue exists to keep a
// dispatch and a human prompt from merging into one turn, and it pastes.

import type { EffortLevel } from '../../shared/types'

/** `/effort <level>` for this lane's pty. Applies from the next turn. */
export function effortCommand(level: EffortLevel): string {
  return `/effort ${level}\r`
}

/** `/model <id>` for this lane's pty. Takes an alias (`opus`) or a full id — Claude Code
 *  resolves an alias to the current point release itself, which is why the preset list does not
 *  need updating when a tier ships a new version. */
export function modelCommand(id: string): string {
  return `/model ${id}\r`
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
