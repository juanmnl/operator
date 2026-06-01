import { useEffect, useState } from 'react'
import { OperatorRequest } from '../../shared/types'
import { NotificationWidget } from '../components/NotificationWidget'

export function WidgetView() {
  const [requests, setRequests] = useState<OperatorRequest[]>([])

  useEffect(() => {
    window.operator.getQueue().then(setRequests)

    const unsub = window.operator.onNewRequest((request) => {
      setRequests((prev) => [...prev, request])
    })
    return unsub
  }, [])

  const current = requests[0]

  const handleRespond = async (id: string, value: string) => {
    await window.operator.respond(id, value)
    setRequests((prev) => prev.filter((r) => r.id !== id))
  }

  const handleRespondAll = async (value: string) => {
    for (const r of requests) {
      await window.operator.respond(r.id, value)
    }
    setRequests([])
  }

  const handleRespondAndRemember = async (action: 'approve' | 'deny') => {
    if (!current) return
    const toolName = current.toolName || current.action
    let pattern: string | undefined
    if (toolName === 'Bash') {
      const command = current.context.target || ''
      const firstWord = command.split(/\s+/)[0]
      pattern = firstWord ? `${firstWord} *` : undefined
    } else if (current.context.target) {
      pattern = current.context.target
    }
    // Scope to the session's project by default (see DashboardView for rationale).
    const scope = current.context.workingDirectory || undefined
    await window.operator.rulesAdd({ tool: toolName, pattern, scope, action })
    await window.operator.respond(current.id, action)
    setRequests((prev) => prev.filter((r) => r.id !== current.id))
  }

  if (!current) return null

  return (
    <NotificationWidget
      request={current}
      queueSize={requests.length}
      onRespond={(value) => handleRespond(current.id, value)}
      onRespondAll={handleRespondAll}
      onRespondAndRemember={handleRespondAndRemember}
    />
  )
}
