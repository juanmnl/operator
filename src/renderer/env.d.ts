import { OperatorRequest } from '../shared/types'

declare global {
  interface Window {
    operator: {
      onNewRequest: (callback: (request: OperatorRequest) => void) => void
      respond: (id: string, approved: boolean) => Promise<boolean>
      getQueue: () => Promise<OperatorRequest[]>
    }
  }
}
