// A minimal Chrome DevTools Protocol client: one WebSocket, request/response by id, and events.
//
// No dependency. Electron's Node (24.x in Electron 43) has `WebSocket` and `fetch` as globals, which
// is all CDP needs: JSON over a WebSocket, and HTTP for target discovery.

export type CdpEventHandler = (params: Record<string, unknown>) => void

export class CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  private handlers = new Map<string, Set<CdpEventHandler>>()
  private closedHandlers = new Set<() => void>()
  closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => this.onMessage(String((ev as MessageEvent).data)))
    ws.addEventListener('close', () => this.onClose())
    ws.addEventListener('error', () => this.onClose())
  }

  /** Open a connection to a target's `webSocketDebuggerUrl`. Rejects if it does not open in time. */
  static connect(url: string, timeoutMs = 5000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try { ws = new WebSocket(url) } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return }
      const timer = setTimeout(() => { try { ws.close() } catch { /* */ } reject(new Error(`CDP connect timed out: ${url}`)) }, timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(ws)) }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${url}`)) }, { once: true })
    })
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  on(event: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) { set = new Set(); this.handlers.set(event, set) }
    set.add(handler)
    return () => { set!.delete(handler) }
  }

  onClosed(handler: () => void): void { this.closedHandlers.add(handler) }

  close(): void {
    try { this.ws.close() } catch { /* already closed */ }
    this.onClose()
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown> }
    try { msg = JSON.parse(raw) } catch { return }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
      else p.resolve(msg.result ?? {})
      return
    }
    if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) {
      try { h(msg.params ?? {}) } catch (e) { console.error(`[cdp] ${msg.method} handler failed:`, e) }
    }
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'))
    this.pending.clear()
    for (const h of this.closedHandlers) { try { h() } catch { /* */ } }
  }
}
