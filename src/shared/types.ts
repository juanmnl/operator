export type Severity = 'low' | 'medium' | 'high'

export interface OperatorRequest {
  id: string
  agentId: string
  action: string
  message: string
  context: {
    workingDirectory?: string
    target?: string
    preview?: string
  }
  severity: Severity
  expiresIn: number
  timestamp: string
}

export interface OperatorResponse {
  approved: boolean
  modifiedContext: Record<string, unknown> | null
  respondedAt: string
  respondedBy: 'user' | 'auto-rule' | 'timeout'
}

export interface AuditEntry {
  id: string
  request: OperatorRequest
  response: OperatorResponse
}

export const IPC = {
  NEW_REQUEST: 'operator:new-request',
  RESPOND: 'operator:respond',
  GET_QUEUE: 'operator:get-queue'
} as const
