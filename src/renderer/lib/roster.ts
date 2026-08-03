import type { Project, Role } from '../../shared/types'
import { reorderByIds } from './reorder'

// The orchestration model set — Claude Code accepts each of these as a `--model` / `/model`
// alias (verified against `claude --help`: 'fable', 'opus', 'sonnet', plus 'haiku').
export const ROSTER_MODELS = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
] as const

/** Family label ("Opus"/"Sonnet"/…) for a model alias OR a full transcript id. Distinct
 *  from lib/format's modelLabel, which renders the id-style label for the usage view. */
export function modelFamilyLabel(id?: string): string {
  if (!id) return '—'
  const alias = ROSTER_MODELS.find((m) => m.id === id)
  if (alias) return alias.label
  // Full model ids (e.g. "claude-opus-4-20250514", from the transcript) → family label.
  const l = id.toLowerCase()
  if (l.includes('opus')) return 'Opus'
  if (l.includes('sonnet')) return 'Sonnet'
  if (l.includes('haiku')) return 'Haiku'
  if (l.includes('fable')) return 'Fable'
  return id
}

// The standing charter each default lane launches with (appended to its system prompt).
// Written to be terse, method-first, and to keep lanes in their own swimlane — the
// orchestrationNote below already teaches the dispatch mechanics. Editable per project.
// The coordinating lane IS the app: it's called "Operator" because that's what it does —
// operate the roster. `operator` is the canonical id; `orchestrator` stays keyed to the
// same charter so rosters seeded before the rename still backfill (see isCoordinator).
export const COORDINATOR_IDS = ['operator', 'orchestrator'] as const
export function isCoordinator(id: string): boolean {
  return (COORDINATOR_IDS as readonly string[]).includes(id)
}

/** Map a legacy 'orchestrator' role id to the canonical 'operator'; anything else passes through. */
export function migrateLegacyRoleId(id: string | undefined): string | undefined {
  return id === 'orchestrator' ? 'operator' : id
}

/** Migrate a project persisted before the Orchestrator→Operator rename: the coordinator
 *  lane's id becomes 'operator' (and its stock display name "Orchestrator" becomes
 *  "Operator" — a user-customized name is kept), and every stored reference to the old
 *  id (task assignments, dispatch log) is remapped so history still resolves. A project
 *  that never had the legacy id is returned unchanged (same reference). */
export function migrateLegacyCoordinator(p: Project): Project {
  const legacyRole = p.roster?.some((r) => r.id === 'orchestrator')
  const legacyTask = p.tasks?.some((t) => t.roleId === 'orchestrator')
  const legacyDispatch = p.dispatches?.some((d) => d.fromRoleId === 'orchestrator' || d.toRoleId === 'orchestrator')
  if (!legacyRole && !legacyTask && !legacyDispatch) return p
  // Degenerate pre+post-rename mix (both ids present): leave ids alone — rewriting would
  // collide two distinct lanes; only the stock display name is refreshed.
  const collision = legacyRole && p.roster!.some((r) => r.id === 'operator')
  const next: Project = { ...p }
  if (legacyRole) {
    next.roster = p.roster!.map((r) => {
      if (r.id !== 'orchestrator') return r
      return {
        ...r,
        id: collision ? r.id : 'operator',
        name: r.name === 'Orchestrator' ? 'Operator' : r.name,
      }
    })
  }
  if (!collision) {
    if (legacyTask) next.tasks = p.tasks!.map((t) => (t.roleId === 'orchestrator' ? { ...t, roleId: 'operator' } : t))
    if (legacyDispatch) {
      next.dispatches = p.dispatches!.map((d) =>
        d.fromRoleId === 'orchestrator' || d.toRoleId === 'orchestrator'
          ? { ...d, fromRoleId: migrateLegacyRoleId(d.fromRoleId), toRoleId: migrateLegacyRoleId(d.toRoleId) }
          : d,
      )
    }
  }
  return next
}

// `roleLaunchSettings` used to live here, resolving effort + permission mode against
// `Project.defaults`. It has been FOLDED INTO `resolveAgentConfig` (lib/model-config): it was a
// second place answering the same question, and once a global per-role layer exists a second answer
// is a divergence waiting to happen. Import the resolver instead — it is deliberately the only
// thing that decides a launch's model, effort, permission mode or worktree posture.

const OPERATOR_CHARTER =
  'You are Operator — you operate this project. Know the team (the lanes below), and route each ' +
  'task to the best-suited one via OPERATOR-DISPATCH — several precise dispatches beat one vague ' +
  'one. Track who has what, and check returned work against the goal. If no lane fits a task, or the ' +
  'right one isn’t available, do it yourself rather than forcing a bad fit.'

/** The RETURN path, appended to every lane's orchestration note — coordinator included.
 *
 *  It exists in the parser (transcript.rs), the store (chat.db `replies`) and — until the channel
 *  was deleted — a view. This is the half that tells a lane the sentinel is there at all.
 *
 *  ADDRESSED ONLY, as of the channel's deletion. The sentinel takes a target, and `project` used
 *  to mean "the room": a broadcast, rendered in the channel feed and delivered to nobody by
 *  design (DashboardView returns early on `to === 'project'`). With the channel gone a broadcast
 *  is still parsed and still written to chat.db, and displayed NOWHERE — a lane would be told to
 *  announce itself into a void. So the protocol no longer offers it, and every reply names a
 *  lane, which is the form that actually reaches someone.
 *
 *  Two things it must be honest about, or a lane will believe it is having a conversation: a
 *  reply may be held (the brakes are real and it will not be told), and it does NOT stand in for
 *  a result file.
 *
 *  The WHEN matters more than the HOW. "Post your progress" produces narration, and narration
 *  addressed to a specific lane is worse than narration to a room — it interrupts someone. So the
 *  trigger is scoped to the three moments that carry information the recipient doesn't have, with
 *  the anti-cases named explicitly because models default to announcing themselves. */
const REPLY_PROTOCOL =
  `To send a line to another lane, output it EXACTLY in this form, alone on its own line:\n` +
  `OPERATOR-REPLY [<lane-id>] <one line>\n` +
  `Address a SPECIFIC lane by its id. It is typed into that lane's session, so it interrupts a ` +
  `working agent — which is why it is worth doing only when the message changes what that lane ` +
  `should do next. Delivery is not guaranteed: it is dropped if the lane isn't running, and ` +
  `rate-limited if the two of you are going back and forth, with no notice to you either way. It ` +
  `does NOT replace a result file: if your brief names an output path, write that file. The reply ` +
  `is the headline; the file is the work.\n` +
  `Send only when that lane needs to know something: a task it is waiting on is FINISHED (one ` +
  `line — what landed, and where the detail is), you are BLOCKED on something that belongs to ` +
  `it, or you found something that CHANGES its work. Do not narrate: no "starting now", no ` +
  `step-by-step, no thinking aloud, no restating the task. One line, and only when it earns one.`

/** Appended to every NON-coordinator charter — EXPORTED because the one-time seeded-lane prune
 *  (lib/prune-seeded-lanes) has to recognise the charter as it read *before* this clause was
 *  appended, and deriving that by stripping the suffix beats freezing a second copy of six
 *  paragraphs. The belt to the router's braces: the enforcement
 *  that matters is `dispatchNeedsApproval` (lib/dispatch), because charter text is advisory and
 *  models route around it — Research's charter already said "never change code" and it obeyed
 *  that literally, then wrote an implementation brief and dispatched Code to build it. Saying the
 *  boundary out loud is still worth it: a lane that knows the rule recommends instead of
 *  commissioning, and never waits on a dispatch that was never going to auto-deliver. */
export const NO_COMMISSIONING = ' You do not commission work. If you conclude something should be built, ' +
  'recommend it in your report and name who should do it — the coordinator decides. Do not ' +
  'dispatch implementation tasks; a dispatch from a non-coordinator lane is held for the user to ' +
  'approve, so it will not run on its own.'

export const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  operator: OPERATOR_CHARTER,
  orchestrator: OPERATOR_CHARTER, // legacy id → same charter (pre-rename rosters)
  research:
    'Investigate and report — never change code. Read the relevant code end-to-end before answering; ' +
    'check docs or the web when it helps. Return compact findings: what exists today (with file:line ' +
    'pointers), constraints, options with trade-offs, and one clear recommendation. Distinguish what ' +
    'you verified from what you assume.' + NO_COMMISSIONING,
  code:
    'Implement the task, nothing more. Read the surrounding code first and match its idiom — naming, ' +
    'comment density, error handling; no drive-by refactors. Run the project’s typecheck and tests ' +
    'before calling anything done, and report exactly what changed and why, plus anything you ' +
    'deliberately left out.' + NO_COMMISSIONING,
  review:
    'Review adversarially — find real defects, don’t fix them unless asked. Read the full diff plus ' +
    'enough surrounding code to judge it: edge cases, races, security, regressions, misleading names. ' +
    'Rank findings by severity with file:line and a concrete failure scenario for each. If an area is ' +
    'clean, say what you checked so silence isn’t ambiguous.' + NO_COMMISSIONING,
  design:
    'Own UI/UX quality. Reuse the project’s design system — its variables, spacing, and components — ' +
    'and never hardcode values that tokens already define. Propose the plan (what/where/why) before big ' +
    'visual changes; implement small polish directly. Verify both light and dark themes plus empty, ' +
    'loading, and overflow states.' + NO_COMMISSIONING,
  qa:
    'Verify behavior, don’t assume it. Reproduce issues first and write down exact steps, then add ' +
    'automated tests that fail before the fix and pass after. Probe what the happy path misses: empty ' +
    'input, rapid repeats, cancellation, restart. Finish with a pass/fail rundown of everything you ' +
    'exercised and precise repros for anything broken.' + NO_COMMISSIONING,
}

// Sensible starting roster seeded on project creation — the user's own framing:
// Fable orchestrates, Sonnet researches, Opus writes code. Fully editable afterwards.
// (Ids are stable, human-readable, and unique within a fresh roster — safe as React keys.)
/** The six lane TEMPLATES. These are good defaults — tuned model, effort, accent and charter
 *  per role — and they remain exactly that: templates. Nothing seeds them into a project any
 *  more (2026-07-28: a new project arrives with an EMPTY roster and grows on demand), so this
 *  is the menu behind "+ Add agent" and the source a dispatch creates a lane from. */
export function rolePresets(): Role[] {
  return [
    // Orchestrator: fast coordination. Research: strong reading, cheaper for breadth. The rest
    // pin the most capable model where quality matters most (code / review / design), Sonnet
    // for QA's higher-volume test work. All editable per project.
    //
    // `useWorktree` lives HERE as of the one-altitude collapse. It used to be the one field the
    // deleted global tier seeded, which meant the preset — now the only default layer — had no
    // opinion on it at all, and every unpinned lane would have fallen through to the hard
    // fallback (off). These are the values that seed shipped: lanes that WRITE get isolation, so
    // their diffs are attributable and two of them can't collide in one checkout. Review and QA
    // read and verify, so they stay in the main checkout where the work actually is.
    { id: 'operator', name: 'Operator', model: 'fable', effort: 'normal', useWorktree: true, accent: '#c98bff', prompt: DEFAULT_ROLE_PROMPTS.operator },
    { id: 'research', name: 'Research', model: 'sonnet', effort: 'high', useWorktree: true, accent: '#5ac8fa', prompt: DEFAULT_ROLE_PROMPTS.research },
    { id: 'code', name: 'Code', model: 'opus', effort: 'high', useWorktree: true, accent: '#7ee787', prompt: DEFAULT_ROLE_PROMPTS.code },
    { id: 'review', name: 'Review', model: 'opus', effort: 'high', useWorktree: false, accent: '#ff9f45', prompt: DEFAULT_ROLE_PROMPTS.review },
    { id: 'design', name: 'Design', model: 'opus', effort: 'normal', useWorktree: true, accent: '#ff7ac6', prompt: DEFAULT_ROLE_PROMPTS.design },
    { id: 'qa', name: 'QA', model: 'sonnet', effort: 'high', useWorktree: false, accent: '#ffd43b', prompt: DEFAULT_ROLE_PROMPTS.qa },
  ]
}

/** The full preset set as a roster. NOT used for seeding — kept because the lane-accent
 *  palette and the roster tests both want the canonical six in order. */
export function defaultRoster(): Role[] {
  return rolePresets()
}

/** A preset matching a dispatch token — by id or by name, case-insensitively, the same way
 *  `routeDispatch` matches real lanes. Returns a fresh copy, so a created lane can be edited
 *  without mutating the template. `undefined` for anything that isn't one of the six: a typo
 *  like `[cod]` must NOT invent a junk lane. */
export function presetFor(token: string): Role | undefined {
  const t = token.trim().toLowerCase()
  const hit = rolePresets().find((r) => r.id.toLowerCase() === t || r.name.toLowerCase() === t)
  return hit ? { ...hit } : undefined
}

/** One roster line for the coordinator's team list: identity + what the lane is for
 *  (first sentence of its charter), so Operator can route by purpose, not just by name. */
/** A lane's model for PROSE (the coordinator's team list). `Role.model` is optional now, so an
 *  inherited lane would read "—" without falling through to its preset — telling the coordinator a
 *  teammate has no model. The global layer isn't reachable from here, and doesn't need to be: this
 *  is a description of capability, not a launch decision. */
function laneModel(r: Role): string {
  return modelFamilyLabel(r.model ?? rolePresets().find((p) => p.id === r.id)?.model)
}

function laneSummary(r: Role): string {
  const purpose = r.prompt?.trim().split(/(?<=[.!?])\s/)[0]?.slice(0, 90)
  return `"${r.name}" (id: ${r.id}, ${laneModel(r)})${purpose ? ` — ${purpose}` : ''}`
}

/** The awareness note appended to an agent's system prompt so it knows its own lane and its
 *  siblings in the project (see terminal_spawn's --append-system-prompt).
 *
 *  The COORDINATOR lane is the app itself — "Operator" — so its note is self-referential:
 *  it's told it IS Operator, given the project's team with each lane's purpose, and told to
 *  dispatch to the best fit OR do the work itself when none fits. Worker lanes get the
 *  simpler "you are lane X, operated by Operator" framing. */
export function orchestrationNote(projectName: string, role: Role, roster: Role[]): string {
  const siblings = roster.filter((r) => r.id !== role.id)
  // The lane's standing charter (Role.prompt) rides along so the agent knows HOW its
  // role works, not just which lane it is.
  const charter = role.prompt?.trim() ? `\nYour role charter: ${role.prompt.trim()}\n` : ''

  if (isCoordinator(role.id)) {
    const team = siblings.length
      ? siblings.map((r) => `  • ${laneSummary(r)}`).join('\n')
      : '  (no other lanes yet — you’ll be doing the work yourself)'
    return (
      `You are Operator — you operate the "${projectName}" project. "Operator" is this app; ` +
      `you are its operating agent, not a separate service.\n` +
      `Your team for this project — the lanes you can delegate to:\n${team}\n` +
      charter +
      `Delegate a task by outputting a line EXACTLY in this form, alone on its own line:\n` +
      `OPERATOR-DISPATCH [<lane-id>] <the task, one line>\n` +
      `It's typed into that lane if it's running; if the lane is idle, Operator LAUNCHES it ` +
      `with your task as its opening brief — either way the work starts, and Operator notes ` +
      `back to you how each dispatch landed. If no lane fits a task, just do it yourself ` +
      `rather than forcing a poor fit.\n` +
      REPLY_PROTOCOL
    )
  }

  const list = siblings.length
    ? siblings.map((r) => `"${r.name}" (id: ${r.id}, ${laneModel(r)})`).join(', ')
    : 'none yet'
  return (
    `You are the "${role.name}" agent (model ${modelFamilyLabel(role.model)}) in the "${projectName}" project, ` +
    `operated by Operator. The project's other agent lanes are: ${list}.\n` +
    charter +
    `A dispatch to another lane takes this form, alone on its own line:\n` +
    `OPERATOR-DISPATCH [<lane-id>] <the task, one line>\n` +
    // Corrected when the authority gate shipped: this used to promise "typed into it if it's
    // running", which is now only true for the coordinator. A lane told its dispatch delivers
    // will sit waiting on work that was held — and NO_COMMISSIONING in its charter already says
    // the rule, so the note contradicting it was the worst of both.
    `but a dispatch from your lane is HELD for the user to approve — Operator does not deliver ` +
    `it on its own. So don't plan around it: recommend the work to the coordinator instead, do ` +
    `your own role's work yourself, and stay scoped to it when a task is handed to you.\n` +
    REPLY_PROTOCOL
  )
}

/** Remove `OPERATOR-DISPATCH …` / `OPERATOR-REPLY …` directive lines from assistant prose —
 *  they're protocol, not conversation (the Team screen's dispatch log shows them);
 *  leaves surrounding text intact. Tolerates markdown decoration around the directive
 *  (bullets, numbering, bold/backticks) to mirror the Rust parser (transcript.rs
 *  `parse_directives`, which both sentinels share) — keep the two in sync.
 *
 *  STRIP EXACTLY WHAT FIRES, NOTHING MORE. The Rust parser now ignores directives inside a
 *  fenced block, indented 4+ spaces, or blockquoted — they're QUOTED, not authored, and firing
 *  them let text a lane merely read commission real work. This must match: a quoted directive
 *  is ordinary content the reader should SEE. Hiding it was its own bug — a burst of dispatches
 *  with the prose that caused them stripped out of the view is unexplainable from the UI. */
const DIRECTIVE_LINE = /^\s*(?:(?:[-*•]|\d+[.)])\s+|[`*_]+)*OPERATOR-(?:DISPATCH|REPLY)\s*\[/
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/
export function stripDispatchLines(text: string): string {
  // Fast path for ~every message.
  if (!text.includes('OPERATOR-DISPATCH') && !text.includes('OPERATOR-REPLY')) return text
  let fence: string | null = null
  return text
    .split('\n')
    .filter((l) => {
      const f = FENCE_LINE.exec(l)
      if (f) {
        const marker = f[0].trim()[0]
        fence = fence === null ? marker : fence === marker ? null : fence
        return true // the fence line itself is content
      }
      if (fence !== null) return true // inside a fence — quoted, keep it visible
      if (l.startsWith('    ') || l.startsWith('\t')) return true // indented code
      return !DIRECTIVE_LINE.test(l)
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Move the role `dragId` to sit before/after `targetId`, returning a new array.
 *  Order is the roster's own — it drives the board, the ⌘K launch list, and which lane
 *  reads as the project's lead — so it's worth letting the user arrange it. Returns the
 *  input unchanged when the move is a no-op or either id is unknown. */
export function reorderRoles(roles: Role[], dragId: string, targetId: string, edge: 'before' | 'after'): Role[] {
  return reorderByIds(roles, dragId, targetId, edge)
}

/** Apply a partial edit to one lane, returning the new roster. Unknown id → unchanged.
 *
 *  Pure, and taking the roster as an argument, precisely so callers can apply it to the
 *  CURRENT project rather than to the snapshot they rendered with: building the next roster
 *  from a stale props copy meant two quick edits (recolour a lane, then rename another
 *  before the first render landed) both started from the same old array, and the second
 *  silently reverted the first. */
export function patchRoleIn(roster: Role[] | undefined, id: string, patch: Partial<Role>): Role[] {
  return (roster ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r))
}

/** Remove a lane and unassign its queued tasks, against the CURRENT project — same
 *  stale-snapshot hazard as `patchRoleIn`. Returns the patch to apply. */
export function removeRoleFrom(project: Project, id: string): Pick<Project, 'roster' | 'tasks'> {
  return {
    roster: (project.roster ?? []).filter((r) => r.id !== id),
    tasks: (project.tasks ?? []).map((t) => (t.roleId === id ? { ...t, roleId: undefined } : t)),
  }
}

/** A short, unique role id from a name (for user-added roles); falls back to a counter. */
export function roleIdFrom(name: string, existing: Role[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role'
  if (!existing.some((r) => r.id === base)) return base
  let n = 2
  while (existing.some((r) => r.id === `${base}-${n}`)) n++
  return `${base}-${n}`
}
