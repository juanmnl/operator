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

/** The first line, trimmed, capped at `max` CHARACTERS INCLUDING the ellipsis.
 *
 *  Both details are load-bearing for parity with `first_line` in core.rs, and both were wrong
 *  here first: the Rust trims the line, and on overflow it takes `max - 1` and appends `…` so
 *  the result is exactly `max` — not `max + 1`. Caught by diffing 2,038 real transcript rows
 *  against the ones the Tauri build wrote for the same session (691 differed). */
export function firstLine(s: string, max: number): string {
  const line = (s.split('\n')[0] ?? '').trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

const basename = (p: string) => p.split('/').pop() || p

/** Commands worth flagging louder in the timeline. Deliberately coarse — this colours a row, it
 *  does not gate anything. Ported substring-for-substring from `bash_severity` in core.rs
 *  rather than rewritten as regexes: the two must agree on what counts as destructive. */
function bashSeverity(command: string): string {
  const c = command.toLowerCase()
  if (c.includes('rm -rf') || c.includes('rm -fr') || c.includes('git push -f') ||
      c.includes('git push --force') || c.includes('drop table') || c.includes('drop database')) return 'high'
  if (c.includes('sudo ') || (c.includes('curl ') && c.includes('| sh')) || c.includes('| bash')) return 'medium'
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
