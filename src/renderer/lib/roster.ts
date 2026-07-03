import type { Role } from '../../shared/types'

// The orchestration model set — Claude Code accepts each of these as a `--model` / `/model`
// alias (verified against `claude --help`: 'fable', 'opus', 'sonnet', plus 'haiku').
export const ROSTER_MODELS = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
] as const

export function modelLabel(id?: string): string {
  return ROSTER_MODELS.find((m) => m.id === id)?.label || (id ? id : '—')
}

// Sensible starting roster seeded on project creation — the user's own framing:
// Fable orchestrates, Sonnet researches, Opus writes code. Fully editable afterwards.
// (Ids are stable, human-readable, and unique within a fresh roster — safe as React keys.)
export function defaultRoster(): Role[] {
  return [
    { id: 'orchestrator', name: 'Orchestrator', model: 'fable', effort: 'normal', accent: '#c98bff' },
    { id: 'research', name: 'Research', model: 'sonnet', effort: 'high', accent: '#5ac8fa' },
    { id: 'code', name: 'Code', model: 'opus', effort: 'high', accent: '#7ee787' },
  ]
}

/** The awareness note appended to an agent's system prompt so it knows its own lane and its
 *  siblings in the project (see terminal_spawn's --append-system-prompt). */
export function orchestrationNote(projectName: string, role: Role, roster: Role[]): string {
  const siblings = roster.filter((r) => r.id !== role.id)
  const list = siblings.length
    ? siblings.map((r) => `“${r.name}” (${modelLabel(r.model)})`).join(', ')
    : 'none yet'
  return (
    `You are the “${role.name}” agent (model ${modelLabel(role.model)}) in the “${projectName}” project, ` +
    `coordinated by Operator. The project's other agent lanes are: ${list}. You may be handed tasks that ` +
    `belong to your role; stay scoped to it, and when work clearly belongs to another lane, say which one.`
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
