// IS THIS PROMPT WORK? Shared by main (the transcript cancel) and the renderer (the submission
// cancel), so the two can never disagree about it.
//
// A lane that called `worktree_done` keeps an open release until it ends, and dispatch retires
// it. New WORK after the release must cancel that release, or the lane is retired with the work
// half done. But not every line that reaches a lane is work (review round 2, R2-3):
// - Operator's own notices, which all start `[Operator] `;
// - replies from other lanes, typed by the OPERATOR-REPLY path or sent over the bus by
//   `mcp__operator__reply`, which start `[Operator · reply from X] `.
// The common case is exactly the one that must not cancel: Code releases, the coordinator merges
// and says "merged, thanks". Everything else counts as work: a person typing, a dispatch (typed
// bare on the sentinel path, `[Operator · message from X] ` over the bus), and any message whose
// origin is unknown, which errs toward keeping the lane.

/** The prefix a delivered REPLY carries. Distinct from a dispatch's `[Operator · message from X] `
 *  (lib/agent-delivery `deliveryPrefix`) so the receiving side can tell the two apart. */
export function replyPrefix(fromLabel: string): string {
  return `[Operator · reply from ${fromLabel}] `
}

export const NOTICE_PREFIX = '[Operator] '

/** The message inside Claude Code's cross-session wrapper, or the text unchanged. A bus message
 *  reaches a lane as `<cross-session-message from=…>…</cross-session-message>`, in a queue record
 *  or in a user record that starts "Another Claude session sent a message:". */
export function unwrapBusMessage(text: string): string {
  const m = /<cross-session-message\b[^>]*>\s*([\s\S]*?)\s*<\/cross-session-message>/.exec(text)
  return m ? m[1] : text
}

/** False for Operator's notices and for replies; true for everything else. */
export function isWorkPrompt(text: string): boolean {
  const t = unwrapBusMessage(text).trimStart()
  return !(t.startsWith(NOTICE_PREFIX) || t.startsWith('[Operator · reply from '))
}
