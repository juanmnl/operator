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

  if (!current) return null

  return (
    <NotificationWidget
      request={current}
      queueSize={requests.length}
      onRespond={(value) => handleRespond(current.id, value)}
      onRespondAll={handleRespondAll}
    />
  )
}
