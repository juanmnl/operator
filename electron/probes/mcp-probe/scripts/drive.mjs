// Drive an --mcp-serve binary from OUTSIDE dev: spawn it, speak the three methods, check the
// answers, and time the headless startup.
//
// Usage: node drive.mjs <binary> [args...]        (env: RUN_AS_NODE=1, NO_TERMINAL_ID=1)
//
// Deliberately dependency-free and transport-literal: it writes newline-delimited JSON to stdin
// and reads newline-delimited JSON from stdout, because that framing IS what is under test. A
// client library would paper over exactly the failure this probe exists to find.
import { spawn } from 'node:child_process'

const [bin, ...rest] = process.argv.slice(2)
if (!bin) { console.error('usage: drive.mjs <binary> [args...]'); process.exit(2) }

const env = { ...process.env }
if (process.env.RUN_AS_NODE === '1') env.ELECTRON_RUN_AS_NODE = '1'
// The caller-attribution contract: a lane always has this, so the happy path sets it. Clearing
// it is how the refusal gets tested.
if (process.env.NO_TERMINAL_ID === '1') delete env.OPERATOR_TERMINAL_ID
else env.OPERATOR_TERMINAL_ID = env.OPERATOR_TERMINAL_ID || 't-probe'

const t0 = process.hrtime.bigint()
const child = spawn(bin, rest, { stdio: ['pipe', 'pipe', 'pipe'], env })

let stdoutBuf = ''
let stderrBuf = ''
/** Every complete line stdout produced, in order — including any that is NOT JSON. Capturing the
 *  non-JSON is the point: one stray banner on stdout corrupts a frame, and a driver that only
 *  logged parsed objects would report that as "no response". */
const lines = []
const waiters = []
let firstByteNs = null

child.stdout.on('data', (d) => {
  if (firstByteNs === null) firstByteNs = process.hrtime.bigint()
  stdoutBuf += d.toString('utf8')
  let i
  while ((i = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, i)
    stdoutBuf = stdoutBuf.slice(i + 1)
    lines.push(line)
    const w = waiters.shift()
    if (w) w(line)
  }
})
child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8') })

const nextLine = (ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for a stdout line')), ms)
  waiters.push((l) => { clearTimeout(t); res(l) })
})

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')

const results = { binary: bin, args: rest, runAsNode: env.ELECTRON_RUN_AS_NODE === '1', steps: [] }
const step = (name, ok, detail) => { results.steps.push({ name, ok, detail }); return ok }

try {
  // 1. initialize — and the clock that matters: spawn → first protocol byte.
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const initLine = await nextLine()
  const initMs = Number(firstByteNs - t0) / 1e6
  results.startupMs = Math.round(initMs)
  let init
  try { init = JSON.parse(initLine) } catch { init = null }
  step('initialize', !!init?.result?.protocolVersion,
       init ? `protocolVersion=${init.result?.protocolVersion} serverInfo=${JSON.stringify(init.result?.serverInfo)}` : `NOT JSON: ${initLine.slice(0, 200)}`)

  // 2. notifications/initialized — a notification has no id and MUST NOT be answered. Verified
  //    by sending it and then a ping: if the notification were answered, the ping's reply would
  //    arrive one line late and every subsequent response would be off by one.
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'ping' })
  const pingLine = await nextLine()
  const ping = JSON.parse(pingLine)
  step('notification is not answered', ping?.id === 2, `next line after the notification had id=${ping?.id} (must be 2)`)

  // 3. tools/list
  send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const list = JSON.parse(await nextLine())
  const names = (list?.result?.tools ?? []).map((t) => t.name)
  step('tools/list', names.length > 0, `tools=${JSON.stringify(names)}`)

  // 4. tools/call — the happy path.
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'operator__report', arguments: { summary: 'probe run from a plain shell', artifacts: [{ name: 'a', content: 'b' }] } } })
  const call = JSON.parse(await nextLine())
  step('tools/call', call?.result?.isError !== true, JSON.stringify(call?.result?.content?.[0]?.text ?? call))

  // 5. unknown method → -32601, not a crash.
  send({ jsonrpc: '2.0', id: 5, method: 'nope' })
  const unknown = JSON.parse(await nextLine())
  step('unknown method → -32601', unknown?.error?.code === -32601, JSON.stringify(unknown?.error))

  // 6. malformed line → -32700, and the server survives it.
  child.stdin.write('{not json\n')
  const parseErr = JSON.parse(await nextLine())
  send({ jsonrpc: '2.0', id: 6, method: 'ping' })
  const after = JSON.parse(await nextLine())
  step('malformed line → -32700 and server survives', parseErr?.error?.code === -32700 && after?.id === 6,
       `${JSON.stringify(parseErr?.error)}; recovered=${after?.id === 6}`)

  // 7. STDOUT HYGIENE: every line so far must be exactly one JSON object. This is the check the
  //    whole probe exists for.
  const nonJson = lines.filter((l) => { try { JSON.parse(l); return false } catch { return true } })
  step('stdout carries ONLY JSON-RPC frames', nonJson.length === 0,
       nonJson.length ? `${nonJson.length} non-JSON line(s): ${JSON.stringify(nonJson.slice(0, 3))}` : `${lines.length} lines, all JSON`)

  // 8. The path the artifact plane is built on.
  send({ jsonrpc: '2.0', id: 7, method: 'probe/env' })
  const envRes = JSON.parse(await nextLine())
  results.env = envRes?.result
  step('probe/env', !!envRes?.result?.execPath, JSON.stringify(envRes?.result))

  results.stderrBytes = stderrBuf.length
  results.stderrSample = stderrBuf.slice(0, 400)
} catch (e) {
  results.fatal = String(e.message)
  results.stdoutSoFar = lines.slice(0, 5)
  results.stderrSample = stderrBuf.slice(0, 800)
} finally {
  child.stdin.end()
  await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000) })
  results.exitCode = child.exitCode
}

results.ok = results.steps.every((s) => s.ok) && !results.fatal
console.log(JSON.stringify(results, null, 2))
process.exit(results.ok ? 0 : 1)
