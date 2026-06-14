import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { AgentDefinition, AgentScope } from '../shared/types'

const userAgentsDir = join(homedir(), '.claude', 'agents')

function projectAgentsDir(projectPath: string): string {
  return join(projectPath, '.claude', 'agents')
}

/** Split a `.md` file into its YAML frontmatter block and the body below it. */
function splitFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { fm: {}, body: raw }
  let fm: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(match[1])
    if (parsed && typeof parsed === 'object') fm = parsed as Record<string, unknown>
  } catch {
    /* malformed frontmatter — treat as empty, keep body */
  }
  return { fm, body: match[2] ?? '' }
}

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') {
    // Tolerate comma-separated form, e.g. `tools: Read, Grep`
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean)
    return parts.length ? parts : undefined
  }
  return undefined
}

function parseAgentFile(path: string, scope: AgentScope, projectPath?: string): AgentDefinition | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const { fm, body } = splitFrontmatter(raw)
  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : null
  if (!name) return null
  return {
    name,
    description: typeof fm.description === 'string' ? fm.description : '',
    model: typeof fm.model === 'string' ? fm.model : undefined,
    tools: toStringArray(fm.tools),
    effort: typeof fm.effort === 'string' ? fm.effort : undefined,
    maxTurns: typeof fm.maxTurns === 'number' ? fm.maxTurns : undefined,
    color: typeof fm.color === 'string' ? fm.color : undefined,
    prompt: body.replace(/^\s+/, '').replace(/\s+$/, ''),
    scope,
    projectPath,
    path,
  }
}

function readDirAgents(dir: string, scope: AgentScope, projectPath?: string): AgentDefinition[] {
  if (!existsSync(dir)) return []
  const out: AgentDefinition[] = []
  // Claude Code scans recursively; mirror that so nested folders are picked up.
  const walk = (current: string) => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const agent = parseAgentFile(full, scope, projectPath)
        if (agent) out.push(agent)
      }
    }
  }
  walk(dir)
  return out
}

export function listAgents(projectPath?: string): AgentDefinition[] {
  const user = readDirAgents(userAgentsDir, 'user')
  const project = projectPath ? readDirAgents(projectAgentsDir(projectPath), 'project', projectPath) : []
  return [...user, ...project].sort((a, b) => a.name.localeCompare(b.name))
}

/** Sanitize an agent name into a safe filename stem. */
function fileStem(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

function serializeAgent(def: AgentDefinition): string {
  const fm: Record<string, unknown> = {
    name: def.name,
    description: def.description,
  }
  if (def.model) fm.model = def.model
  if (def.tools && def.tools.length) fm.tools = def.tools
  if (def.effort) fm.effort = def.effort
  if (typeof def.maxTurns === 'number' && !Number.isNaN(def.maxTurns)) fm.maxTurns = def.maxTurns
  if (def.color) fm.color = def.color
  const yaml = stringifyYaml(fm).trimEnd()
  const body = def.prompt.trim()
  return `---\n${yaml}\n---\n\n${body}\n`
}

export interface SaveAgentResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * Write an agent definition. `originalPath` is the file currently backing the
 * agent (for edits) — if the name/scope changed we rename by writing the new
 * file and removing the old one.
 */
export function saveAgent(def: AgentDefinition, originalPath?: string): SaveAgentResult {
  if (!def.name.trim()) return { ok: false, error: 'Agent name is required' }
  if (!def.description.trim()) return { ok: false, error: 'Description is required' }

  const dir = def.scope === 'project'
    ? (def.projectPath ? projectAgentsDir(def.projectPath) : null)
    : userAgentsDir
  if (!dir) return { ok: false, error: 'Project path is required for a project agent' }

  const targetPath = join(dir, `${fileStem(def.name)}.md`)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(targetPath, serializeAgent(def), 'utf-8')
    // Renamed or moved scope — clean up the previous file.
    if (originalPath && originalPath !== targetPath && existsSync(originalPath)) {
      rmSync(originalPath)
    }
    return { ok: true, path: targetPath }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function deleteAgent(path: string): { ok: boolean; error?: string } {
  try {
    if (existsSync(path)) rmSync(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
