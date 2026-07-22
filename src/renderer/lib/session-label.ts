import type { AgentSession, Role } from '../../shared/types'
import { isInjectedTurn } from './format'
import { modelFamilyLabel } from './roster'

// Operator prepends a dev-server instruction to a lane's opening prompt (see
// handleLaunchSession's devInstr) and the transcript summarises a session by its FIRST
// prompt — so every "launch with dev server" agent summarised identically, which is why
// the dashboard read as N copies of the same row. Strip that leading paragraph and keep
// the real task under it. Both wordings are listed because old transcripts keep the old
// text forever; if devInstr is reworded again, add the new opening here.
const DEV_SERVER_PREFIXES = [
  "First, start this project's dev server",
  "First, make sure this project's dev server",
]

/** The session's own first prompt, or undefined when it carries no usable text.
 *  Two things masquerade as the prompt: Claude Code's injected plumbing turns
 *  (`<local-command-*>`, `<system-reminder>`, …) and Operator's dev-server preamble.
 *  A summary that is ONLY the preamble yields undefined, so callers fall through to
 *  the next rung of the label ladder rather than showing boilerplate. */
export function cleanSessionSummary(summary?: string): string | undefined {
  if (!summary || isInjectedTurn(summary)) return undefined
  let text = summary.trim()
  // The preamble is joined to the real task with a blank line (see the `initial` join).
  while (DEV_SERVER_PREFIXES.some((p) => text.startsWith(p))) {
    const brk = text.search(/\n\s*\n/)
    if (brk < 0) return undefined // preamble only (or truncated mid-preamble) — nothing real left
    text = text.slice(brk).trim()
  }
  return text || undefined
}

/** Who this agent IS, in one line — the single label ladder shared by the sidebar, the
 *  collapsed rail, and the Activity Dashboard: a user rename wins, then the lane it was
 *  launched on, then its own first prompt, then the model it runs, then `fallback`.
 *
 *  It lives here because three surfaces naming the same agent by three different rules
 *  is how one lane read as "Code" in the sidebar and as a truncated prompt on the
 *  dashboard. Whether the result IS the lane name (and so takes the role's colour) is
 *  just `!!role` at the call site. */
export function sessionLabel({ session, role, customName, fallback = 'Session' }: {
  session: AgentSession
  /** The lane this session was launched on, resolved from the project's roster. */
  role?: Role
  customName?: string
  /** Last resort when nothing else identifies the session (e.g. "Session 2"). */
  fallback?: string
}): string {
  if (customName) return customName
  if (role?.name) return role.name
  const summary = cleanSessionSummary(session.summary)
  if (summary) return summary
  // '<synthetic>' is Claude Code's API-error placeholder — never a display name.
  const model = session.model && !session.model.startsWith('<') ? modelFamilyLabel(session.model) : undefined
  return model || fallback
}
