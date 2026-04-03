import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import type { ClaudeSettings, ClaudeMdFile, SettingsFile, FolderPreferences, McpServerInfo, McpServersResult } from '../shared/types'

const home = homedir()
const claudeDir = join(home, '.claude')

function readJson(path: string): ClaudeSettings {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

export function loadFolderPreferences(projectPath: string): FolderPreferences {
  const managedPath = join(claudeDir, 'managed-settings.json')
  const globalPath = join(claudeDir, 'settings.json')
  const globalLocalPath = join(claudeDir, 'settings.local.json')
  const projectSettingsPath = join(projectPath, '.claude', 'settings.json')
  const projectLocalPath = join(projectPath, '.claude', 'settings.local.json')

  const settingsFiles: SettingsFile[] = [
    {
      path: managedPath,
      label: 'Managed (Organization)',
      scope: 'managed',
      readOnly: true,
      exists: existsSync(managedPath),
      settings: readJson(managedPath),
    },
    {
      path: globalPath,
      label: 'Global User',
      scope: 'global',
      readOnly: false,
      exists: existsSync(globalPath),
      settings: readJson(globalPath),
    },
    {
      path: globalLocalPath,
      label: 'Global Local',
      scope: 'global-local',
      readOnly: false,
      exists: existsSync(globalLocalPath),
      settings: readJson(globalLocalPath),
    },
    {
      path: projectSettingsPath,
      label: 'Project (shared)',
      scope: 'project',
      readOnly: false,
      exists: existsSync(projectSettingsPath),
      settings: readJson(projectSettingsPath),
    },
    {
      path: projectLocalPath,
      label: 'Project Local',
      scope: 'project-local',
      readOnly: false,
      exists: existsSync(projectLocalPath),
      settings: readJson(projectLocalPath),
    },
  ]

  const globalMdPath = join(claudeDir, 'CLAUDE.md')
  const projectMdPath = join(projectPath, 'CLAUDE.md')
  const projectNestedMdPath = join(projectPath, '.claude', 'CLAUDE.md')

  const mdFiles: ClaudeMdFile[] = [
    {
      path: globalMdPath,
      label: 'Global (~/.claude/CLAUDE.md)',
      scope: 'global',
      exists: existsSync(globalMdPath),
      content: readText(globalMdPath),
    },
    {
      path: projectNestedMdPath,
      label: 'Project (.claude/CLAUDE.md)',
      scope: 'project-nested',
      exists: existsSync(projectNestedMdPath),
      content: readText(projectNestedMdPath),
    },
    {
      path: projectMdPath,
      label: 'Project Root (CLAUDE.md)',
      scope: 'project',
      exists: existsSync(projectMdPath),
      content: readText(projectMdPath),
    },
  ]

  return {
    projectPath,
    projectName: basename(projectPath),
    settingsFiles,
    mdFiles,
  }
}

export function saveSettingsFile(filePath: string, updates: ClaudeSettings): void {
  // Re-read and merge to avoid clobbering concurrent writes (e.g. Operator hooks)
  const existing = existsSync(filePath) ? readJson(filePath) : {}
  const merged = { ...existing, ...updates }

  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
}

export function saveMdFile(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
}

export function createFile(filePath: string, type: 'settings' | 'md'): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const content = type === 'settings' ? '{}\n' : ''
  writeFileSync(filePath, content, 'utf-8')
}

export function getMcpServers(projectPath: string): McpServersResult {
  const servers: McpServerInfo[] = []

  // Read from ~/.claude.json (user-level MCP servers)
  const userClaudeJson = join(home, '.claude.json')
  try {
    const data = JSON.parse(readFileSync(userClaudeJson, 'utf-8'))
    if (data.mcpServers && typeof data.mcpServers === 'object') {
      for (const [name, config] of Object.entries(data.mcpServers)) {
        const c = config as Record<string, unknown>
        servers.push({
          name,
          type: (c.type as 'stdio' | 'http') || 'stdio',
          source: '~/.claude.json',
        })
      }
    }
    // Cloud MCPs (claude.ai integrations)
    if (Array.isArray(data.claudeAiMcpEverConnected)) {
      for (const name of data.claudeAiMcpEverConnected) {
        servers.push({ name, type: 'cloud', source: 'cloud' })
      }
    }
  } catch {
    // No user config or parse error
  }

  // Read from project .mcp.json
  const projectMcpJson = join(projectPath, '.mcp.json')
  try {
    const data = JSON.parse(readFileSync(projectMcpJson, 'utf-8'))
    if (data.mcpServers && typeof data.mcpServers === 'object') {
      for (const [name, config] of Object.entries(data.mcpServers)) {
        const c = config as Record<string, unknown>
        servers.push({
          name,
          type: (c.type as 'stdio' | 'http') || 'stdio',
          source: '.mcp.json',
        })
      }
    }
  } catch {
    // No project MCP config
  }

  return { servers }
}
