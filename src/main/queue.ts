import { OperatorRequest, OperatorResponse } from '../shared/types'

interface PendingRequest {
  request: OperatorRequest
  resolve: (response: OperatorResponse) => void
  timer: ReturnType<typeof setTimeout>
}

class RequestQueue {
  private pending = new Map<string, PendingRequest>()

  add(request: OperatorRequest): Promise<OperatorResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.respond(request.id, {
          approved: false,
          value: 'timeout',
          modifiedContext: null,
          respondedAt: new Date().toISOString(),
          respondedBy: 'timeout'
        })
      }, request.expiresIn * 1000)

      this.pending.set(request.id, { request, resolve, timer })
    })
  }

  respond(id: string, response: OperatorResponse): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(response)
    return true
  }

  getAll(): OperatorRequest[] {
    return Array.from(this.pending.values()).map((e) => e.request)
  }

  get size(): number {
    return this.pending.size
  }
}

export const queue = new RequestQueue()
