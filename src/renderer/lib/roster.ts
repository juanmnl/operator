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

// Sensible starting roster seeded on project creation — the user's own framing:
// Fable orchestrates, Sonnet researches, Opus writes code. Fully editable afterwards.
// (Ids are stable, human-readable, and unique within a fresh roster — safe as React keys.)
export function defaultRoster(): Role[] {
  return [
    // Orchestrator: fast coordination. Research: strong reading, cheaper for breadth. The rest
    // pin the most capable model where quality matters most (code / review / design), Sonnet
    // for QA's higher-volume test work. All editable per project.
    { id: 'orchestrator', name: 'Orchestrator', model: 'fable', effort: 'normal', accent: '#c98bff' },
    { id: 'research', name: 'Research', model: 'sonnet', effort: 'high', accent: '#5ac8fa' },
    { id: 'code', name: 'Code', model: 'opus', effort: 'high', accent: '#7ee787' },
    { id: 'review', name: 'Review', model: 'opus', effort: 'high', accent: '#ff9f45' },
    { id: 'design', name: 'Design', model: 'opus', effort: 'normal', accent: '#ff7ac6' },
    { id: 'qa', name: 'QA', model: 'sonnet', effort: 'high', accent: '#ffd43b' },
  ]
}

/** The awareness note appended to an agent's system prompt so it knows its own lane and its
 *  siblings in the project (see terminal_spawn's --append-system-prompt). */
export function orchestrationNote(projectName: string, role: Role, roster: Role[]): string {
  const siblings = roster.filter((r) => r.id !== role.id)
  const list = siblings.length
    ? siblings.map((r) => `"${r.name}" (id: ${r.id}, ${modelFamilyLabel(r.model)})`).join(', ')
    : 'none yet'
  return (
    `You are the "${role.name}" agent (model ${modelFamilyLabel(role.model)}) in the "${projectName}" project, ` +
    `coordinated by Operator. The project's other agent lanes are: ${list}.\n` +
    `To hand a task to another lane, output a line EXACTLY in this form, alone on its own line:\n` +
    `OPERATOR-DISPATCH [<lane-id>] <the task, one line>\n` +
    `Operator routes it to that lane — typed into it if it's running, otherwise queued for it. ` +
    `Only dispatch work that clearly belongs to another lane; do your own role's work yourself, ` +
    `and stay scoped to it when a task is handed to you.`
  )
}

/** A short, unique role id from a name (for user-added roles); falls back to a counter. */
export function roleIdFrom(name: string, existing: Role[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role'
  if (!existing.some((r) => r.id === base)) return base
  let n = 2
  while (existing.some((r) => r.id === `${base}-${n}`)) n++
  return `${base}-${n}`
}
