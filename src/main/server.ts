import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { queue } from './queue'
import { logEntry } from './db'
import { OperatorRequest, HookEvent } from '../shared/types'
import { updateTrayBadge } from './tray'
import { sessions } from './sessions'
import { WindowManager } from './window/window-manager'
import { TerminalRegistry } from './terminal/terminal-registry'
import { summarizeTool, summaryMessage } from './tool-summary'
import { rules } from './rules'

const PORT = 47821

export function startServer(windowManager: WindowManager, terminalRegistry: TerminalRegistry): void {
  // Preload rules so the first incoming request can be matched without a load delay.
  rules.ready().catch((err) => console.error('rules load failed:', err))

  const app = express()
  app.use(express.json())

  // Unified hook endpoint — receives all Claude Code hook events
  app.post('/hook', async (req, res) => {
    const event: HookEvent = req.body

    // Infer event name if missing — if tool_name is present, it's likely PreToolUse
    if (!event.hook_event_name || event.hook_event_name === 'unknown') {
      if (event.tool_name) {
        event.hook_event_name = 'PreToolUse'
      }
    }

    // Link terminal_id from env if present
    if (event.terminal_id && event.session_id) {
      terminalRegistry.link(event.terminal_id, event.session_id)
    }

    const session = sessions.recordEvent(event)

    if (process.env.OPERATOR_DEBUG) {
      const sid = event.session_id?.slice(0, 4) ?? '----'
      const evt = event.hook_event_name?.padEnd(14) ?? '-'.padEnd(14)
      const tool = event.tool_name ? ` ${event.tool_name}` : ''
      console.log(`hook ${evt} s/${sid} ${session?.phase || '-'}${tool}`)
    }

    // Broadcast session update
    if (session) {
      windowManager.sendSessionUpdate(sessions.getActive())
    }
    updateTrayBadge()

    // Non-blocking events — acknowledge immediately
    if (event.hook_event_name !== 'PreToolUse') {
      res.json({ status: 'ok' })
      return
    }

    // Non-destructive tools — auto-approve silently. The user only cares about
    // tools that touch the filesystem, run shell, hit the network with side effects,
    // or invoke arbitrary MCP servers. Everything else is "Claude thinking out loud."
    if (isAutoApprovedTool(event.tool_name)) {
      res.json({ decision: 'approve' })
      return
    }

    // Auto-approve for sessions in auto/bypass permission mode
    const sessionPermMode = session?.permissionMode || event.permission_mode
    if (sessionPermMode === 'auto' || sessionPermMode === 'bypassPermissions') {
      res.json({ decision: 'approve' })
      return
    }

    // User-defined auto-approve / auto-deny rules
    const ruleHit = rules.evaluate(event.tool_name, event.tool_input, event.cwd)
    if (ruleHit) {
      console.log(`rule ${ruleHit.decision}: ${event.tool_name}${ruleHit.matched.pattern ? `(${ruleHit.matched.pattern})` : ''} — s/${event.session_id?.slice(0, 4)}`)
      res.json({ decision: ruleHit.decision === 'approve' ? 'approve' : 'deny' })
      return
    }

    // PreToolUse — blocking permission flow
    const summary = summarizeTool(event.tool_name, event.tool_input)

    const request: OperatorRequest = {
      id: uuidv4(),
      agentId: event.agent_id || 'claude-code',
      action: summary.action,
      toolName: event.tool_name,
      message: summaryMessage(summary),
      context: {
        workingDirectory: event.cwd || '',
        target: summary.target,
        preview: summary.preview,
      },
      severity: summary.severity,
      expiresIn: 300,
      timestamp: new Date().toISOString(),
      sessionId: event.session_id,
      terminalId: event.terminal_id,
    }

    if (session) {
      sessions.trackRequest(session.id, request)
    }

    const sid = request.sessionId?.slice(0, 4) || '----'
    console.log(`permission needed: ${request.action}${request.context.target ? ` (${request.context.target})` : ''} — s/${sid}`)
    windowManager.sendNewRequest(request)
    windowManager.sendSessionUpdate(sessions.getActive())

    const response = await queue.add(request)
    sessions.resolveRequest(request.id, response)
    logEntry(request, response)
    updateTrayBadge()

    windowManager.sendSessionUpdate(sessions.getActive())

    res.json({ decision: response.approved ? 'approve' : 'deny' })
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', pending: queue.size, sessions: sessions.getActive().length })
  })

  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`Operator gateway listening on http://127.0.0.1:${PORT}`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Is another Operator instance running?`)
    } else {
      console.error('Server error:', err)
    }
  })

  // Reconcile stale sessions every 2 minutes
  setInterval(() => {
    if (sessions.reconcile()) {
      windowManager.sendSessionUpdate(sessions.getActive())
      updateTrayBadge()
    }
  }, 2 * 60 * 1000)

  // Graceful shutdown so electron-vite auto-restart doesn't hit EADDRINUSE
  process.on('exit', () => server.close())
  process.on('SIGTERM', () => { server.close(); process.exit(0) })
  process.on('SIGINT', () => { server.close(); process.exit(0) })
}

// Tools that never need user approval — read-only, internal state, or read-only network.
// Anything not on this list and not auto-approved by session permission mode goes through
// the blocking permission flow.
const AUTO_APPROVED_TOOLS = new Set([
  // Read-only filesystem / search
  'Read', 'Glob', 'Grep',
  // Claude internal state / planning
  'Skill', 'ToolSearch', 'LSP', 'TodoWrite',
  'EnterPlanMode', 'ExitPlanMode',
  // Task management (queue local to Claude — no side effects on user systems)
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  // Read-only network
  'WebFetch', 'WebSearch',
  // Notifications & scheduling (no destructive effect)
  'PushNotification', 'ScheduleWakeup',
])

function isAutoApprovedTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  return AUTO_APPROVED_TOOLS.has(toolName)
}
