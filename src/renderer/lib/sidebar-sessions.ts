import type { AgentSession, EffortLevel } from '../../shared/types'
import { tabSessionStatus } from './session-reattach'

/** The fields of DashboardView's `TerminalTab` the sidebar entry is built from. */
export interface SidebarTab {
  id: string
  key: string
  cwd: string
  projectId?: string
  roleId?: string
  model?: string
  effortLevel?: EffortLevel
  ended?: boolean
  idleSuspendedAt?: string
  resumeSessionId?: string
}

/** One lane's entry and the inputs it was built from. `seenAt` is when the lane first got an
 *  entry; an untracked lane reads it as its start. `lastActivityAt` is the last tracked session's,
 *  or `seenAt` for a lane never tracked: a lane the observer stops tracking (it exited) keeps the
 *  last activity it had, not its launch time. */
export interface SidebarEntry {
  tab: SidebarTab
  tracked: AgentSession | undefined
  seenAt: string
  lastActivityAt: string
  session: AgentSession
}

/** The sidebar's session per terminal, as one entry object per lane FOR AS LONG AS its tab and its
 *  tracked session are the same objects. Rebuilt every render, a new object per lane per render,
 *  every retained render of DashboardView kept its own copy of every lane (renderer leak,
 *  dev/results/renderer-leak-live-lanes-2026-10-26.md). `prev` is the last call's `cache`; an entry
 *  whose inputs are unchanged comes back as the same object, and a lane gone from `terminals`
 *  drops out of the cache. */
export function sidebarSessions(
  terminals: readonly SidebarTab[],
  sessions: readonly AgentSession[],
  prev: ReadonlyMap<string, SidebarEntry>,
  now: () => string = () => new Date().toISOString(),
): { sessions: AgentSession[]; cache: Map<string, SidebarEntry> } {
  const cache = new Map<string, SidebarEntry>()
  const out = terminals.map((t) => {
    const hookSession = sessions.find((s) => s.terminalId === t.id)
    const last = prev.get(t.id)
    if (last && last.tab === t && last.tracked === hookSession) {
      cache.set(t.id, last)
      return last.session
    }
    const seenAt = last?.seenAt ?? now()
    const lastActivityAt = hookSession?.lastActivityAt ?? last?.lastActivityAt ?? seenAt
    const session = entryFor(t, hookSession, seenAt, lastActivityAt)
    cache.set(t.id, { tab: t, tracked: hookSession, seenAt, lastActivityAt, session })
    return session
  })
  return { sessions: out, cache }
}

function entryFor(t: SidebarTab, hookSession: AgentSession | undefined, seenAt: string, lastActivityAt: string): AgentSession {
  // Operator-side fields the transcript observer can't know (it only sees the JSONL):
  // project/role linkage + the launch model/effort. Overlay them onto the tracked session
  // too — otherwise a session drops its projectId/roleId (→ sidebar group jump, lost lane
  // badge) the moment the observer starts tracking it.
  // THE TAB'S OWN DEATH IS PART OF ITS IDENTITY HERE, and it was being dropped. `t.ended` is the
  // reconciled truth (`endedByBackend`, polling the backend's real `try_wait`); the observer's
  // silence is not, because `get_sessions` returns only sessions it still considers active — so a
  // lane that exits DISAPPEARS from `sessions` and the synthetic branch below used to resurrect
  // it as `status: 'active'`, permanently. Everything downstream believed that: the "N running"
  // label, `projectActivity.live`, `isOnRail` (which is why closing a project left it on the
  // rail), and `closePlan`. See `tabSessionStatus`.
  const status = tabSessionStatus(t, hookSession)
  const operatorFields = { projectId: t.projectId, roleId: t.roleId, savedKey: t.key, model: t.model, effortLevel: t.effortLevel, status, suspended: !!t.idleSuspendedAt || undefined }
  // Model precedence: the tab's model (launch config / the user's pill pick — updated the
  // instant they act) wins over the transcript, which lags an assistant turn behind and
  // would otherwise revert a fresh /model switch. The transcript fills the blank for
  // account-default launches, and transcript CHANGES are synced into the tab (DashboardView).
  // `runningModel` is the transcript's OWN reading (latest assistant message) and is carried
  // separately on purpose: the `model` merge below prefers the tab, so the observation would
  // otherwise be erased by the very launch config it is worth comparing against. `<synthetic>`
  // is the observer's placeholder, not a model — the same value the adopt-changes effect skips.
  if (hookSession) return {
    ...hookSession,
    ...operatorFields,
    model: t.model ?? hookSession.model,
    runningModel: hookSession.model && !hookSession.model.startsWith('<') ? hookSession.model : undefined,
  }
  return {
    // A tab restored suspended has no tracked session; its Claude session id keeps its name and
    // stays the id once it is resumed and tracked again.
    id: t.idleSuspendedAt && t.resumeSessionId ? t.resumeSessionId : `local-${t.id}`,
    agentId: 'claude-code',
    workingDirectory: t.cwd,
    projectName: t.cwd.split('/').pop() || t.cwd,
    ...operatorFields,
    phase: 'idle' as const,
    activity: [],
    activeSubagents: 0,
    lastToolName: null,
    // When the lane first got an entry, not the render's clock: a time read per render made the
    // entry a new object every render even when nothing about the lane had changed.
    startedAt: seenAt,
    lastActivityAt,
    terminalId: t.id,
  }
}
