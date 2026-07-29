import type { AgentSession } from '../../shared/types'

// What the chat surface should SAY about a session right now — one definition, read by the
// status line at the foot of the transcript and by the jump-to-latest control (which doubles
// as the running indicator, so the two must never disagree about what the agent is doing).
//
// This is a pure read of fields that were already on the wire and already driving the sidebar
// orb (`phase`, `status`, `lastToolName`, `activeSubagents`). No new transcript parsing.

export interface ChatSignal {
  /** Which state to show — mirrors the sidebar's vocabulary so the two surfaces agree. */
  kind: 'running' | 'compacting' | 'waiting' | 'ended'
  /** Human phrase: "Editing", "Running a command", "Thinking", "Your turn"… */
  label: string
  /** MOTION MEANS BUSY — the app-wide rule (see StatusWave). Only running/compacting animate;
   *  waiting rests static and carries its meaning in the words. */
  animate: boolean
  /** Whether an interrupt is meaningful right now. */
  interruptible: boolean
}

/** Tool name → what the agent is DOING. Claude Code reports the tool (`Edit`, `Bash`), which
 *  is jargon at the foot of a reading surface; the verb is what a waiting human wants. */
const TOOL_VERB: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing a notebook',
  Bash: 'Running a command',
  BashOutput: 'Running a command',
  Glob: 'Searching',
  Grep: 'Searching',
  WebFetch: 'Fetching a page',
  WebSearch: 'Searching the web',
  Task: 'Delegating',
  Agent: 'Delegating',
  TodoWrite: 'Updating its plan',
  ExitPlanMode: 'Finishing the plan',
}

/** "mcp__chrome-devtools__navigate" → "chrome-devtools". */
function mcpServer(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null
  const parts = tool.split('__')
  return parts[1] || null
}

export function toolVerb(tool: string | null | undefined): string | null {
  if (!tool) return null
  const server = mcpServer(tool)
  if (server) return `Using ${server}`
  return TOOL_VERB[tool] ?? `Running ${tool}`
}

/** The signal to show, or null when there is nothing worth saying — an idle live session
 *  takes NO space at the foot of the transcript (per the brief: absence is the signal). */
export function chatSignal(session: Pick<AgentSession, 'status' | 'phase' | 'lastToolName' | 'activeSubagents'> | undefined | null): ChatSignal | null {
  if (!session) return null
  if (session.status === 'ended') {
    return { kind: 'ended', label: 'Session ended', animate: false, interruptible: false }
  }
  switch (session.phase) {
    case 'running': {
      const verb = toolVerb(session.lastToolName)
      // No tool open = the agent is reasoning, which is the honest thing to say while it is
      // the only thing happening (the collapsed `thinking` turns say it after the fact).
      const base = verb ?? 'Thinking'
      const subs = session.activeSubagents > 0
        ? `${base} · ${session.activeSubagents} subagent${session.activeSubagents > 1 ? 's' : ''}`
        : base
      return { kind: 'running', label: subs, animate: true, interruptible: true }
    }
    case 'compacting':
      return { kind: 'compacting', label: 'Compacting context', animate: true, interruptible: true }
    case 'waiting':
      // Needs the user. Quiet by design — no pulse, the words carry it.
      return { kind: 'waiting', label: 'Your turn', animate: false, interruptible: false }
    default:
      return null
  }
}
