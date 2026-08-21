// S1 acceptance: does a sentinel written into a lane's transcript actually REACH THE RENDERER?
//
// The unit tests prove the tailer emits; this proves the whole path a dispatch travels:
//
//   jsonl on disk → Transcript.tick → main broadcast(eventChannel) → ipcRenderer.on in the
//   REAL preload → the callback a renderer registered
//
// Run under Electron (`npx electron probes/s1-sentinel-roundtrip.cjs`) because the middle three
// steps only exist there. Everything is sandboxed: its own HOME, its own transcript, a hidden
// window on a data: URL.
// `.cjs`, not `.mjs`: this package is `"type": "module"`, and an ESM main cannot `require` the
// CJS bundles it needs to test.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync, appendFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const SANDBOX = join(tmpdir(), `sentinel-rt-${Date.now()}`)
const SESSION = '00000000-1111-2222-3333-444444444444'
const dir = join(SANDBOX, '.claude', 'projects', '-sandbox')
const file = join(dir, `${SESSION}.jsonl`)
mkdirSync(dir, { recursive: true })
mkdirSync(join(SANDBOX, 'operator-home'), { recursive: true })
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')
writeFileSync(file, '')

const { Transcript } = require('../out/main/transcript.cjs')
const { eventChannel } = require('../out/main/event-channel.cjs')

const TS = '2026-08-20T10:00:00Z'
const assistantText = (text) => JSON.stringify({
  type: 'assistant', timestamp: TS,
  message: { id: `m${Math.random()}`, model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
}) + '\n'

const fail = []
const check = (name, ok, detail) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fail.push(name) }

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, '..', 'out', 'preload', 'index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })

  // A renderer that subscribes exactly as the app's bridge does, and records what arrives.
  await win.loadURL('data:text/html,' + encodeURIComponent(`
    <title>rt</title><body><script>
      window.__seen = { dispatch: [], reply: [], sessions: 0 };
      const n = window.__operatorNative;
      n.onOrchestratorDispatch((d) => window.__seen.dispatch.push(d));
      n.onOrchestratorReply((r) => window.__seen.reply.push(r));
      n.onSessionUpdate((s) => { window.__seen.sessions = s.length; });
      window.__ready = true;
    </script></body>`))
  check('the preload exposed the subscriptions', await win.webContents.executeJavaScript('window.__ready === true'))

  // Main, wired exactly as index.ts wires it.
  const t = new Transcript()
  t.register('t0', { claudeSessionId: SESSION, cwd: '/sandbox/proj', projectId: 'proj-42' })
  t.on('dispatch', (d) => win.webContents.send(eventChannel('onOrchestratorDispatch'), d))
  t.on('reply', (r) => win.webContents.send(eventChannel('onOrchestratorReply'), r))
  t.on('sessions', (s) => win.webContents.send(eventChannel('onSessionUpdate'), s))

  const tick = () => t.tick({ isAlive: () => true, isActive: () => false })
  await tick()

  // A lane writes a dispatch, a reply, and a QUOTED dispatch that must not fire.
  appendFileSync(file, assistantText('Handing this over.\nOPERATOR-DISPATCH [qa] verify the drop guard'))
  appendFileSync(file, assistantText('OPERATOR-REPLY [operator] tailer parity confirmed'))
  appendFileSync(file, assistantText('For reference:\n```\nOPERATOR-DISPATCH [code] do not run me\n```'))
  await tick()
  await new Promise((r) => setTimeout(r, 300))  // let the IPC land

  const seen = await win.webContents.executeJavaScript('window.__seen')

  check('the dispatch reached the renderer', seen.dispatch.length === 1, JSON.stringify(seen.dispatch[0]?.task))
  check('  with the right role', seen.dispatch[0]?.role === 'qa', seen.dispatch[0]?.role)
  check('  and the lane it came from', seen.dispatch[0]?.terminalId === 't0' && seen.dispatch[0]?.sessionId === SESSION)
  check('  and a stable id', /^[0-9a-f]{16}$/.test(seen.dispatch[0]?.id ?? ''), seen.dispatch[0]?.id)
  check('the QUOTED dispatch did NOT fire', seen.dispatch.length === 1, `${seen.dispatch.length} dispatch(es) total`)

  check('the reply reached the renderer', seen.reply.length === 1, JSON.stringify(seen.reply[0]?.text))
  check('  addressed to operator', seen.reply[0]?.to === 'operator')
  check('  stamped with the project id', seen.reply[0]?.projectId === 'proj-42', seen.reply[0]?.projectId)

  check('session:update also reached the renderer', seen.sessions >= 1, `${seen.sessions} session(s)`)

  // Re-reading the same transcript must NOT re-fire — the ids are content hashes and the
  // frontend's seen-set drops repeats, but the tailer should not replay from its own offset.
  await tick()
  await new Promise((r) => setTimeout(r, 200))
  const again = await win.webContents.executeJavaScript('window.__seen')
  check('a second tick re-fires nothing', again.dispatch.length === 1 && again.reply.length === 1,
        `${again.dispatch.length} dispatch, ${again.reply.length} reply`)

  rmSync(SANDBOX, { recursive: true, force: true })
  console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nsentinel round-trip confirmed')
  app.exit(fail.length ? 1 : 0)
})
