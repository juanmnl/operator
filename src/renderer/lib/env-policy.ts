// Which environment variable names Operator refuses, and — the part that matters — WHY.
//
// S2 of `dev/results/session-settings-design.md`. There are two distinct reasons a name is
// denied and the UI must say which, because they lead the user to different next actions:
//
//   "Operator manages this."   → your value would be overwritten, or would break a lane.
//   "Claude Code ignores this." → your value would be accepted here and silently do nothing.
//
// A single "not allowed" message collapses those into one shrug. The second is the worse one to
// get wrong: a user who sets `CLAUDE_CODE_ENTRYPOINT` and sees it accepted will spend real time
// wondering why nothing changed.
//
// Pure and dependency-free so both surfaces (project settings, and later the launch sheet) ask
// exactly the same question and cannot drift into two answers.

export type DenyReason = 'operator-manages' | 'claude-ignores'

export interface Denial {
  reason: DenyReason
  /** The sentence to show. Written here, not at the call site, so both surfaces say it the same
   *  way and a copy change lands in one place. */
  message: string
}

/** Names Operator sets on every lane itself. Setting them here would either be overwritten at
 *  spawn (confusing) or actually break something (the port, which is per-lane by design). */
const OPERATOR_MANAGED = new Set([
  // `terminals.ts` reserves one port per lane and passes it as both. Pinning it in project
  // config gives every lane the same port, which is the exact collision the reservation exists
  // to prevent.
  'PORT',
  'OPERATOR_DEV_PORT',
  'OPERATOR_TERMINAL_ID',
  'OPERATOR_APP_PID',
  // Terminal capability, set to match the pty Operator actually opened. A value that disagrees
  // with the real terminal gets tool output coloured against the wrong assumptions.
  'TERM',
  'FORCE_COLOR',
  'COLORTERM',
  'COLORFGBG',
  'TERM_PROGRAM',
])

/** The nested-session markers `stripNestedSessionEnv` removes at spawn, plus the family prefix.
 *  Claude Code reads these from its own launch context; a value set here is discarded. */
const CLAUDE_EXACT = new Set(['CLAUDECODE'])
const CLAUDE_PREFIX = 'CLAUDE_CODE_'

/** Is this name usable as an environment variable at all?
 *
 *  POSIX says a name is letters, digits and underscores, not starting with a digit. Anything
 *  else cannot be exported by a shell, so accepting it would write a row into `projects.json`
 *  that can never take effect. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** `null` when the name is allowed. */
export function denyReason(name: string): Denial | null {
  const upper = name.trim()
  if (!upper) return null
  if (OPERATOR_MANAGED.has(upper)) {
    return {
      reason: 'operator-manages',
      message: `Operator manages ${upper}. It sets this on every lane it launches, so a value here would be replaced at spawn.`,
    }
  }
  if (CLAUDE_EXACT.has(upper) || upper.startsWith(CLAUDE_PREFIX)) {
    return {
      reason: 'claude-ignores',
      message: `Claude Code ignores ${upper}. It reads this from its own launch context, so a value here would be accepted and then silently do nothing.`,
    }
  }
  return null
}

/** The one call a form makes: everything wrong with this name, in the order worth showing.
 *
 *  Validity is checked BEFORE the denylist because "that isn't a variable name" is the more
 *  fundamental complaint, and telling someone Operator manages `MY-VAR` when the real problem is
 *  the hyphen would send them looking in the wrong place. */
export function validateEnvName(name: string, existing: readonly string[] = []): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'A name is required.'
  if (!isValidEnvName(trimmed)) {
    return 'Letters, digits and underscores only, and not starting with a digit — that is all a shell can export.'
  }
  const denial = denyReason(trimmed)
  if (denial) return denial.message
  if (existing.some((e) => e === trimmed)) return 'Already set above — the last one wins.'
  return null
}
