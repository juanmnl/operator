// Claude Code's own settings files and CLAUDE.md, at global and project scope, plus MCP server
// discovery. Mirrors `src-tauri/src/folderprefs.rs`.
//
// Operator is a VIEWER AND EDITOR over files it does not own. Two consequences run through
// everything here: a missing file is a normal state (reported as `exists: false` with empty
// content, never an error), and a write must not clobber keys Operator does not know about —
// see `saveSettings`.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const claudeDir = () => join(homedir(), '.claude')

async function readJson(path: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> } catch { return {} }
}
async function readText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

interface SettingsFile { path: string; label: string; scope: string; readOnly: boolean; exists: boolean; settings: unknown }
interface ClaudeMdFile { path: string; label: string; scope: string; exists: boolean; content: string }
export interface FolderPreferences { projectPath: string; projectName: string; settingsFiles: SettingsFile[]; mdFiles: ClaudeMdFile[] }

const sf = async (path: string, label: string, scope: string, readOnly: boolean): Promise<SettingsFile> =>
  ({ path, label, scope, readOnly, exists: existsSync(path), settings: await readJson(path) })

const md = async (path: string, label: string, scope: string): Promise<ClaudeMdFile> =>
  ({ path, label, scope, exists: existsSync(path), content: await readText(path) })

// Order matters: it is the precedence order Claude Code applies, and the UI renders it as-is.
const globalSettingsFiles = () => Promise.all([
  sf(join(claudeDir(), 'managed-settings.json'), 'Managed (Organization)', 'managed', true),
  sf(join(claudeDir(), 'settings.json'), 'Global User', 'global', false),
  sf(join(claudeDir(), 'settings.local.json'), 'Global Local', 'global-local', false),
])

const globalMdFiles = () => Promise.all([
  md(join(claudeDir(), 'CLAUDE.md'), 'Global (~/.claude/CLAUDE.md)', 'global'),
])

export async function loadGlobal(): Promise<FolderPreferences> {
  return {
    projectPath: claudeDir(),
    projectName: 'Global Claude',
    settingsFiles: await globalSettingsFiles(),
    mdFiles: await globalMdFiles(),
  }
}

export async function loadFolder(projectPath: string): Promise<FolderPreferences> {
  const settingsFiles = await globalSettingsFiles()
  settingsFiles.push(await sf(join(projectPath, '.claude', 'settings.json'), 'Project (shared)', 'project', false))
  settingsFiles.push(await sf(join(projectPath, '.claude', 'settings.local.json'), 'Project Local', 'project-local', false))

  const mdFiles = await globalMdFiles()
  mdFiles.push(await md(join(projectPath, '.claude', 'CLAUDE.md'), 'Project (.claude/CLAUDE.md)', 'project-nested'))
  mdFiles.push(await md(join(projectPath, 'CLAUDE.md'), 'Project Root (CLAUDE.md)', 'project'))

  return { projectPath, projectName: basename(projectPath) || projectPath, settingsFiles, mdFiles }
}

/** MERGE, never replace. These are the user's own Claude Code settings and they contain keys
 *  Operator has no UI for; writing the editor's view over the file would delete them. So the
 *  existing object is read, the update's top-level keys are laid over it, and the result is
 *  written back. (Top-level only, matching the Rust — a deep merge would make it impossible to
 *  REMOVE a nested key, which the settings editor needs to be able to do.) */
export async function saveSettings(path: string, updates: unknown): Promise<void> {
  const existing = existsSync(path) ? await readJson(path) : {}
  const merged = updates && typeof updates === 'object' && !Array.isArray(updates)
    ? { ...existing, ...(updates as Record<string, unknown>) }
    : updates
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}

/** Unlike the settings save, this one propagates its error: the caller is the CLAUDE.md editor
 *  and a silent failure there loses whatever the user just typed. */
export async function saveMd(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

export async function createFile(path: string, kind: 'settings' | 'md'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, kind === 'settings' ? '{}\n' : '', 'utf8')
}

export interface McpServerInfo { name: string; type: string; source: string }

function collectMcp(data: Record<string, unknown>, source: string, out: McpServerInfo[]): void {
  const map = data.mcpServers
  if (!map || typeof map !== 'object') return
  for (const [name, cfg] of Object.entries(map as Record<string, unknown>)) {
    const type = (cfg as Record<string, unknown> | null)?.type
    out.push({ name, type: typeof type === 'string' ? type : 'stdio', source })
  }
}

/** Read-only by design — Operator shows what Claude Code is configured with, it does not
 *  configure it. `claudeAiMcpEverConnected` is the cloud-connector list, which has no
 *  `mcpServers` entry and would otherwise be invisible. */
export async function getMcpServers(projectPath: string): Promise<{ servers: McpServerInfo[] }> {
  const servers: McpServerInfo[] = []
  const userJson = await readJson(join(homedir(), '.claude.json'))
  collectMcp(userJson, '~/.claude.json', servers)
  const cloud = userJson.claudeAiMcpEverConnected
  if (Array.isArray(cloud)) {
    for (const name of cloud) if (typeof name === 'string') servers.push({ name, type: 'cloud', source: 'cloud' })
  }
  collectMcp(await readJson(join(projectPath, '.mcp.json')), '.mcp.json', servers)
  return { servers }
}
