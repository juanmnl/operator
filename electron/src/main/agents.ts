// The agent library: Claude Code subagent definitions, which are Markdown files with YAML
// frontmatter in `~/.claude/agents` (user scope) and `<project>/.claude/agents` (project
// scope). Mirrors `src-tauri/src/agents.rs`.
//
// These are Claude Code's files, not Operator's — Operator is a visual editor over them. So
// the parser is forgiving (a file that isn't a valid agent is skipped, never fatal) and the
// writer only emits keys that have values, to avoid decorating a user's file with nulls.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// The renderer's own type — including the `AgentScope` union, which a local `string` widens.
import type { AgentDefinition } from '../../../src/shared/types'
export type { AgentDefinition }

const userAgentsDir = () => join(homedir(), '.claude', 'agents')

/** Split `---\n<yaml>\n---\n<body>`. Mirrors the Rust byte-for-byte, including its tolerance
 *  for CRLF and its rule that a file without frontmatter is all body. A real YAML parser does
 *  the frontmatter itself: these files are hand-written by users, and quoting, lists and
 *  multi-line scalars are exactly what a hand-rolled splitter gets wrong. */
function splitFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const rest = raw.startsWith('---\n') ? raw.slice(4) : raw.startsWith('---\r\n') ? raw.slice(5) : null
  if (rest != null) {
    const end = rest.indexOf('\n---')
    if (end >= 0) {
      let fm: Record<string, unknown> = {}
      try {
        const parsed = parseYaml(rest.slice(0, end))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>
      } catch { /* malformed frontmatter → treat as absent, same as the Rust's unwrap_or(Null) */ }
      return { fm, body: rest.slice(end + 4).replace(/^[\r\n]+/, '') }
    }
  }
  return { fm: {}, body: raw }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

async function parseAgent(path: string, scope: string, projectPath?: string): Promise<AgentDefinition | null> {
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch { return null }
  const { fm, body } = splitFrontmatter(raw)
  const name = str(fm.name)?.trim()
  // No name, no agent. This is the check that keeps a stray README.md in the folder from
  // showing up in the library as a nameless row.
  if (!name) return null

  // `tools:` is a list in some files and a comma-separated string in others; Claude Code
  // accepts both, so both are read.
  let tools: string[] | undefined
  if (Array.isArray(fm.tools)) tools = fm.tools.filter((t): t is string => typeof t === 'string')
  else if (typeof fm.tools === 'string') tools = fm.tools.split(',').map((p) => p.trim()).filter(Boolean)

  return {
    name,
    description: str(fm.description) ?? '',
    model: str(fm.model),
    tools,
    effort: str(fm.effort),
    maxTurns: typeof fm.maxTurns === 'number' ? fm.maxTurns : undefined,
    color: str(fm.color),
    prompt: body.trim(),
    scope: scope as AgentDefinition['scope'],
    projectPath,
    path,
  }
}

async function readDirAgents(dir: string, scope: string, projectPath: string | undefined, out: AgentDefinition[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await readDirAgents(p, scope, projectPath, out)
    else if (extname(e.name) === '.md') {
      const a = await parseAgent(p, scope, projectPath)
      if (a) out.push(a)
    }
  }
}

export async function listAgents(projectPath?: string): Promise<AgentDefinition[]> {
  const out: AgentDefinition[] = []
  await readDirAgents(userAgentsDir(), 'user', undefined, out)
  if (projectPath) await readDirAgents(join(projectPath, '.claude', 'agents'), 'project', projectPath, out)
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/** Filename from the agent's name: lowercase, non-alphanumerics to `-`, trimmed. Also the
 *  reason `save` takes an `originalPath` — renaming an agent changes its filename, so the old
 *  file has to be removed or the library shows both. */
function fileStem(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  return s || 'agent'
}

function serializeAgent(def: AgentDefinition): string {
  const fm: Record<string, unknown> = { name: def.name, description: def.description }
  if (def.model) fm.model = def.model
  if (def.tools?.length) fm.tools = def.tools
  if (def.effort) fm.effort = def.effort
  if (def.maxTurns != null) fm.maxTurns = def.maxTurns
  if (def.color) fm.color = def.color
  return `---\n${stringifyYaml(fm)}---\n\n${def.prompt.trim()}\n`
}

export async function saveAgent(def: AgentDefinition, originalPath?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!def.name?.trim()) return { ok: false, error: 'Agent name is required' }
  if (!def.description?.trim()) return { ok: false, error: 'Description is required' }
  let dir: string
  if (def.scope === 'project') {
    if (!def.projectPath) return { ok: false, error: 'Project path is required for a project agent' }
    dir = join(def.projectPath, '.claude', 'agents')
  } else {
    dir = userAgentsDir()
  }
  const target = join(dir, `${fileStem(def.name)}.md`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(target, serializeAgent(def), 'utf8')
  } catch (e) {
    return { ok: false, error: String(e) }
  }
  // A rename leaves the old file behind; remove it only once the new one is safely written,
  // so a failed write never costs the user the original.
  if (originalPath && resolve(originalPath) !== resolve(target)) {
    await rm(originalPath, { force: true }).catch(() => { /* already gone */ })
  }
  return { ok: true, path: target }
}

/** A missing file is SUCCESS, not an error: the caller wanted it gone and it is gone. */
export async function deleteAgent(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await rm(path, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
