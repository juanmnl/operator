import { ipcMain } from 'electron'
import { queue } from './queue'
import { IPC, OperatorResponse } from '../shared/types'

export function setupIpc(): void {
  ipcMain.handle(IPC.RESPOND, (_event, id: string, approved: boolean) => {
    const response: OperatorResponse = {
      approved,
      modifiedContext: null,
      respondedAt: new Date().toISOString(),
      respondedBy: 'user'
    }
    return queue.respond(id, response)
  })

  ipcMain.handle(IPC.GET_QUEUE, () => {
    return queue.getAll()
  })
}
