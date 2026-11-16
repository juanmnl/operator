// Minimal CDP client for the measurement run (Node 26 global WebSocket).
export async function targets(port = 9343) {
  return (await (await fetch(`http://localhost:${port}/json/list`)).json())
}
export async function connect(port = 9343, pick = (t) => t.type === 'page' && t.url.includes('/out/renderer/index.html')) {
  const t = (await targets(port)).find(pick)
  if (!t) throw new Error('no matching page target')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')) })
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result) }
    else listeners.forEach((l) => l(d))
  }
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression, opts = {}) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...opts })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
    return r.result.value
  }
  return { send, evaluate, on: (f) => listeners.push(f), close: () => ws.close(), target: t }
}
