import {
  AgentSession,
  ActivityEntry,
  HookEvent,
  OperatorRequest,
  OperatorResponse,
  SessionEntry,
  SessionPhase
} from '../shared/types'
import { summarizeTool } from './tool-summary'

class SessionManager {
  private sessions = new Map<string, AgentSession>()

  recordEvent(event: HookEvent): AgentSession | null {
    const sessionId = event.session_id
    if (!sessionId) return null
    // Only track sessions Operator launched. Events from external Claude Code
    // processes carry no terminal_id (the hook injects it from
    // OPERATOR_TERMINAL_ID), so they're ignored — the app shows only in-app work.
    if (!event.terminal_id) return null

    const now = new Date().toISOString()
    let session = this.sessions.get(sessionId)
    let isNew = false

    if (!session) {
      isNew = true
      const wd = event.cwd || ''
      session = {
        id: sessionId,
        agentId: event.agent_id || 'claude-code',
        workingDirectory: wd,
        projectName: wd.split('/').pop() || wd,
        status: 'active',
        phase: 'idle',
        entries: [],
        activity: [],
        activeSubagents: 0,
        lastToolName: null,
        startedAt: now,
        lastActivityAt: now,
        terminalId: event.terminal_id,
      }
      this.sessions.set(sessionId, session)
    }

    session.lastActivityAt = now

    // Link terminal if provided and not yet linked
    if (event.terminal_id && !session.terminalId) {
      session.terminalId = event.terminal_id
    }

    // Track permission mode from the CC process
    if (event.permission_mode) {
      session.permissionMode = event.permission_mode
    }

    // Update cwd if provided and session didn't have one
    if (event.cwd && !session.workingDirectory) {
      session.workingDirectory = event.cwd
      session.projectName = event.cwd.split('/').pop() || event.cwd
    }

    // State machine transitions
    const phase = this.nextPhase(event.hook_event_name, session.phase)
    if (phase !== null) {
      session.phase = phase
    }

    switch (event.hook_event_name) {
      case 'SessionStart':
        session.status = 'active'
        if (isNew) session.phase = 'idle'
        break
      case 'UserPromptSubmit':
        // Capture the first user prompt as the session summary — used as the
        // default label everywhere a session is shown.
        if (!session.summary) {
          const prompt = event.prompt || event.user_prompt || event.message
          if (prompt) {
            const line = prompt.split('\n')[0].trim()
            session.summary = line.length > 60 ? line.slice(0, 59) + '…' : line
          }
        }
        break
      case 'SessionEnd':
        session.status = 'ended'
        break
      case 'SubagentStart':
        session.activeSubagents++
        if (!session.activity) session.activity = []
        session.activity.push({
          toolName: 'Subagent started',
          target: event.agent_type,
          detail: event.agent_type,
          kind: 'subagent',
          timestamp: now,
          status: 'auto',
        })
        break
      case 'SubagentStop':
        session.activeSubagents = Math.max(0, session.activeSubagents - 1)
        if (!session.activity) session.activity = []
        session.activity.push({
          toolName: 'Subagent finished',
          target: event.agent_type,
          detail: event.agent_type,
          kind: 'subagent',
          timestamp: now,
          status: 'auto',
        })
        break
      case 'PreToolUse':
        session.lastToolName = event.tool_name || null
        if (event.tool_name) {
          if (!session.activity) session.activity = []
          const summary = summarizeTool(event.tool_name, event.tool_input)
          const isDelegate = event.tool_name === 'Task' || event.tool_name === 'Agent'
          session.activity.push({
            toolName: event.tool_name,
            target: summary.target,
            detail: isDelegate ? summary.preview : undefined,
            kind: isDelegate ? 'delegate' : 'tool',
            timestamp: now,
            status: 'auto',
          })
        }
        break
      case 'PostToolUse':
      case 'PostToolUseFailure':
        session.lastToolName = null
        // Mark last activity entry for this tool as auto-approved (if it was still 'auto')
        if (event.tool_name && session.activity?.length) {
          const last = [...session.activity].reverse().find((a) => a.toolName === event.tool_name && a.status === 'auto')
          if (last) last.status = 'approved'
        }
        break
    }

    return session
  }

  private nextPhase(eventName: string, current: SessionPhase): SessionPhase | null {
    switch (eventName) {
      case 'UserPromptSubmit':
        return 'running'
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
        return 'running'
      case 'PreCompact':
        return 'compacting'
      case 'Stop':
      case 'TaskCompleted':
      case 'SessionEnd':
        return 'idle'
      default:
        return null
    }
  }

  trackRequest(sessionId: string, request: OperatorRequest): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.entries.push({ request, response: null })
    const last = [...session.activity].reverse().find((a) => a.toolName === request.toolName && a.status === 'auto')
    if (last) last.status = 'pending'
  }

  resolveRequest(requestId: string, response: OperatorResponse): void {
    for (const session of Array.from(this.sessions.values())) {
      const entry = session.entries.find((e: SessionEntry) => e.request.id === requestId)
      if (!entry) continue
      entry.response = response
      session.lastActivityAt = new Date().toISOString()
      const act = [...session.activity].reverse().find((a) => a.toolName === entry.request.toolName && a.status === 'pending')
      if (act) act.status = response.approved ? 'approved' : 'denied'
      return
    }
  }

  getAll(): AgentSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)
    )
  }

  getActive(): AgentSession[] {
    return this.getAll().filter((s) => s.status === 'active')
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  // Mark stale sessions as ended (no activity for 10+ minutes)
  reconcile(): boolean {
    const cutoff = Date.now() - 10 * 60 * 1000
    let changed = false
    for (const session of Array.from(this.sessions.values())) {
      if (
        session.status === 'active' &&
        new Date(session.lastActivityAt).getTime() < cutoff
      ) {
        session.status = 'ended'
        changed = true
      }
    }
    return changed
  }
}

export const sessions = new SessionManager()
