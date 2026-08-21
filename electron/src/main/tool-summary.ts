// How a tool call is NAMED. Ported from `summarize` in `src-tauri/src/core.rs`.
//
// One summarizer, two surfaces: the activity timeline and the chat transcript both render a
// call through this, which is what makes them name the same call identically. That shared-ness
// is the reason it is its own module rather than an inline switch.
export interface ToolSummary { action: string; target?: string; preview?: string; severity: string }

const strField = (input: unknown, key: string): string | undefined => {
  if (!input || typeof input !== 'object') return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

export function firstLine(s: string, max: number): string {
  const line = s.split('\n')[0] ?? ''
  return [...line].length > max ? `${[...line].slice(0, max).join('')}…` : line
}

const basename = (p: string) => p.split('/').pop() || p

/** Commands worth flagging louder in the timeline. Deliberately coarse — this colours a row,
 *  it does not gate anything, so a false "high" costs attention and a false "low" costs
 *  nothing that another control was relying on. */
function bashSeverity(command: string): string {
  if (/\brm\s+-[rf]|\bgit\s+push\b|\bsudo\b|\bcurl\b.*\|\s*(sh|bash)/.test(command)) return 'high'
  if (/\bgit\s+(commit|merge|checkout|reset)\b|\bnpm\s+(install|publish)\b/.test(command)) return 'medium'
  return 'low'
}

export function summarize(name: string, input: unknown): ToolSummary {
  switch (name) {
    case 'Bash': {
      const command = strField(input, 'command') ?? ''
      return {
        action: 'Run command',
        target: firstLine(command, 100),
        preview: strField(input, 'description') ?? firstLine(command, 240),
        severity: bashSeverity(command),
      }
    }
    case 'Edit':
    case 'MultiEdit': {
      const p = strField(input, 'file_path')
      return { action: 'Edit file', target: p ? basename(p) : undefined, preview: p, severity: 'medium' }
    }
    case 'Write': {
      const p = strField(input, 'file_path')
      return { action: 'Write file', target: p ? basename(p) : undefined, preview: p, severity: 'high' }
    }
    case 'Task':
    case 'Agent': {
      const st = strField(input, 'subagent_type') ?? strField(input, 'agent_type') ?? 'agent'
      const preview = strField(input, 'description') ?? strField(input, 'prompt')
      return { action: 'Delegate', target: st, preview: preview ? firstLine(preview, 200) : undefined, severity: 'medium' }
    }
    case 'WebFetch':
      return { action: 'Fetch URL', target: strField(input, 'url'), severity: 'low' }
    case 'WebSearch': {
      const q = strField(input, 'query')
      return { action: 'Search the web', target: q ? firstLine(q, 100) : undefined, severity: 'low' }
    }
    default: {
      if (name.startsWith('mcp__')) {
        const server = name.slice('mcp__'.length).split('__')[0]
        return { action: `MCP: ${server}`, target: server, severity: 'high' }
      }
      const target = ['file_path', 'command', 'path', 'pattern', 'description', 'prompt']
        .map((k) => strField(input, k)).find(Boolean)
      return { action: `Use ${name}`, target: target ? firstLine(target, 100) : undefined, severity: 'low' }
    }
  }
}
