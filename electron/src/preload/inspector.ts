// Preload for the embedded preview webview. Exposes ONE function, which is the whole reason
// Electron does not need Tauri's `operatorpick://` beacon: a sandboxed preload can talk to main
// directly.
//
// Deliberately minimal — this preload runs inside the USER'S dev server, which is arbitrary
// local code. It gets a one-way channel that carries a string to the app, and nothing else.
import { contextBridge, ipcRenderer } from 'electron'
import { blockBadging } from './badge-block'

// Every frame in this view is the user's page, so every frame gets the badge stub (see
// badge-block.ts). The view sets `nodeIntegrationInSubFrames` to reach the page's own iframes, and
// the pick bridge stays where it was: the top frame only.
contextBridge.executeInMainWorld({ func: blockBadging })

if (window.top === window) {
  contextBridge.exposeInMainWorld('__operatorPickBridge', (json: string) => {
    ipcRenderer.send('operator-preview:pick', json)
  })
}
