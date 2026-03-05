import { contextBridge, ipcRenderer } from 'electron'
import { IPC, OperatorRequest } from '../shared/types'

contextBridge.exposeInMainWorld('operator', {
  onNewRequest: (callback: (request: OperatorRequest) => void) => {
    ipcRenderer.on(IPC.NEW_REQUEST, (_event, request) => callback(request))
  },
  respond: (id: string, approved: boolean) => {
    return ipcRenderer.invoke(IPC.RESPOND, id, approved)
  },
  getQueue: () => {
    return ipcRenderer.invoke(IPC.GET_QUEUE)
  }
})
