import { useEffect, useMemo, useState } from 'react'
import type { UsageStats } from '../../../shared/types'

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All', days: 0 },
]

function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(3)}`
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${n}`
}

function modelLabel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-/g, ' ')
}

export function UsageView() {
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.operator.getUsageStats(days).then((s) => {
      if (!cancelled) { setStats(s); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [days])

  const maxDay = useMemo(() => Math.max(1, ...(stats?.byDay.map((d) => d.cost) ?? [1])), [stats])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 12px', flexShrink: 0, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>Usage &amp; cost</h2>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '4px 0 0', opacity: 0.7, lineHeight: 1.6 }}>
            Estimated from your Claude Code transcripts (<code style={{ background: 'var(--bg-surface)', padding: '0 4px', borderRadius: 3 }}>~/.claude</code>). Did your per-task model choices pay off?
          </p>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 2, flexShrink: 0 }}>
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              style={{
                padding: '3px 10px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
                border: 'none', borderRadius: 4,
                background: days === r.days ? 'var(--btn-bg)' : 'transparent',
                color: days === r.days ? 'var(--fg)' : 'var(--fg-muted)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }} className="scroll-hidden">
        {loading && <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6 }}>Reading transcripts…</p>}

        {!loading && stats && stats.byModel.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.6, textAlign: 'center', padding: '40px 0' }}>
            No usage found in this window.
          </p>
        )}

        {!loading && stats && stats.byModel.length > 0 && (
          <>
            {/* Totals */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
              <Stat label="Total cost" value={fmtCost(stats.totalCost)} big />
              <Stat label="Tokens" value={fmtTokens(stats.totalTokens)} />
              <Stat label="Messages" value={stats.byModel.reduce((s, m) => s + m.messages, 0).toLocaleString()} />
            </div>

            {/* By day sparkline */}
            {stats.byDay.length > 1 && (
              <div style={{ marginBottom: 24 }}>
                <SectionTitle>Daily cost</SectionTitle>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60, marginTop: 8 }}>
                  {stats.byDay.map((d) => (
                    <div
                      key={d.date}
                      title={`${d.date} — ${fmtCost(d.cost)}`}
                      style={{
                        flex: 1, minWidth: 2,
                        height: `${Math.max(2, (d.cost / maxDay) * 100)}%`,
                        background: 'var(--accent)', opacity: 0.7, borderRadius: 1,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* By model */}
            <SectionTitle>By model</SectionTitle>
            <div style={{ marginTop: 8, marginBottom: 24, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <Row header cols={['Model', 'Msgs', 'In', 'Out', 'Cache', 'Cost']} />
              {stats.byModel.map((m) => (
                <Row
                  key={m.model}
                  cols={[
                    modelLabel(m.model),
                    m.messages.toLocaleString(),
                    fmtTokens(m.inputTokens),
                    fmtTokens(m.outputTokens),
                    fmtTokens(m.cacheReadTokens + m.cacheWriteTokens),
                    fmtCost(m.cost),
                  ]}
                  emphasizeFirst
                />
              ))}
            </div>

            {/* By project */}
            <SectionTitle>By project</SectionTitle>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {stats.byProject.slice(0, 12).map((p) => {
                const frac = stats.totalCost > 0 ? p.cost / stats.totalCost : 0
                return (
                  <div key={p.slug} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span title={p.slug} style={{ fontSize: 12, color: 'var(--fg)', width: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {p.name}
                    </span>
                    <div style={{ flex: 1, height: 6, background: 'var(--bg-surface)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${frac * 100}%`, height: '100%', background: 'var(--accent)', opacity: 0.6 }} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--fg-muted)', width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {fmtCost(p.cost)}
                    </span>
                  </div>
                )
              })}
            </div>

            <p style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.4, marginTop: 20 }}>
              Cost is estimated from token counts × public per-model rates (cache write 1.25×/2×, read 0.1× input). Subscription plans may differ.
            </p>
          </>
        )}
      </div>
    </div>
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

function Row({ cols, header, emphasizeFirst }: { cols: string[]; header?: boolean; emphasizeFirst?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '7px 12px',
      borderBottom: header ? '1px solid var(--border)' : 'none',
      background: header ? 'var(--bg-surface)' : 'transparent',
      fontSize: 11, fontVariantNumeric: 'tabular-nums',
    }}>
      {cols.map((c, i) => (
        <span
          key={i}
          style={{
            flex: i === 0 ? 1 : 0,
            width: i === 0 ? undefined : 64,
            textAlign: i === 0 ? 'left' : 'right',
            color: header ? 'var(--fg-muted)' : (i === 0 && emphasizeFirst ? 'var(--fg)' : i === cols.length - 1 ? 'var(--fg)' : 'var(--fg-muted)'),
            fontWeight: header || (i === 0 && emphasizeFirst) || i === cols.length - 1 ? 500 : 400,
            textTransform: i === 0 && !header && emphasizeFirst ? 'capitalize' : undefined,
            flexShrink: 0,
          }}
        >
          {c}
        </span>
      ))}
    </div>
  )
}
