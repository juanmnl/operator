import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project, SavedSession, TuningData } from '../../../shared/types'
import { PageShell, sectionHeader, sectionDesc, SECTION_GAP } from '../settings/PageShell'
import { TONE_FILL, toneFor, readable, hasData, usePlanLimits } from '../../lib/plan-limits'
import { modelFamilyLabel } from '../../lib/roster'
import {
  joinLanes, biggestChange, cacheHealth, formatTokens, formatCost, formatChars,
  UNATTRIBUTED, type LaneRow,
} from '../../lib/tuning'

// THE TUNING PAGE. Design: `dev/results/usage-view-design.md`; mock: `dev/usage-preview.html`.
//
// The rule the whole page obeys, and the difference between it and the `UsageView` that was
// deleted: EVERY NUMBER IS NEXT TO THE CHANGE IT ARGUES FOR, OR IT SAYS THERE IS NO CHANGE TO
// MAKE. The old view was a spend report — five stat tiles, a daily bar chart, two tables — with
// generic advice underneath. You could read it for a minute and change nothing, which is what
// happened to it.
//
// The knobs that exist are exactly two: a role's model and effort, and its charter. Every section
// here lands on one of those or admits it has none (§ Context pressure does exactly that).
//
// TOKENS ARE THE HEADLINE. Cost appears once per row, right-aligned, muted, at 11px. It is the
// sanity check, never the ranking.

const RANGES = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const

/** Numbers never move when a value changes: every numeric cell is tabular and fixed-width, so a
 *  column stays a column. */
const NUM: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }

/** A control's label is body ink, not meta ink — so it is a mix of `--fg`, never `--fg-muted`
 *  with opacity stacked on it (see `feedback_muted_opacity_rule`). */
const CONTROL_INK = 'color-mix(in srgb, var(--fg) 72%, transparent)'

const card: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-surface)',
  padding: '14px 16px',
}

/** Every chip on this page: transparent, bordered, colour on the text and the border and never
 *  as a fill. */
function Chip({ children, tone = 'muted', dashed }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warn'; dashed?: boolean }) {
  const color = tone === 'accent' ? 'var(--accent)' : tone === 'warn' ? 'var(--yellow)' : 'var(--fg-muted)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', height: 16, padding: '0 6px',
      border: `1px ${dashed ? 'dashed' : 'solid'} ${color}`, borderRadius: 4,
      background: 'transparent', color,
      fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase',
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>{children}</span>
  )
}

/** A token bar. Background and no border — a radiused element with a changing border colour is
 *  the WKWebView rule this app already carries. */
function Bar({ pct, color = 'var(--accent)' }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 4, borderRadius: 2, background: 'var(--overlay-subtle)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', borderRadius: 2, background: color }} />
    </div>
  )
}

export function TuningView({ projects, saved, onOpenRoster }: {
  projects: Project[]
  saved: SavedSession[]
  /** Open a role in the roster — the whole point of the card and of every `Roster` button. */
  onOpenRoster?: (projectId: string | undefined, roleId: string | undefined) => void
}) {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<TuningData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const { limits, loading: limitsLoading } = usePlanLimits()

  const load = useCallback((d: number) => {
    setLoading(true)
    setError(null)
    window.operator.getTuning(d)
      .then((r) => { setData(r); setLoading(false) })
      .catch((e) => { setError(String(e)); setLoading(false) })
  }, [])

  useEffect(() => { load(days) }, [days, load])

  const lanes = useMemo(() => data
    ? joinLanes({ bySession: data.bySession, byEffort: data.byEffort, toolOutput: data.toolOutput, projects, saved })
    : [], [data, projects, saved])

  const card1 = useMemo(() => biggestChange(lanes, days), [lanes, days])
  const totalTokens = data?.totalTokens ?? 0
  const maxLane = lanes.reduce((n, l) => Math.max(n, l.tokens), 0)

  return (
    <PageShell
      title="Tuning"
      subtitle="Where the window went, and the one change that would move it. Tokens are the measure; cost rides along as a check."
      measure="grid"
    >
      {/* Range. The active option is `--fg` text on `--btn-bg`, matching the PageShell tab bar —
          no solid accent fill for state anywhere on this page. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: SECTION_GAP }}>
        {RANGES.map((r) => (
          <button
            key={r.days}
            onClick={() => setDays(r.days)}
            style={{
              padding: '4px 12px', borderRadius: 6, cursor: 'pointer', outline: 'none',
              border: '1px solid var(--border)',
              background: days === r.days ? 'var(--btn-bg)' : 'transparent',
              color: days === r.days ? 'var(--fg)' : CONTROL_INK,
              fontFamily: 'var(--font-body)', fontSize: 11.5,
            }}
          >{r.label}</button>
        ))}
        <span style={{ marginLeft: 'auto', ...NUM, fontSize: 10.5, color: 'var(--fg-muted)' }}>
          {loading ? 'Reading transcripts…' : `${formatTokens(totalTokens)} tokens · ${formatCost(data?.totalCost ?? 0)}`}
        </span>
      </div>

      {error && (
        <div style={{ ...card, marginBottom: SECTION_GAP, fontSize: 11.5 }}>
          Couldn&apos;t read the transcripts. {error}{' '}
          <button onClick={() => load(days)} style={linkBtn}>retry</button>
        </div>
      )}

      {/* LOADING — a real wait: the parse walks every project directory. One empty track rather
          than a spinner, so the page does not jump when it fills. */}
      {loading && !data && (
        <div style={{ ...card, marginBottom: SECTION_GAP }}>
          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--fg-muted)' }}>Reading transcripts…</p>
          <div style={{ marginTop: 10 }}><Bar pct={0} /></div>
        </div>
      )}

      {data && !loading && lanes.length === 0 && (
        <div style={{ ...card, marginBottom: SECTION_GAP }}>
          <p style={{ margin: 0, fontSize: 12 }}>
            Nothing ran {days === 1 ? 'today' : `in the last ${days} days`}.{' '}
            Widen the range, or start a lane.
          </p>
        </div>
      )}

      {data && lanes.length > 0 && (
        <>
          <BiggestChange card={card1} onOpenRoster={onOpenRoster} />
          <SpendByLane lanes={lanes} maxLane={maxLane} onOpenRoster={onOpenRoster} />
          <ProjectShare data={data} limits={limits} limitsLoading={limitsLoading} />
          <ContextPressure lanes={lanes} />
          <ToolOutput lanes={lanes} onOpenRoster={onOpenRoster} />
          <Cache data={data} />
        </>
      )}
    </PageShell>
  )
}

// ── 3.1 Biggest single change ────────────────────────────────────────────────────────────────

function BiggestChange({ card: c, onOpenRoster }: { card: ReturnType<typeof biggestChange>; onOpenRoster?: (p?: string, r?: string) => void }) {
  return (
    <section style={{ marginBottom: SECTION_GAP }}>
      <div style={{ ...card, borderColor: c.kind === 'change' ? 'var(--accent)' : 'var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ ...sectionHeader, margin: 0 }}>Biggest single change</h3>
          {c.kind === 'change' && <Chip tone="accent">estimate</Chip>}
        </div>
        <p style={{ margin: '0 0 6px', fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg)' }}>{c.headline}</p>
        <p style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.55, color: 'var(--fg-muted)' }}>{c.detail}</p>
        {c.kind === 'change' && c.lane?.roleId && (
          <>
            <button onClick={() => onOpenRoster?.(c.lane!.projectId, c.lane!.roleId)} style={primaryBtn}>
              Open {c.lane.name} in the roster
            </button>
            {/* THE CARD RANKS, IT DOES NOT FORECAST. A step down the ladder has no known token
                multiplier, and inventing one would be the same class of error as showing 0% for
                a number that is absent. */}
            <p style={{ margin: '8px 0 0', fontSize: 10.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
              Ranked by share of the window, not by a predicted saving.{' '}
              A step down the effort ladder has no fixed token multiplier, so none is claimed.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

// ── 3.2 Spend by lane ────────────────────────────────────────────────────────────────────────

function SpendByLane({ lanes, maxLane, onOpenRoster }: { lanes: LaneRow[]; maxLane: number; onOpenRoster?: (p?: string, r?: string) => void }) {
  return (
    <section style={{ marginBottom: SECTION_GAP }}>
      <h3 style={sectionHeader}>Spend by lane</h3>
      <p style={sectionDesc}>
        Lane × model × effort. Effort is what the transcript reports — the value that actually
        ran, so a mid-session <code style={{ fontFamily: 'var(--font-mono)' }}>/effort</code> shows
        here even though the roster pin never heard about it.
      </p>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        {lanes.map((l, i) => (
          <div key={l.key} style={{ padding: '10px 14px', borderBottom: i < lanes.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Lane identity is a 7px filled dot — never a coloured left-border stripe. */}
              <span style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: l.accent ?? 'var(--fg-muted)',
              }} />
              <span style={{ fontSize: 12.5, color: 'var(--fg)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.name}
              </span>
              {l.key === UNATTRIBUTED && <Chip>no lane on record</Chip>}
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.projectName}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                <span style={{ ...NUM, fontSize: 10.5, color: CONTROL_INK, width: 150, textAlign: 'right' }}>
                  {l.model ? modelFamilyLabel(l.model) : '—'}{l.effort ? ` · ${l.effort}` : ''}
                </span>
                <span style={{ width: 90 }}><Bar pct={maxLane ? (l.tokens / maxLane) * 100 : 0} color={l.accent ?? 'var(--accent)'} /></span>
                <span style={{ ...NUM, fontSize: 12, color: 'var(--fg)', width: 62, textAlign: 'right' }}>{formatTokens(l.tokens)}</span>
                <span style={{ ...NUM, fontSize: 11, color: 'var(--fg-muted)', width: 42, textAlign: 'right' }}>{Math.round(l.share * 100)}%</span>
                <span style={{ ...NUM, fontSize: 11, color: 'var(--fg-muted)', width: 54, textAlign: 'right' }}>{formatCost(l.cost)}</span>
              </span>
            </div>
            {/* The advice is a sentence, so it gets a line — not a 90px column of two-word
                fragments. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 5, paddingLeft: 17 }}>
              <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--fg-muted)', minWidth: 0 }}>
                {laneNote(l)}
              </span>
              {l.roleId && (
                <button onClick={() => onOpenRoster?.(l.projectId, l.roleId)} style={{ ...linkBtn, marginLeft: 'auto', flexShrink: 0 }}>Roster</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** What to change about this lane, or why there is nothing to say. Never a forecast. */
function laneNote(l: LaneRow): string {
  if (l.key === UNATTRIBUTED) {
    return 'Transcripts no saved session claims — started outside Operator, or from a lane since forgotten. '
      + 'Counted here so the shares still sum.'
  }
  if (l.effort && l.pinnedEffort && l.effort !== l.pinnedEffort) {
    return `Ran at ${l.effort}; the roster would launch it at ${l.pinnedEffort}. `
      + 'The transcript wins — something changed it mid-session.'
  }
  if (l.effortInherited && l.pinnedEffort) {
    return `Effort is inherited, resolving to ${l.pinnedEffort}. Pin it on the role to change it.`
  }
  if (l.turns > 0) return `${l.turns} turns. Model and effort are set on the role.`
  return 'No turns in this window.'
}

// ── 3.3 Project share ────────────────────────────────────────────────────────────────────────

function ProjectShare({ data, limits, limitsLoading }: { data: TuningData; limits: ReturnType<typeof usePlanLimits>['limits']; limitsLoading: boolean }) {
  const total = data.byProject.reduce((n, p) => n + p.tokens, 0)
  const week = readable(limits?.weekPct)
  const known = hasData(limits)
  return (
    <section style={{ marginBottom: SECTION_GAP }}>
      <h3 style={sectionHeader}>Project share of the window</h3>
      <div style={card}>
        {/* The plan's own reading, quoted — same bar and thresholds as PlanMeter, not restated. */}
        {known && week !== null ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg)' }}>Week</span>
              <span style={{ ...NUM, fontSize: 12, color: 'var(--fg)' }}>{week}% used</span>
              {limits?.weekResets && <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>resets {limits.weekResets}</span>}
            </div>
            <Bar pct={week} color={TONE_FILL[toneFor(week)]} />
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Chip dashed>{limitsLoading ? 'reading' : 'no reading'}</Chip>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              The plan percentage comes from Claude Code and is not available right now.{' '}
              The split below still reads.
            </span>
          </div>
        )}

        {/* THE PARAGRAPH THAT KEEPS THEM APART. Two different denominators; multiplying them
            would give the plan's authority to a number the plan never saw. */}
        <p style={{ margin: '12px 0', fontSize: 11, lineHeight: 1.6, color: 'var(--fg-muted)' }}>
          The percentage above comes from Anthropic and covers everything billed to this plan.{' '}
          The split below is local transcripts on this machine — a different denominator, so it
          ranks projects against each other rather than slicing that percentage.
        </p>

        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--overlay-subtle)' }}>
          {data.byProject.slice(0, 8).map((p, i) => (
            <div key={p.slug} title={`${p.name} — ${formatTokens(p.tokens)}`}
              style={{ width: `${total ? (p.tokens / total) * 100 : 0}%`, background: PROJECT_FILL[i % PROJECT_FILL.length] }} />
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
          {data.byProject.slice(0, 8).map((p, i) => (
            <span key={p.slug} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: PROJECT_FILL[i % PROJECT_FILL.length] }} />
              <span style={{ color: 'var(--fg)' }}>{p.name}</span>
              <span style={{ ...NUM, fontSize: 10.5, color: 'var(--fg-muted)' }}>
                {formatTokens(p.tokens)} · {total ? Math.round((p.tokens / total) * 100) : 0}%
              </span>
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

const PROJECT_FILL = [
  'var(--accent)', 'var(--mcp-http, #5ac8fa)', 'var(--mcp-cloud, #c98bff)',
  'var(--green, #7ee787)', 'var(--yellow, #e3b341)', 'var(--mcp-stdio, #ff9f6b)',
]

// ── 3.4 Context pressure ─────────────────────────────────────────────────────────────────────

function ContextPressure({ lanes }: { lanes: LaneRow[] }) {
  const rows = lanes.filter((l) => l.turns > 0)
  return (
    <section style={{ marginBottom: SECTION_GAP }}>
      <h3 style={sectionHeader}>Context pressure</h3>
      {/* THIS SECTION HAS NO KNOB AND SAYS SO. Pretending effort fixes context pressure would be
          worse than admitting there is nothing to click. */}
      <p style={sectionDesc}>
        Operator has no knob for this — the change is a smaller task per lane, or a fresh lane per
        task. Compactions are counted from the transcript&apos;s own boundary records.
      </p>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <HeadRow cells={['Lane', 'Compactions', 'Re-read', '> 150k', 'Median context']} />
        {rows.map((l, i) => (
          <div key={l.key} style={rowStyle(i, rows.length)}>
            <span style={cellName}>{l.name}</span>
            <span style={{ ...cellNum, color: l.compactions > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}>{l.compactions || '—'}</span>
            <span style={cellNum}>{l.reReadTokens ? formatTokens(l.reReadTokens) : '—'}</span>
            <span style={cellNum}>{l.turns ? `${Math.round((l.highContextTurns / l.turns) * 100)}%` : '—'}</span>
            <span style={cellNum}>{l.medianContext ? formatTokens(l.medianContext) : '—'}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── 3.5 Tool output ──────────────────────────────────────────────────────────────────────────

function ToolOutput({ lanes, onOpenRoster }: { lanes: LaneRow[]; onOpenRoster?: (p?: string, r?: string) => void }) {
  const rows = lanes.filter((l) => l.toolP90 > 0)
  return (
    <section style={{ marginBottom: SECTION_GAP }}>
      <h3 style={sectionHeader}>Tool output</h3>
      <p style={sectionDesc}>
        p50 and p90 of tool-result size, never a mean — the distribution is the finding. A lane at
        p50 2k and p90 96k is not a bit chatty; it is one turn in ten swallowing half a context
        window. The knob is the role&apos;s charter.
      </p>
      {rows.length === 0 ? (
        <div style={{ ...card, fontSize: 11.5, color: 'var(--fg-muted)' }}>
          No tool output recorded in this window.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <HeadRow cells={['Lane', 'p50', 'p90', 'Top tool', '']} />
          {rows.map((l, i) => (
            <div key={l.key} style={rowStyle(i, rows.length)}>
              <span style={cellName}>{l.name}</span>
              <span style={cellNum}>{formatChars(l.toolP50)}</span>
              <span style={{ ...cellNum, color: l.toolP90 > l.toolP50 * 10 ? 'var(--yellow)' : 'var(--fg)' }}>{formatChars(l.toolP90)}</span>
              <span style={{ ...cellNum, fontFamily: 'var(--font-body)' }}>{l.topTool ?? '—'}</span>
              <span style={{ width: 90, textAlign: 'right' }}>
                {l.roleId && <button onClick={() => onOpenRoster?.(l.projectId, l.roleId)} style={linkBtn}>Edit charter</button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── 3.6 Cache ────────────────────────────────────────────────────────────────────────────────

function Cache({ data }: { data: TuningData }) {
  return (
    <section style={{ marginBottom: SECTION_GAP }}>
      <h3 style={sectionHeader}>Cache</h3>
      <p style={sectionDesc}>
        Cache reads bill at roughly a tenth of fresh input, so a high read share is a lane being
        used well — and a low one usually means sessions are being relaunched instead of continued.
      </p>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <HeadRow cells={['Model', 'Fresh / write / read', 'Read share', 'Tokens', 'Cost']} />
        {data.byModel.map((m, i) => {
          const total = m.inputTokens + m.cacheWriteTokens + m.cacheReadTokens
          const readShare = total ? m.cacheReadTokens / total : 0
          const health = cacheHealth(readShare, total + m.outputTokens)
          return (
            <div key={m.model} style={rowStyle(i, data.byModel.length)}>
              <span style={cellName}>{modelFamilyLabel(m.model)}</span>
              <span style={{ width: 150, display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--overlay-subtle)' }}>
                <span style={{ width: `${total ? (m.inputTokens / total) * 100 : 0}%`, background: 'var(--accent)' }} />
                <span style={{ width: `${total ? (m.cacheWriteTokens / total) * 100 : 0}%`, background: 'var(--yellow, #e3b341)' }} />
                <span style={{ width: `${total ? (m.cacheReadTokens / total) * 100 : 0}%`, background: 'var(--green, #7ee787)' }} />
              </span>
              <span style={{ ...cellNum, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                {Math.round(readShare * 100)}%
                {health !== 'thin' && <Chip tone={health === 'healthy' ? 'muted' : 'warn'}>{health}</Chip>}
              </span>
              <span style={cellNum}>{formatTokens(total + m.outputTokens)}</span>
              <span style={cellNum}>{formatCost(m.cost)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── shared row furniture ─────────────────────────────────────────────────────────────────────

function HeadRow({ cells }: { cells: string[] }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '7px 14px',
      borderBottom: '1px solid var(--border)', background: 'var(--overlay-subtle)',
    }}>
      <span style={{ ...cellName, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{cells[0]}</span>
      {cells.slice(1).map((c, i) => (
        <span key={i} style={{
          ...cellNum, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--fg-muted)', width: i === 0 ? 150 : cellNum.width,
        }}>{c}</span>
      ))}
    </div>
  )
}

const cellName: React.CSSProperties = {
  flex: '1 1 auto', minWidth: 0, fontSize: 12, color: 'var(--fg)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const cellNum: React.CSSProperties = {
  ...NUM, fontSize: 11.5, color: 'var(--fg)', width: 90, textAlign: 'right', flexShrink: 0,
}
const rowStyle = (i: number, n: number): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 14, padding: '9px 14px',
  borderBottom: i < n - 1 ? '1px solid var(--border)' : 'none',
})

const linkBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer',
  outline: 'none', fontFamily: 'var(--font-body)', fontSize: 11, padding: 0,
}
const primaryBtn: React.CSSProperties = {
  border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)',
  borderRadius: 6, padding: '5px 12px', cursor: 'pointer', outline: 'none',
  fontFamily: 'var(--font-body)', fontSize: 11.5,
}
