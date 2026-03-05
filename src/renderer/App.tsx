import { useEffect, useState } from 'react'
import { OperatorRequest } from '../shared/types'
import { NotificationWidget } from './components/NotificationWidget'

export default function App() {
  const [requests, setRequests] = useState<OperatorRequest[]>([])

  useEffect(() => {
    window.operator.getQueue().then(setRequests)

    window.operator.onNewRequest((request) => {
      setRequests((prev) => [...prev, request])
    })
  }, [])

  const current = requests[0]

  const handleRespond = async (id: string, approved: boolean) => {
    await window.operator.respond(id, approved)
    setRequests((prev) => prev.filter((r) => r.id !== id))
  }

  const handleAcceptAll = async () => {
    for (const r of requests) {
      await window.operator.respond(r.id, true)
    }
    setRequests([])
  }

  if (!current) return null

  return (
    <NotificationWidget
      request={current}
      queueSize={requests.length}
      onAccept={() => handleRespond(current.id, true)}
      onDeny={() => handleRespond(current.id, false)}
      onAcceptAll={handleAcceptAll}
    />
  )
}
