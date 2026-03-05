import { OperatorRequest } from '../shared/types'

declare global {
  interface Window {
    operator: {
      onNewRequest: (callback: (request: OperatorRequest) => void) => void
      respond: (id: string, value: string) => Promise<boolean>
      getQueue: () => Promise<OperatorRequest[]>
    }
  }
}
