import { useEffect, useMemo, useState } from 'react'
import type { UsageStats, UsageInsights } from '../../../shared/types'
import { fmtCost, fmtTokens, modelLabel, fmtDuration } from '../../lib/format'

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All', days: 0 },
]

type Tab = 'usage' | 'cost'

const DAYS_KEY = 'operator.usage.days'

export function UsageView() {
  const [tab, setTab] = useState<Tab>('usage')
  const [days, setDays] = useState(() => {
    const raw = localStorage.getItem(DAYS_KEY)
    const saved = raw === null ? NaN : Number(raw)
    return RANGES.some((r) => r.days === saved) ? saved : 7
  })

  useEffect(() => { localStorage.setItem(DAYS_KEY, String(days)) }, [days])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 0', flexShrink: 0, borderBottom: '1px solid var(--border)', maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>Usage</h2>
          <div style={{ display: 'flex', gap: 2, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 2, flexShrink: 0 }}>
            {RANGES.map((r) => (
              <button key={r.days} onClick={() => setDays(r.days)} style={{
                padding: '3px 10px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', border: 'none', borderRadius: 4,
                background: days === r.days ? 'var(--btn-bg)' : 'transparent', color: days === r.days ? 'var(--fg)' : 'var(--fg-muted)',
              }}>{r.label}</button>
            ))}
          </div>
        </div>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
          {(['usage', 'cost'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: '0 0 10px',
              fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
              color: tab === t ? 'var(--fg)' : 'var(--fg-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}>{t === 'usage' ? "What's driving usage" : 'Cost'}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px 40px', maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box' }} className="scroll-hidden">
        {tab === 'usage' ? <InsightsTab days={days} /> : <CostTab days={days} />}
      </div>
    </div>
  )
}

// --- Usage / insights tab ---------------------------------------------------

function InsightsTab({ days }: { days: number }) {
  const [data, setData] = useState<UsageInsights | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.operator.getUsageInsights(days).then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [days])

  if (loading) return <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6 }}>Reading transcripts…</p>
  if (!data || data.totalTokens === 0) return <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6, textAlign: 'center', padding: '40px 0' }}>No usage in this window.</p>

  return (
    <>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.6, margin: '0 0 18px', lineHeight: 1.6 }}>
        Approximate, based on local sessions on this machine — what's driving your <strong style={{ color: 'var(--fg)', fontWeight: 600 }}>token</strong> usage (<span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(data.totalTokens)}</span> total), not cost.
        (Session/weekly rate-limit bars live in Claude Code's <code style={{ background: 'var(--bg-surface)', padding: '0 4px', borderRadius: 3 }}>/usage</code> — they come from Anthropic's servers, not local data.)
      </p>

      <Insight
        pct={data.highContextPct}
        title="usage was at >150k context"
        detail="Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks."
      />
      <Insight
        pct={data.subagentPct}
        title="usage came from subagent-heavy sessions"
        detail="Each subagent runs its own requests. Be deliberate about spawning them — and consider a cheaper model for simple subagents."
      />
      <Insight
        pct={data.longSessionPct}
        title="usage came from sessions active 8h+"
        detail="Often background/loop sessions. Continuous usage adds up quickly, so make sure it's intentional."
      />

      {data.skills.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--fg-muted)', opacity: 0.6, margin: '0 0 8px' }}>Skills · % of usage</p>
          {data.skills.map((s) => (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
              <span style={{ fontSize: 12, color: 'var(--fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{s.pct.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function Insight({ pct, title, detail }: { pct: number; title: string; detail: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
        <span style={{ color: 'var(--accent)' }}>{pct.toFixed(0)}%</span> of {title}
      </div>
      <div style={{ height: 6, background: 'var(--bg-surface)', borderRadius: 3, overflow: 'hidden', margin: '6px 0' }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: 'var(--accent)', opacity: 0.6 }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.7, lineHeight: 1.5 }}>{detail}</div>
    </div>
  )
}

// --- Cost tab (the dashboard) -----------------------------------------------

function CostTab({ days }: { days: number }) {
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.operator.getUsageStats(days).then((s) => { if (!cancelled) { setStats(s); setLoading(false) } })
    return () => { cancelled = true }
  }, [days])

  const maxDay = useMemo(() => Math.max(1, ...(stats?.byDay.map((d) => d.cost) ?? [1])), [stats])

  if (loading) return <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6 }}>Reading transcripts…</p>
  if (!stats || stats.byModel.length === 0) return <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6, textAlign: 'center', padding: '40px 0' }}>No usage in this window.</p>

  return (
    <>
      <div style={{ display: 'flex', gap: 24, marginBottom: 20, flexWrap: 'wrap' }}>
        <Stat label="Total cost" value={fmtCost(stats.totalCost)} big />
        <Stat label="Tokens" value={fmtTokens(stats.totalTokens)} />
        <Stat label="Messages" value={stats.byModel.reduce((s, m) => s + m.messages, 0).toLocaleString()} />
        <Stat label="API time" value={fmtDuration(stats.apiMs)} />
        <Stat label="Wall time" value={fmtDuration(stats.wallMs)} />
      </div>

      {stats.byDay.length > 1 && (
        <div style={{ marginBottom: 24 }}>
          <SectionTitle>Daily cost</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60, marginTop: 8 }}>
            {stats.byDay.map((d) => (
              <div key={d.date} title={`${d.date} — ${fmtCost(d.cost)}`} style={{ flex: 1, minWidth: 2, height: `${Math.max(2, (d.cost / maxDay) * 100)}%`, background: 'var(--accent)', opacity: 0.7, borderRadius: 1 }} />
            ))}
          </div>
        </div>
      )}

      <SectionTitle>By model</SectionTitle>
      <div style={{ marginTop: 8, marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stats.byModel.map((m) => (
          <div key={m.model} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', textTransform: 'capitalize' }}>{modelLabel(m.model)}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{fmtCost(m.cost)}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
              <TokenStat label="Input" value={m.inputTokens} />
              <TokenStat label="Output" value={m.outputTokens} />
              <TokenStat label="Cache write" value={m.cacheWriteTokens} />
              <TokenStat label="Cache read" value={m.cacheReadTokens} />
              <TokenStat label="Messages" value={m.messages} raw />
            </div>
          </div>
        ))}
      </div>

      <SectionTitle>By project</SectionTitle>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {stats.byProject.slice(0, 12).map((p) => {
          const frac = stats.totalCost > 0 ? p.cost / stats.totalCost : 0
          return (
            <div key={p.slug} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span title={p.slug} style={{ fontSize: 12, color: 'var(--fg)', width: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{p.name}</span>
              <div style={{ flex: 1, height: 6, background: 'var(--bg-surface)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${frac * 100}%`, height: '100%', background: 'var(--accent)', opacity: 0.6 }} />
              </div>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtCost(p.cost)}</span>
            </div>
          )
        })}
      </div>

      <p style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.4, marginTop: 20 }}>
        Estimated from token counts × public per-model rates (cache write 1.25×/2×, read 0.1× input). Subscription plans may differ.
      </p>
    </>
  )
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: big ? 28 : 20, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4, opacity: 0.6 }}>{label}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--fg-muted)', opacity: 0.6, margin: 0 }}>{children}</p>
}

function TokenStat({ label, value, raw }: { label: string; value: number; raw?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{raw ? value.toLocaleString() : fmtTokens(value)}</div>
      <div style={{ fontSize: 9, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 2, opacity: 0.6 }}>{label}</div>
    </div>
  )
}
