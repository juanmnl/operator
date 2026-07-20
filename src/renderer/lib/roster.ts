import type { Role } from '../../shared/types'

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
export const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  orchestrator:
    'Coordinate — don’t implement. Break goals into small, verifiable tasks and hand each to the ' +
    'best-suited lane via OPERATOR-DISPATCH. Track what you delegated; when work comes back, check it ' +
    'against the goal and dispatch follow-ups for gaps. Prefer several precise dispatches over one ' +
    'vague one, and keep a running summary of who is doing what.',
  research:
    'Investigate and report — never change code. Read the relevant code end-to-end before answering; ' +
    'check docs or the web when it helps. Return compact findings: what exists today (with file:line ' +
    'pointers), constraints, options with trade-offs, and one clear recommendation. Distinguish what ' +
    'you verified from what you assume.',
  code:
    'Implement the task, nothing more. Read the surrounding code first and match its idiom — naming, ' +
    'comment density, error handling; no drive-by refactors. Run the project’s typecheck and tests ' +
    'before calling anything done, and report exactly what changed and why, plus anything you ' +
    'deliberately left out.',
  review:
    'Review adversarially — find real defects, don’t fix them unless asked. Read the full diff plus ' +
    'enough surrounding code to judge it: edge cases, races, security, regressions, misleading names. ' +
    'Rank findings by severity with file:line and a concrete failure scenario for each. If an area is ' +
    'clean, say what you checked so silence isn’t ambiguous.',
  design:
    'Own UI/UX quality. Reuse the project’s design system — its variables, spacing, and components — ' +
    'and never hardcode values that tokens already define. Propose the plan (what/where/why) before big ' +
    'visual changes; implement small polish directly. Verify both light and dark themes plus empty, ' +
    'loading, and overflow states.',
  qa:
    'Verify behavior, don’t assume it. Reproduce issues first and write down exact steps, then add ' +
    'automated tests that fail before the fix and pass after. Probe what the happy path misses: empty ' +
    'input, rapid repeats, cancellation, restart. Finish with a pass/fail rundown of everything you ' +
    'exercised and precise repros for anything broken.',
}

// Sensible starting roster seeded on project creation — the user's own framing:
// Fable orchestrates, Sonnet researches, Opus writes code. Fully editable afterwards.
// (Ids are stable, human-readable, and unique within a fresh roster — safe as React keys.)
export function defaultRoster(): Role[] {
  return [
    // Orchestrator: fast coordination. Research: strong reading, cheaper for breadth. The rest
    // pin the most capable model where quality matters most (code / review / design), Sonnet
    // for QA's higher-volume test work. All editable per project.
    { id: 'orchestrator', name: 'Orchestrator', model: 'fable', effort: 'normal', accent: '#c98bff', prompt: DEFAULT_ROLE_PROMPTS.orchestrator },
    { id: 'research', name: 'Research', model: 'sonnet', effort: 'high', accent: '#5ac8fa', prompt: DEFAULT_ROLE_PROMPTS.research },
    { id: 'code', name: 'Code', model: 'opus', effort: 'high', accent: '#7ee787', prompt: DEFAULT_ROLE_PROMPTS.code },
    { id: 'review', name: 'Review', model: 'opus', effort: 'high', accent: '#ff9f45', prompt: DEFAULT_ROLE_PROMPTS.review },
    { id: 'design', name: 'Design', model: 'opus', effort: 'normal', accent: '#ff7ac6', prompt: DEFAULT_ROLE_PROMPTS.design },
    { id: 'qa', name: 'QA', model: 'sonnet', effort: 'high', accent: '#ffd43b', prompt: DEFAULT_ROLE_PROMPTS.qa },
  ]
}

/** The awareness note appended to an agent's system prompt so it knows its own lane and its
 *  siblings in the project (see terminal_spawn's --append-system-prompt). */
export function orchestrationNote(projectName: string, role: Role, roster: Role[]): string {
  const siblings = roster.filter((r) => r.id !== role.id)
  const list = siblings.length
    ? siblings.map((r) => `"${r.name}" (id: ${r.id}, ${modelFamilyLabel(r.model)})`).join(', ')
    : 'none yet'
  // The lane's standing charter (Role.prompt) rides along so the agent knows HOW its
  // role works, not just which lane it is.
  const charter = role.prompt?.trim() ? `\nYour role charter: ${role.prompt.trim()}\n` : ''
  return (
    `You are the "${role.name}" agent (model ${modelFamilyLabel(role.model)}) in the "${projectName}" project, ` +
    `coordinated by Operator. The project's other agent lanes are: ${list}.\n` +
    charter +
    `To hand a task to another lane, output a line EXACTLY in this form, alone on its own line:\n` +
    `OPERATOR-DISPATCH [<lane-id>] <the task, one line>\n` +
    `Operator routes it to that lane — typed into it if it's running, otherwise queued for it. ` +
    `Only dispatch work that clearly belongs to another lane; do your own role's work yourself, ` +
    `and stay scoped to it when a task is handed to you.`
  )
}

/** Remove `OPERATOR-DISPATCH …` directive lines from assistant prose — they're protocol,
 *  not conversation (the dispatch log shows them); leaves surrounding text intact. */
export function stripDispatchLines(text: string): string {
  if (!text.includes('OPERATOR-DISPATCH')) return text // fast path for ~every message
  return text
    .split('\n')
    .filter((l) => !/^\s*OPERATOR-DISPATCH\s*\[/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A short, unique role id from a name (for user-added roles); falls back to a counter. */
export function roleIdFrom(name: string, existing: Role[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role'
  if (!existing.some((r) => r.id === base)) return base
  let n = 2
  while (existing.some((r) => r.id === `${base}-${n}`)) n++
  return `${base}-${n}`
}
