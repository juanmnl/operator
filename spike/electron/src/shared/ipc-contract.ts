// Typed IPC, derived from the renderer's own contract.
//
// The handler map below is keyed by `ApiMethod`, and each handler's parameters and return
// type are read off the SAME signature the renderer calls. So a main-process handler that
// takes the wrong argument, or resolves the wrong shape, fails to compile — which is the
// only kind of IPC typing worth having. Hand-written `ipcMain.handle('foo', (e, a: any) …)`
// is a string and an `any`, and both of those are how a shell drifts from its renderer.
import type { ApiMethod, Method, OperatorApi } from './operator-api'

/** Methods that return a Promise — one `ipcMain.handle` round trip each. */
export type InvokeMethod = {
  [K in ApiMethod]: ReturnType<Method<K>> extends Promise<unknown> ? K : never
}[ApiMethod]

/** Methods that return void — `ipcMain.on`, never awaited. */
export type SendMethod = {
  [K in ApiMethod]: ReturnType<Method<K>> extends void ? K : never
}[ApiMethod]

/** `on…(cb) => unsubscribe`. The callback's parameters ARE the event payload, so the
 *  push side is typed off the subscription the renderer already declares. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type EventMethod = {
  // `any` in the callback parameter is load-bearing, not laziness: under strictFunctionTypes a
  // concrete `(id: string, data: string) => void` is NOT assignable to a `never[]`-rest probe,
  // so the tighter-looking version silently matches nothing and every push becomes zero-arg.
  [K in ApiMethod]: Method<K> extends (cb: (...a: any[]) => void) => () => void ? K : never
}[ApiMethod]

/** What main pushes for `onTerminalData` etc. — exactly the callback's arguments. */
export type EventPayload<K extends EventMethod> =
  Method<K> extends (cb: (...a: infer A) => void) => () => void ? A : never
/* eslint-enable @typescript-eslint/no-explicit-any */

export type InvokeArgs<K extends InvokeMethod> = Parameters<Method<K>>
export type InvokeResult<K extends InvokeMethod> = Awaited<ReturnType<Method<K>>>
export type SendArgs<K extends SendMethod> = Parameters<Method<K>>

/** The main process's half. Partial because this shell implements the terminal subset plus
 *  the OS surface; `SPEC` in operator-api.ts is what records the rest as deliberately mock,
 *  so "unimplemented" is a written decision rather than a hole in a map. */
export type InvokeHandlers = {
  [K in InvokeMethod]?: (...args: InvokeArgs<K>) => InvokeResult<K> | Promise<InvokeResult<K>>
}

export type SendHandlers = {
  [K in SendMethod]?: (...args: SendArgs<K>) => void
}

/** The renderer's half, as the preload exposes it: the same methods, same signatures. */
export type ExposedApi = Partial<OperatorApi>
