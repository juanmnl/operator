import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { queue } from './queue'
import { logEntry } from './db'
import { OperatorRequest, HookEvent } from '../shared/types'
import { updateTrayBadge } from './tray'
import { sessions } from './sessions'
import { WindowManager } from './window/window-manager'
import { TerminalRegistry } from './terminal/terminal-registry'

const PORT = 47821

export function startServer(windowManager: WindowManager, terminalRegistry: TerminalRegistry): void {
  const app = express()
  app.use(express.json())

  // Unified hook endpoint — receives all Claude Code hook events
  app.post('/hook', async (req, res) => {
    const event: HookEvent = req.body

    // Link terminal_id from env if present
    if (event.terminal_id && event.session_id) {
      terminalRegistry.link(event.terminal_id, event.session_id)
    }

    const session = sessions.recordEvent(event)

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

    // Read-only tools: track for session state but skip permission flow
    const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'LSP'])
    if (READ_ONLY_TOOLS.has(event.tool_name || '')) {
      res.json({ decision: 'approve' })
      return
    }

    // PreToolUse — blocking permission flow
    const toolInput = event.tool_input || {}
    const inputSummary = Object.entries(toolInput)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`)
      .join(', ')

    const request: OperatorRequest = {
      id: uuidv4(),
      agentId: event.agent_id || 'claude-code',
      action: event.tool_name || 'unknown',
      message: `${event.tool_name || 'Tool'}: ${inputSummary}`,
      context: {
        workingDirectory: event.cwd || '',
        target: toolInput.file_path as string || toolInput.command as string || undefined,
      },
      severity: getSeverity(event.tool_name),
      expiresIn: 300,
      timestamp: new Date().toISOString(),
      sessionId: event.session_id,
      terminalId: event.terminal_id,
    }

    if (session) {
      sessions.trackRequest(session.id, request)
    }

    console.log(`Operator: permission request — ${request.action} from ${request.sessionId || 'unknown'} (terminal: ${request.terminalId || 'none'})`)
    windowManager.sendNewRequest(request)
    windowManager.sendSessionUpdate(sessions.getActive())

    const response = await queue.add(request)
    sessions.resolveRequest(request.id, response)
    logEntry(request, response)
    updateTrayBadge()

    windowManager.sendSessionUpdate(sessions.getActive())
    if (queue.size === 0) {
      windowManager.hideWidget()
    }

    res.json({ decision: response.approved ? 'approve' : 'deny' })
  })

  // Legacy endpoint — direct HTTP requests (curl testing, non-hook agents)
  app.post('/request', async (req, res) => {
    const body = req.body
    const request: OperatorRequest = {
      id: body.id || uuidv4(),
      agentId: body.agentId || 'unknown',
      action: body.action || 'unknown',
      message: body.message || '',
      context: body.context || {},
      severity: body.severity || 'medium',
      options: body.options || undefined,
      expiresIn: body.expiresIn || 60,
      timestamp: body.timestamp || new Date().toISOString(),
      sessionId: body.sessionId
    }

    windowManager.sendNewRequest(request)
    updateTrayBadge()

    const response = await queue.add(request)
    logEntry(request, response)
    updateTrayBadge()

    if (queue.size === 0) {
      windowManager.hideWidget()
    }

    res.json(response)
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

function getSeverity(toolName: string | undefined): 'low' | 'medium' | 'high' {
  switch (toolName) {
    case 'Bash':
    case 'Write':
      return 'high'
    case 'Edit':
    case 'NotebookEdit':
      return 'medium'
    default:
      return 'low'
  }
}
