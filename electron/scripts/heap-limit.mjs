// What ceiling does Chromium actually impose on a renderer?
//
// The Tauri number on record is a KILL at 1089–1196 MB — WebKit ending the renderer under
// memory pressure. The comparable Chromium figure is not a kill threshold but the V8 heap
// limit, so this reads it from a real renderer rather than quoting folklore.
import { app, BrowserWindow } from 'electron'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadURL('data:text/html,<title>probe</title>')
  const heap = await win.webContents.executeJavaScript(`(() => {
    const m = performance.memory
    return m ? { jsHeapSizeLimit: m.jsHeapSizeLimit, totalJSHeapSize: m.totalJSHeapSize } : null
  })()`)
  console.log('v8 heap limit (MB):', heap ? Math.round(heap.jsHeapSizeLimit / 1048576) : 'performance.memory unavailable')
  console.log('electron:', process.versions.electron, ' chromium:', process.versions.chrome, ' node:', process.versions.node)
  app.quit()
})
