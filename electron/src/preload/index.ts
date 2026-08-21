// Preload — the only thing that crosses the context-isolation boundary.
//
// It exposes `window.__operatorNative`: the subset of the 90-method contract this shell
// answers itself. The renderer layers it over `dev/mock-bridge.ts` to form `window.operator`
// (see ../renderer/main.tsx). Splitting it that way is what lets the shell grow one real
// method at a time without the renderer ever knowing which half it is talking to.
//
// Each method is generated FROM the contract rather than written out, so "the preload forgot
// to forward one" is not a failure mode that exists here.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { channel, eventChannel, SPEC, NATIVE_METHODS, type ApiMethod } from '../shared/operator-api'

type AnyFn = (...args: unknown[]) => unknown

const api: Record<string, AnyFn> = {}

for (const method of NATIVE_METHODS) {
  const { delivery } = SPEC[method]
  if (delivery === 'invoke') {
    api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel(method), ...args)
  } else if (delivery === 'send') {
    api[method] = (...args: unknown[]) => { ipcRenderer.send(channel(method), ...args) }
  } else if (delivery === 'event') {
    api[method] = (cb: unknown) => {
      const listener = (_e: unknown, ...payload: unknown[]) => (cb as AnyFn)(...payload)
      ipcRenderer.on(eventChannel(method), listener)
      // The renderer's contract is `on…(cb) => unsubscribe`, and every caller stores that
      // return value for its unmount cleanup. Returning `undefined` here would throw on
      // teardown instead of failing to unsubscribe — the loudest possible version of the
      // quietest possible bug.
      return () => { ipcRenderer.off(eventChannel(method), listener) }
    }
  }
  // `local` methods are installed below — they never reach main.
}

// --- onFileDrop, and the drop guard that has to come with it -------------------------------
//
// A file dropped on a webview is a NAVIGATION unless something cancels it. Tauri suppressed
// HTML5 drops outright and handed the app real paths through its own event; Chromium does
// not, so this preload is where both halves live: cancel the browser's default (or the
// window navigates to `file:///…/dropped.png` and the app is simply gone — the accident of
// 2026-08-14), and turn the drop into the real paths the renderer expects.
//
// `webUtils.getPathForFile` is the modern replacement for the removed `File.path`; it is why
// this works at all with `sandbox: true`.
const dropCallbacks = new Set<(paths: string[]) => void>()

window.addEventListener('dragover', (e) => { e.preventDefault() })
window.addEventListener('drop', (e) => {
  e.preventDefault()
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length || !dropCallbacks.size) return
  const paths = files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)
  if (paths.length) dropCallbacks.forEach((cb) => cb(paths))
})

api.onFileDrop = ((cb: (paths: string[]) => void) => {
  dropCallbacks.add(cb)
  return () => { dropCallbacks.delete(cb) }
}) as AnyFn

/** Which methods are real, so the renderer can layer precisely these over the mock and a
 *  console can answer "is this lane's terminal actually a pty?" without reading source. */
const nativeMethods: ApiMethod[] = [...NATIVE_METHODS]

contextBridge.exposeInMainWorld('__operatorNative', api)
contextBridge.exposeInMainWorld('__operatorNativeMethods', nativeMethods)
