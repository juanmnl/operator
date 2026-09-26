import { Transcript } from './transcript.bundle.mjs'
const ids = process.argv.slice(2)
const tr = new Transcript(); let n = 0, bytes = 0, toolN = 0
tr.on('chat', (sid, entries) => { n += entries.length; for (const [, e] of entries) { bytes += (e.text?.length || 0) + (e.tool ? JSON.stringify(e.tool).length : 0); if (e.tool) toolN++ } })
ids.forEach((id, i) => tr.register('t' + i, { claudeSessionId: id, cwd: '/tmp', projectId: 'x' }))
await tr.tick({ isAlive: () => true, isActive: () => false })
console.log(JSON.stringify({ entriesQueuedForChatDb: n, toolEntries: toolN, textMB: +(bytes / 1048576).toFixed(1), avgBytes: Math.round(bytes / n) }))
