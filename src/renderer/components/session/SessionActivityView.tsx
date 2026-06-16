import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentSession, ActivityEntry } from '../../../shared/types'

/** A timeline entry augmented with a computed duration. */
type TimedEntry = ActivityEntry & { durMs?: number; live?: boolean }

interface Props {
  session: AgentSession
}

export function SessionActivityView({ session }: Props) {
  const timelineRef = useRef<HTMLDivElement>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const activity = session.activity || []
  const delegations = activity.filter((a) => a.kind === 'delegate').length

  // Tick once a second while the agent is working so the in-flight tool's
  // elapsed time updates live.
  useEffect(() => {
    if (session.phase !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [session.phase])

  // Each tool's duration is approximated by the gap until the next event; the
  // last event, while the agent is running, ticks live.
  const timed = useMemo<TimedEntry[]>(() => activity.map((e, i) => {
    const t = Date.parse(e.timestamp)
    if (!isFinite(t)) return e
    if (i < activity.length - 1) {
      const tn = Date.parse(activity[i + 1].timestamp)
      return isFinite(tn) && tn >= t ? { ...e, durMs: tn - t } : e
    }
    if (session.phase === 'running') return { ...e, durMs: Math.max(0, now - t), live: true }
    return e
  }), [activity, session.phase, now])

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight
    }
  }, [activity.length])

  const started = new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const lastActivity = new Date(session.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter', system-ui, sans-serif",
        color: 'var(--fg)',
        minHeight: 0,
      }}
    >
      {/* Compact header — click to expand details */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 20px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          background: 'none',
          border: 'none',
          borderBottomStyle: 'solid',
          borderBottomWidth: 1,
          borderBottomColor: 'var(--border)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <StatusDot phase={session.phase} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>Orchestration</span>
        {session.lastToolName && (
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5 }}>
            — {session.lastToolName}
          </span>
        )}
        {session.activeSubagents > 0 && (
          <span style={{ fontSize: 9, color: 'var(--fg-on-accent)', background: 'var(--accent)', borderRadius: 8, padding: '1px 7px', fontWeight: 600 }}>
            {session.activeSubagents} agent{session.activeSubagents === 1 ? '' : 's'} running
          </span>
        )}
        {delegations > 0 && (
          <span style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.6 }}>
            {delegations} delegation{delegations === 1 ? '' : 's'}
          </span>
        )}
        <span style={{
          marginLeft: 'auto',
          fontSize: 7,
          color: 'var(--fg-muted)',
          opacity: 0.3,
          transform: showDetails ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.15s',
          display: 'inline-block',
        }}>
          &#9660;
        </span>
      </button>

      {/* Expandable details */}
      {showDetails && (
        <div style={{
          padding: '8px 20px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          fontSize: 10,
          color: 'var(--fg-muted)',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
          <span>{session.workingDirectory}</span>
          <div style={{ display: 'flex', gap: 16 }}>
            <span>Started {started}</span>
            <span>Last activity {lastActivity}</span>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div
        ref={timelineRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {activity.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 40 }}>
            <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              No activity yet
            </p>
            <p style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5, marginTop: 8, lineHeight: 1.6 }}>
              Tool calls and subagent delegations will appear here as the agent works.
            </p>
          </div>
        )}
        {renderNodes(buildTree(timed), 0)}
      </div>
    </div>
  )
}

interface TreeNode { entry: TimedEntry; children: TreeNode[] }

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

function DurationTag({ entry }: { entry: TimedEntry }) {
  if (entry.durMs === undefined) return null
  return (
    <span style={{
      marginLeft: 'auto', flexShrink: 0, fontSize: 10, fontVariantNumeric: 'tabular-nums',
      color: entry.live ? 'var(--accent)' : 'var(--fg-muted)',
      opacity: entry.live ? 0.9 : 0.45,
    }}>
      {fmtDur(entry.durMs)}{entry.live ? '…' : ''}
    </span>
  )
}

/**
 * Build a nesting tree from the flat timeline (best-effort, heuristic):
 * a delegation owns the subagent it spawns, and a SubagentStart opens a group
 * that subsequent tool calls nest into until the matching SubagentStop. With
 * parallel subagents this is LIFO and may mis-attribute siblings — it's an
 * approximation, since hooks don't tag tool calls with a subagent id.
 */
function buildTree(activity: TimedEntry[]): TreeNode[] {
  const root: TreeNode[] = []
  const stack: TreeNode[][] = [root] // top of stack = current insertion list
  let pendingDelegate: TreeNode | null = null

  for (const entry of activity) {
    const current = stack[stack.length - 1]

    if (entry.kind === 'subagent') {
      if (entry.toolName.includes('finished')) {
        if (stack.length > 1) stack.pop() // close the most recent group
        pendingDelegate = null
        continue
      }
      // SubagentStart — open a group, nested under the delegation that spawned it if any.
      const node: TreeNode = { entry, children: [] }
      if (pendingDelegate) { pendingDelegate.children.push(node); pendingDelegate = null }
      else current.push(node)
      stack.push(node.children)
      continue
    }

    const node: TreeNode = { entry, children: [] }
    current.push(node)
    pendingDelegate = entry.kind === 'delegate' ? node : null
  }
  return root
}

function renderNodes(nodes: TreeNode[], depth: number): React.ReactNode {
  return nodes.map((n, i) => (
    <div key={`${depth}-${i}`}>
      <TimelineRow entry={n.entry} />
      {n.children.length > 0 && (
        <div style={{ marginLeft: 11, paddingLeft: 9, borderLeft: '1px solid var(--border)' }}>
          {renderNodes(n.children, depth + 1)}
        </div>
      )}
    </div>
  ))
}

function TimelineRow({ entry }: { entry: TimedEntry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  // Subagent group header (SubagentStart). Its tool calls nest beneath it.
  if (entry.kind === 'subagent') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px' }}>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', width: 56, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
        <span style={{ fontSize: 10, color: 'var(--accent)' }}>▸</span>
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>
          Subagent{entry.detail ? ` · ${entry.detail}` : ' running'}
        </span>
        <DurationTag entry={entry} />
      </div>
    )
  }

  // Delegation — the lead agent handed work to a subagent. Branch-styled.
  if (entry.kind === 'delegate') {
    return (
      <div style={{
        display: 'flex', gap: 10, padding: '6px 8px',
        borderRadius: 5, background: 'var(--overlay-subtle)',
      }}>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', width: 48, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
        <span style={{ color: 'var(--accent)', fontSize: 12, flexShrink: 0, lineHeight: '16px' }}>↳</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, lineHeight: '16px' }}>
            <span style={{ color: 'var(--fg-muted)' }}>Delegated to </span>
            <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{entry.target || 'agent'}</span>
          </div>
          {entry.detail && (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.detail}
            </div>
          )}
        </div>
        <DurationTag entry={entry} />
        <StatusTag status={entry.status} />
      </div>
    )
  }

  // Ordinary tool call.
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 8px',
        borderRadius: 4,
        background: entry.status === 'pending' ? 'rgba(234, 179, 8, 0.08)' : 'transparent',
        fontSize: 12,
      }}
    >
      <span style={{ fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0, width: 56, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
      <span style={{ fontWeight: 500, flexShrink: 0 }}>{entry.toolName}</span>
      {entry.target && (
        <span style={{ color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
          {entry.target}
        </span>
      )}
      <DurationTag entry={entry} />
      <StatusTag status={entry.status} />
    </div>
  )
}

function StatusTag({ status }: { status: ActivityEntry['status'] }) {
  if (status === 'auto') return <span style={{ marginLeft: 'auto', flexShrink: 0 }} />
  return (
    <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: statusColor(status) }}>
      {status}
    </span>
  )
}

function StatusDot({ phase }: { phase: string }) {
  const isRunning = phase === 'running'
  const isCompacting = phase === 'compacting'
  const color = isRunning ? 'var(--green)' : isCompacting ? 'var(--cyan)' : 'var(--fg-muted)'
  return (
    <span style={{
      width: 7, height: 7, borderRadius: '50%',
      background: 'transparent', border: `1.5px solid ${color}`,
      boxSizing: 'border-box',
      flexShrink: 0,
      animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : undefined,
    }} />
  )
}

function statusColor(status: string): string {
  switch (status) {
    case 'approved': return 'var(--green)'
    case 'denied': return 'var(--red)'
    case 'pending': return 'var(--yellow)'
    default: return 'var(--fg-muted)'
  }
}
