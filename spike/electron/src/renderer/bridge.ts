// `window.operator` for this shell: the mock bridge, with the real methods laid over it.
//
// This is the renderer-side counterpart of `src/operator-bridge.ts` — same job, same seam. It
// composes rather than reimplements: `dev/mock-bridge.ts` already answers all 90 methods with
// fixtures, so the shell only has to override the ones it actually owns. The layering is what
// makes the port incremental: move a method from mock to native in `SPEC`, implement it in
// main, and this file needs no change at all.
import { installMockBridge } from '../../../../dev/mock-bridge'
import { base64ToBytes } from '../../../../src/renderer/lib/base64'
import { createWriteQueue, type WriteQueue } from '../../../../src/renderer/lib/write-queue'
import { spawnTerminalMode } from '../../../../src/renderer/lib/terminal-options'
import { isLightBackground } from '../../../../src/renderer/lib/terminal'

type AnyFn = (...args: unknown[]) => unknown

declare global {
  interface Window {
    __operatorNative?: Record<string, AnyFn>
    __operatorNativeMethods?: string[]
  }
}

/** One streaming decoder per terminal. `stream: true` is the whole point: a UTF-8 character
 *  split across two pty reads is stitched here, and decoding each chunk independently would
 *  put a U+FFFD in the terminal every time a multibyte glyph straddled an 8KB boundary. */
const decoders = new Map<string, TextDecoder>()

/** One ordered write queue per terminal, exactly as the Tauri bridge does.
 *
 *  Ordering is NOT the reason here — `ipcRenderer.send` on one channel is already ordered,
 *  where Tauri's promise-returning `invoke` was not. What survives the move is the CHUNKING:
 *  it splits a big paste without ever cutting a surrogate pair, and a lone surrogate is not
 *  valid UTF-8. That half is worth keeping whatever the transport. */
const writeQueues = new Map<string, WriteQueue>()

export function installSpikeBridge(): void {
  installMockBridge()
  const mock = window.operator as unknown as Record<string, unknown>
  const native = window.__operatorNative ?? {}

  // Methods this shell owns but that need renderer-only state before they cross the wire.
  const composed: Record<string, AnyFn> = {
    // The tui/renderer pref lives in localStorage and the terminal's colours are CSS custom
    // properties — neither is readable from main. Resolve them here and pass them down inside
    // `launchOptions`, which is already the opaque bag the Tauri bridge reads its own keys out
    // of. Same division of labour as `operator-bridge.ts`, just a different transport.
    terminalSpawn: async (cwd?: unknown, launchOptions?: unknown) => {
      const readVar = (name: string) => {
        try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() } catch { return '' }
      }
      const termBg = readVar('--bg-terminal') || '#0b0d10'
      const termFg = readVar('--fg') || '#e6e6e6'
      const { tuiMode } = spawnTerminalMode()
      return (native.terminalSpawn as AnyFn)(cwd, {
        ...(launchOptions as Record<string, unknown> ?? {}),
        tuiMode,
        colorScheme: isLightBackground(termBg) ? 'light' : 'dark',
        termBg,
        termFg,
      })
    },

    terminalWrite: (id: unknown, data: unknown) => {
      const key = String(id)
      let q = writeQueues.get(key)
      if (!q) {
        q = createWriteQueue(async (d) => { (native.terminalWrite as AnyFn)(key, d) })
        writeQueues.set(key, q)
      }
      q.write(String(data))
    },

    onTerminalData: (cb: unknown) => {
      return (native.onTerminalData as AnyFn)((id: unknown, b64: unknown) => {
        const key = String(id)
        let d = decoders.get(key)
        if (!d) { d = new TextDecoder(); decoders.set(key, d) }
        ;(cb as AnyFn)(key, d.decode(base64ToBytes(String(b64)), { stream: true }))
      })
    },

    // Sessions arrive as one array per tick. Passed straight through — the shape is already
    // the renderer's own AgentSession (main imports it from shared/types), which is the point
    // of deriving the seam rather than restating it.
    onTerminalExit: (cb: unknown) => {
      return (native.onTerminalExit as AnyFn)((id: unknown, code: unknown, signal: unknown) => {
        const key = String(id)
        decoders.delete(key)
        writeQueues.delete(key)
        ;(cb as AnyFn)(key, Number(code), Number(signal))
      })
    },
  }

  // Native wins, then the mock. The Proxy (rather than a spread) is deliberate: the mock's own
  // fallback Proxy answers any method nobody has taught it about with a harmless no-op, and a
  // spread would flatten that away — turning "not ported yet" from a shrug into a TypeError.
  window.operator = new Proxy({} as Window['operator'], {
    get: (_t, p: string) => composed[p] ?? native[p] ?? (mock as Record<string, unknown>)[p],
    has: (_t, p: string) => p in composed || p in native || p in mock,
  })
}

/** Which methods are real in this build — handy from the devtools console when a measurement
 *  looks wrong and the first question is "was that pty actually a pty?". */
export const nativeMethods = (): string[] => window.__operatorNativeMethods ?? []
