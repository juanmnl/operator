// Preload for the embedded preview webview. Exposes ONE function, which is the whole reason
// Electron does not need Tauri's `operatorpick://` beacon: a sandboxed preload can talk to main
// directly.
//
// Deliberately minimal — this preload runs inside the USER'S dev server, which is arbitrary
// local code. It gets a one-way channel that carries a string to the app, and nothing else.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('__operatorPickBridge', (json: string) => {
  ipcRenderer.send('operator-preview:pick', json)
})
