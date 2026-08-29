import { buildFileHref } from './code-nav'

// TURNING A TOOL CALL INTO A FILE LINK — and what 11,707 real rows say about whether you can.
//
// `dev/results/code-navigator-design.md` §4.1 assumes the transcript's tool target is "the
// summarizer's path" and that a link can carry `:line`. I sampled `~/.operator/chat.db` before
// building on that (66,690 rows carrying a `tool` payload, 11,707 of them file tools), and both
// halves of the assumption are wrong:
//
//   Read   4,522 calls — target is an ABSOLUTE PATH in 4,513 of them (99.8%)
//   Edit   5,621 calls — target is a BARE BASENAME in 5,621 of them (100%); the full path is
//                        recoverable from the output text in 3,874 (69%)
//   Write  1,564 calls — bare basename in all; path recoverable in 943 (60%)
//
//   `:line` — ZERO occurrences, across every tool. Nothing in the transcript carries one.
//
// So: a transcript link can carry a PATH but never a LINE. That is honest and still useful —
// "open the file the agent edited" is most of the value — and a link that pretended to a line
// number would land somewhere arbitrary.
//
// AND IT ONLY LINKS WHAT IT CAN RESOLVE. A basename with no recoverable path is not made into a
// link at all: a dead link that opens "Not in this worktree" is worse than plain text, because it
// reads as the feature being broken rather than as the transcript simply not having said where.

/** Tools whose target names a file worth opening. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The absolute path inside a tool's output.
 *
 *  Edit and Write both answer with a sentence containing the full path — "The file /Users/…/x.css
 *  has been updated successfully", "File created successfully at: /Users/…/y.md". Matching the
 *  path rather than the sentence keeps this working when the wording changes, which it has.
 *
 *  Anchored on a leading `/` and an extension so it cannot match prose. Pure. */
export function pathFromOutput(output: string | undefined): string | undefined {
  if (!output) return undefined
  const m = /(\/(?:[^\s"'`<>|]+\/)*[^\s"'`<>|]+\.[A-Za-z0-9]{1,8})/.exec(output)
  return m ? m[1] : undefined
}

/** The file a tool call refers to, or undefined when the transcript did not say.
 *
 *  Order matters: an absolute TARGET is the tool's own answer and is trusted first; the output is
 *  a fallback for the tools that only ever report a basename. */
export function filePathForCall(
  call: { name?: string; target?: string; output?: string },
): string | undefined {
  if (!call.name || !FILE_TOOLS.has(call.name)) return undefined
  const target = call.target?.trim()
  // A truncated target — the summarizer ellipsises long ones — is not a path anything can open.
  if (target?.startsWith('/') && !target.includes('…')) return target
  const fromOutput = pathFromOutput(call.output)
  if (fromOutput) return fromOutput
  return undefined
}

/** The `operator://file/…` href for a tool call, or undefined when it cannot be resolved.
 *
 *  NO LINE COMPONENT, ever — see the header. The viewer opens the file at the top, which is what
 *  the transcript actually knows. */
export function fileHrefForCall(
  call: { name?: string; target?: string; output?: string },
): string | undefined {
  const path = filePathForCall(call)
  return path ? buildFileHref({ path, root: 'lane' }) : undefined
}
