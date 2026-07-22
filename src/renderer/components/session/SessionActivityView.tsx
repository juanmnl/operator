import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentSession, ActivityEntry } from '../../../shared/types'
import { fmtDur } from '../../lib/format'
import { buildActivityTree, type TreeNode as LibTreeNode } from '../../lib/activity-tree'

/** A timeline entry augmented with a computed duration. */
type TimedEntry = ActivityEntry & { durMs?: number; live?: boolean }
type TreeNode = LibTreeNode<TimedEntry>

interface Props {
  session: AgentSession
}

export function SessionActivityView({ session }: Props) {
  const timelineRef = useRef<HTMLDivElement>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const activity = session.activity || []
  const delegations = activity.filter((a) => a.kind === 'delegate').length
  const toolCount = activity.filter((a) => !a.kind || a.kind === 'tool').length

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
        fontFamily: "var(--font-body)",
        color: 'var(--fg)',
        minHeight: 0,
      }}
    >
      {/* Panel-bar header (landing `.panel-bar`) — click to expand details. Mono
          name + a right-aligned LIVE flag while the agent works (no pulsing dot). */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="op-bar"
        style={{
          flexShrink: 0,
          background: 'none',
          border: 'none',
          borderBottom: '1px solid var(--border)',
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <StatusDot phase={session.phase} />
        <span className="op-bar-name">operating</span>
        {session.activeSubagents > 0 && (
          <span className="op-badge sonnet">{session.activeSubagents} sub</span>
        )}
        {session.phase === 'running'
          ? <span className="op-flag">live</span>
          : <span className="op-flag" style={{ color: 'var(--muted)' }}>{session.phase}</span>}
        <span style={{
          fontSize: 7,
          color: 'var(--fg-muted)',
          opacity: 0.4,
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
          padding: '6px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}
      >
        {activity.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 40, fontFamily: 'var(--font-body)' }}>
            <p style={{ fontFamily: 'var(--font-disp)', fontSize: 15, fontWeight: 600, color: 'var(--fg)', opacity: 0.9 }}>
              No activity yet
            </p>
            <p style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.6, marginTop: 6, lineHeight: 1.6 }}>
              Tool calls and subagent delegations will appear here as the agent works.
            </p>
          </div>
        )}
        {renderNodes(buildActivityTree(timed), 0)}
      </div>

      {/* Panel-foot (landing `.panel-foot`) — mono counts of what's happened. */}
      {activity.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '1.1rem', flexShrink: 0,
          padding: '6px 14px', borderTop: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-muted)',
        }}>
          <span><b style={{ color: 'var(--fg)', fontWeight: 700 }}>{toolCount}</b> tool{toolCount === 1 ? '' : 's'}</span>
          {delegations > 0 && <span><b style={{ color: 'var(--fg)', fontWeight: 700 }}>{delegations}</b> subagent{delegations === 1 ? '' : 's'}</span>}
        </div>
      )}
    </div>
  )
}

function DurationTag({ entry }: { entry: TimedEntry }) {
  if (entry.durMs === undefined) return null
  return <span className="op-dur">{fmtDur(entry.durMs)}{entry.live ? '…' : ''}</span>
}

function renderNodes(nodes: TreeNode[], depth: number): React.ReactNode {
  return nodes.map((n, i) => (
    <div key={`${depth}-${i}`}>
      <TimelineRow entry={n.entry} />
      {n.children.length > 0 && (
        <div className="op-nest">
          {renderNodes(n.children, depth + 1)}
        </div>
      )}
    </div>
  ))
}

/** Glyph per row kind — ◆ mutating tools, ◇ read-only, ⤷ delegate, ▸ subagent. */
function glyphFor(entry: TimedEntry): string {
  if (entry.kind === 'delegate') return '⤷'
  if (entry.kind === 'subagent') return '▸'
  return /edit|write|create|multiedit|notebook/i.test(entry.toolName) ? '◆' : '◇'
}

function TimelineRow({ entry }: { entry: TimedEntry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const glyph = glyphFor(entry)

  // Subagent group header (SubagentStart). Its tool calls nest beneath it.
  if (entry.kind === 'subagent') {
    return (
      <div className="op-row" title={time}>
        <span className="op-g" style={{ color: 'var(--accent)' }}>{glyph}</span>
        <span className="op-lbl" style={{ color: 'var(--fg)' }}>{entry.detail || 'subagent'}</span>
        <DurationTag entry={entry} />
      </div>
    )
  }

  // Delegation — the lead agent handed work to a subagent.
  if (entry.kind === 'delegate') {
    return (
      <div className="op-row is-delegate" title={time}>
        <span className="op-g" style={{ color: 'var(--accent)' }}>{glyph}</span>
        <span className="op-lbl">delegate › {entry.target || 'agent'}</span>
        {entry.detail && <span className="op-meta">{entry.detail}</span>}
        <DurationTag entry={entry} />
      </div>
    )
  }

  // Ordinary tool call. Live → accent row; pending → dimmed "queued".
  const cls = `op-row${entry.live ? ' is-live' : ''}${entry.status === 'pending' ? ' is-queued' : ''}`
  return (
    <div className={cls} title={time}>
      <span className="op-g">{glyph}</span>
      <span className="op-lbl">{entry.toolName}</span>
      {entry.target && <span className="op-meta">{entry.target}</span>}
      {entry.status === 'pending'
        ? <span className="op-dur">queued</span>
        : <DurationTag entry={entry} />}
      {entry.status === 'denied' && <span style={{ flexShrink: 0, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--del-fg, var(--red))' }}>denied</span>}
    </div>
  )
}

function StatusDot({ phase }: { phase: string }) {
  const isRunning = phase === 'running'
  const isCompacting = phase === 'compacting'
  const isWaiting = phase === 'waiting'
  const color = isRunning ? 'var(--green)' : isCompacting ? 'var(--cyan)' : isWaiting ? 'var(--accent)' : 'var(--fg-muted)'
  // A SOLID dot: dynamic BACKGROUND on a rounded fill is cheap. The old version was
  // a hollow ring (`border: 1.5px solid ${color}` on `borderRadius:50%`) PLUS an
  // infinite `pulse` — a colour-changing border on a rounded element re-rasterizes
  // the border layer in WKWebView every frame, and one of these renders per activity
  // row on every session:update → a compositor paint-storm that pegs the app (this is
  // the "dynamic border + radius freezes" rule). No border, no pulse — also drops the
  // banned pulsating status dot.
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%',
      background: color,
      flexShrink: 0,
    }} />
  )
}

