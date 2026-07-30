// Throwaway extractor for the chat-view regression pass (dev/qa-chat-regression.md).
// Pulls REAL project/roster config + REAL chat.db history for two real "operator" project
// sessions into one fixture JSON that dev/qa-real-bridge.ts serves to the real renderer.
// Not committed; delete after the QA pass.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const HOME = homedir()
const chatDb = `${HOME}/.operator/chat.db`
const projects = JSON.parse(readFileSync(`${HOME}/.operator/projects.json`, 'utf8'))
const sessions = JSON.parse(readFileSync(`${HOME}/.operator/sessions.json`, 'utf8'))

const project = projects.find((p) => p.id === 'operator-3cfdffb0')
const { tasks, dispatches, ...projectLite } = project

function loadMessages(sessionId) {
  const out = execFileSync('sqlite3', ['-json', chatDb,
    `SELECT kind, text, ts, images, tool FROM messages WHERE session_id='${sessionId}' ORDER BY seq ASC;`])
  return JSON.parse(out.toString() || '[]').map((m) => ({
    kind: m.kind, text: m.text, timestamp: m.ts,
    images: m.images ? JSON.parse(m.images) : undefined,
    tool: m.tool ? JSON.parse(m.tool) : undefined,
  }))
}

const LONG_HISTORY_ID = 'e5893b67-e01f-40ee-b2b4-3e7e52bb3757'   // 862 real messages, this project
const BIG_MSG_ID = 'a1d8d389-0774-451f-87d1-445a2a2f8863'         // 114 msgs, incl. a real 10,268-char answer

const bigMsgMeta = sessions.find((s) => s.claudeSessionId === BIG_MSG_ID)

const fixture = {
  project: projectLite,
  sessions: [
    {
      id: LONG_HISTORY_ID,
      terminalId: 't-qa-long',
      roleId: undefined,
      model: 'sonnet',
      summary: '(real 862-message operator-project history, pre-dating this run)',
      messages: loadMessages(LONG_HISTORY_ID),
    },
    {
      id: BIG_MSG_ID,
      terminalId: 't-qa-big',
      roleId: bigMsgMeta?.roleId,
      model: bigMsgMeta?.model,
      effortLevel: bigMsgMeta?.effortLevel,
      summary: '(real Research-lane session, includes a real 10,268-char answer)',
      messages: loadMessages(BIG_MSG_ID),
    },
  ],
}

writeFileSync(new URL('./qa-real-fixture.json', import.meta.url), JSON.stringify(fixture))
console.log('wrote qa-real-fixture.json:',
  fixture.sessions.map((s) => `${s.id.slice(0, 8)}: ${s.messages.length} real messages`).join(', '))
