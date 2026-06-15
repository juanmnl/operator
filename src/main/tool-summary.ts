import { homedir } from 'os'
import type { Severity } from '../shared/types'

export interface ToolSummary {
  action: string       // human verb: "Run command", "Edit file", ...
  target?: string      // what's being acted on, short and clean
  preview?: string     // longer detail for the body
  severity: Severity
}

const HOME = homedir()

function shortPath(p: string | undefined): string | undefined {
  if (!p) return undefined
  if (p.startsWith(HOME)) return '~' + p.slice(HOME.length)
  return p
}

function basename(p: string | undefined): string | undefined {
  if (!p) return undefined
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function firstLine(s: string | undefined, max = 80): string | undefined {
  if (!s) return undefined
  const line = s.split('\n')[0].trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

function bashSeverity(command: string | undefined): Severity {
  if (!command) return 'medium'
  const c = command.toLowerCase()
  // Genuinely destructive or irreversible patterns
  if (/\brm\s+-[rf]+|\bgit\s+push\s+(-f|--force)|\bdrop\s+(table|database)|\b>\s*\/dev\//.test(c)) return 'high'
  if (/\bsudo\b|\bcurl\s+[^|]+\|\s*(sh|bash)/.test(c)) return 'high'
  // Read-ish bash (ls, cat, grep, pwd, echo) — low
  if (/^\s*(ls|cat|pwd|echo|which|whoami|date|head|tail|grep|wc|find|file|stat)\b/.test(c)) return 'low'
  return 'medium'
}

export function summarizeTool(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): ToolSummary {
  const input = toolInput || {}
  const name = toolName || 'Tool'

  switch (name) {
    case 'Bash': {
      const command = (input.command as string) || ''
      const description = (input.description as string) || ''
      return {
        action: 'Run command',
        target: firstLine(command, 100),
        preview: description || firstLine(command, 240),
        severity: bashSeverity(command),
      }
    }

    case 'Edit':
    case 'MultiEdit': {
      const path = input.file_path as string
      const edits = (input.edits as unknown[])?.length
      return {
        action: 'Edit file',
        target: basename(path),
        preview: edits ? `${edits} changes in ${shortPath(path)}` : shortPath(path),
        severity: 'medium',
      }
    }

    case 'Write': {
      const path = input.file_path as string
      const content = input.content as string
      const lines = content ? content.split('\n').length : undefined
      return {
        action: 'Write file',
        target: basename(path),
        preview: lines ? `${lines} lines → ${shortPath(path)}` : shortPath(path),
        severity: 'high',
      }
    }

    case 'NotebookEdit': {
      const path = (input.notebook_path as string) || (input.file_path as string)
      const cellType = input.cell_type as string
      return {
        action: 'Edit notebook',
        target: basename(path),
        preview: cellType ? `${cellType} cell in ${shortPath(path)}` : shortPath(path),
        severity: 'medium',
      }
    }

    case 'WebFetch': {
      const url = input.url as string
      let host: string | undefined
      try { host = url ? new URL(url).hostname : undefined } catch { /* noop */ }
      return {
        action: 'Fetch URL',
        target: host || url,
        preview: firstLine(input.prompt as string, 200),
        severity: 'low',
      }
    }

    case 'WebSearch': {
      const query = input.query as string
      return {
        action: 'Search the web',
        target: firstLine(query, 100),
        severity: 'low',
      }
    }

    case 'Task':
    case 'Agent': {
      // Subagent dispatch — tool_input carries the subagent type + a description/prompt.
      const subagentType = (input.subagent_type as string) || (input.agent_type as string) || 'agent'
      const description = (input.description as string) || (input.prompt as string)
      return {
        action: 'Delegate',
        target: subagentType,
        preview: firstLine(description, 200),
        severity: 'medium',
      }
    }

    default: {
      // MCP server tools: mcp__<server>__<tool>
      if (name.startsWith('mcp__')) {
        const parts = name.slice(5).split('__')
        const server = parts[0]
        const tool = parts.slice(1).join(' ') || ''
        return {
          action: `MCP: ${tool || server}`,
          target: server,
          preview: firstLine(JSON.stringify(input), 200),
          severity: 'high',
        }
      }
      // Generic fallback
      const target = (input.file_path as string)
        || (input.command as string)
        || (input.path as string)
        || (input.pattern as string)
        || (input.description as string)
        || (input.prompt as string)
      return {
        action: `Use ${name}`,
        target: firstLine(target, 100),
        severity: 'low',
      }
    }
  }
}

// One-line phrasing for the notification / inline bar headline.
// e.g. "Claude wants to run a command", "Claude wants to edit ~/foo.ts"
export function summaryMessage(summary: ToolSummary): string {
  const verb = summary.action.toLowerCase()
  return summary.target ? `Claude wants to ${verb}: ${summary.target}` : `Claude wants to ${verb}`
}
