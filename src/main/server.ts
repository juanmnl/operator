import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { BrowserWindow } from 'electron'
import { queue } from './queue'
import { logEntry } from './db'
import { IPC, OperatorRequest } from '../shared/types'

const PORT = 47821

export function startServer(getWindow: () => BrowserWindow | null): void {
  const app = express()
  app.use(express.json())

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
      timestamp: body.timestamp || new Date().toISOString()
    }

    const win = getWindow()
    if (win) {
      win.webContents.send(IPC.NEW_REQUEST, request)
      win.show()
    }

    const response = await queue.add(request)
    logEntry(request, response)

    res.json(response)
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', pending: queue.size })
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
}
