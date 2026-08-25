import { useCallback, useEffect, useState } from 'react'
import type { ReapClass, ReapEntry, ReapPlan } from '../../../shared/types'
import { sectionHeader, sectionDesc } from '../settings/PageShell'

// The worktree reap plan, read-only except for one button.
//
// From `dev/results/worktree-lifecycle-audit.md`: 107 directories, 34.0 GB, and defect #4 was
// that there was no way to even AUDIT them from inside the app — that report had to be built by
// shelling out to `git` and `du` by hand. This is the surface that closes it.
//
// COMPUTING THE PLAN NEVER REMOVES ANYTHING. The button is the only thing that does, it is the
// only caller anywhere that passes `dryRun: false`, and it acts on the automatic tier only.

/** Order the classes are listed in: what will be removed first, then what needs a decision, with
 *  the never-touched ones last. Reads top-to-bottom as "settled → open → not yours to decide". */
const CLASS_ORDER: ReapClass[] = [
  'merged-clean', 'merged-dirty', 'debris',
  'unmerged', 'unattributed', 'corrupt', 'dead-source-repo',
  'live-claimed',
]

const CLASS_LABEL: Record<ReapClass, string> = {
  'merged-clean': 'Merged and clean',
  'merged-dirty': 'Merged, uncommitted changes',
  'debris': 'Creation debris',
  'unmerged': 'Not merged',
  'unattributed': 'No provenance record',
  'corrupt': 'Not a valid worktree',
  'dead-source-repo': 'Source repo is gone',
  'live-claimed': 'A lane is open here',
}

/** One line per class saying what the app will and won't do with it. The list is otherwise just
 *  paths, and a path does not tell you whether it is about to be deleted. */
const CLASS_NOTE: Record<ReapClass, string> = {
  'merged-clean': 'Removed automatically. The branch is kept — only the directory goes.',
  'merged-dirty': 'Removed automatically, after the changes are committed to the branch first.',
  'debris': 'Removed automatically. Left behind by an interrupted worktree creation.',
  'unmerged': 'Never removed automatically — the branch has work that has not landed.',
  'unattributed': 'Never removed automatically. Operator has no record of creating these, and the rule is that it only removes what it can prove it made.',
  'corrupt': 'Never removed automatically. Something is wrong here that a sweep should not paper over.',
  'dead-source-repo': 'Never removed automatically. No git command can reach these; removing one means deleting the directory outright.',
  'live-claimed': 'Never touched.',
}

const GB = 1024 ** 3
const MB = 1024 ** 2
function size(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function WorktreesSection() {
  const [plan, setPlan] = useState<ReapPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(() => {
    setError(null)
    window.operator.worktreeReapPlan()
      .then(setPlan)
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(load, [load])

  const runReap = useCallback(async () => {
    setBusy(true)
    setConfirming(false)
    try {
      // The ONLY `dryRun: false` in the app, and only ever from this press.
      const result = await window.operator.worktreeReap(false)
      setPlan(result.plan)
      const failed = result.failed.length
      setOutcome(
        `Removed ${result.removed.length} worktree${result.removed.length === 1 ? '' : 's'}, `
        + `${size(result.bytesFreed)} freed${failed ? ` — ${failed} could not be removed.` : '.'}`,
      )
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [load])

  const byClass = CLASS_ORDER
    .map((cls) => ({ cls, rows: (plan?.entries ?? []).filter((e) => e.cls === cls) }))
    .filter((g) => g.rows.length > 0)

  return (
    <div>
      <h3 style={sectionHeader}>Worktrees</h3>
      <p style={sectionDesc}>
        Every directory under <code style={{ fontFamily: 'var(--font-mono)' }}>~/.operator/worktrees</code>,
        classified. Nothing here is removed by opening this page — the button below is the only
        thing that removes anything, and it acts only on the first three groups.
      </p>

      {error && (
        <div style={{ ...boxStyle, padding: '8px 12px', marginBottom: 12, fontSize: 11, color: 'var(--fg)' }}>
          Couldn't read the worktree plan. {error}{' '}
          <button onClick={load} style={linkBtn}>retry</button>
        </div>
      )}

      {!plan && !error && (
        <div style={boxStyle}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ height: 30, borderBottom: i < 2 ? '1px solid var(--border)' : 'none', background: 'var(--overlay-subtle)' }} />
          ))}
        </div>
      )}

      {plan && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, fontSize: 11, color: 'var(--fg-muted)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>
              {plan.entries.length} worktree{plan.entries.length === 1 ? '' : 's'}
            </span>
            {!plan.sizesOmitted && <span style={{ fontFamily: 'var(--font-mono)' }}>{size(plan.totalBytes)}</span>}
            <span>·</span>
            <span>{plan.asks.length} need a decision</span>
          </div>

          {byClass.map(({ cls, rows }) => (
            <div key={cls} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
                  textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--fg)',
                }}>{CLASS_LABEL[cls]}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>
                  {rows.length}
                  {!plan.sizesOmitted && ` · ${size(rows.reduce((n, r) => n + r.sizeBytes, 0))}`}
                </span>
              </div>
              <p style={{ ...sectionDesc, margin: '0 0 6px' }}>{CLASS_NOTE[cls]}</p>
              <div style={boxStyle}>
                {rows.map((r, i) => (
                  <Row key={r.path} entry={r} last={i === rows.length - 1} showSize={!plan.sizesOmitted} />
                ))}
              </div>
            </div>
          ))}

          {plan.entries.length === 0 && (
            <div style={{ ...boxStyle, padding: '10px 12px', fontSize: 11, color: 'var(--fg-muted)' }}>
              No worktrees on disk. Nothing to clean up.
            </div>
          )}

          {outcome && (
            <p style={{ ...sectionDesc, margin: '12px 0 0' }}>{outcome}</p>
          )}

          {plan.auto.length > 0 && (
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {confirming ? (
                <>
                  <span style={{ fontSize: 11, color: 'var(--fg)', flex: '1 1 100%' }}>
                    {plan.auto.length} director{plan.auto.length === 1 ? 'y' : 'ies'} will be deleted.
                    Every branch is kept — a lane can be resumed onto its branch afterwards, and
                    uncommitted work is committed to the branch before its directory goes.
                  </span>
                  <button onClick={runReap} disabled={busy} style={primaryBtn}>
                    {busy ? 'Removing…' : 'Remove them'}
                  </button>
                  <button onClick={() => setConfirming(false)} style={linkBtn}>Cancel</button>
                </>
              ) : (
                <button onClick={() => setConfirming(true)} disabled={busy} style={primaryBtn}>
                  Remove {plan.auto.length} safe worktree{plan.auto.length === 1 ? '' : 's'}
                  {!plan.sizesOmitted && ` (${size(plan.autoBytes)})`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Row({ entry, last, showSize }: { entry: ReapEntry; last: boolean; showSize: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 12px',
      borderBottom: last ? 'none' : '1px solid var(--border)',
    }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)',
          flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        title={entry.path}
      >
        {/* The basename carries the identity (`operator-a30080`); the full path is in the title.
            Truncating at the END, never the middle — the short id is the distinguishing part. */}
        {entry.path.split('/').pop()}
      </span>
      {entry.branch && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flex: '0 0 auto' }}>
          {entry.branch}
        </span>
      )}
      {showSize && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flex: '0 0 60px', textAlign: 'right' }}>
          {size(entry.sizeBytes)}
        </span>
      )}
    </div>
  )
}

const boxStyle: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
}

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', outline: 'none', cursor: 'pointer',
  color: 'var(--accent)', fontSize: 11, fontFamily: 'inherit', padding: 0,
}

/** Transparent, bordered — the house rule is no solid accent fills. */
const primaryBtn: React.CSSProperties = {
  padding: '5px 12px', background: 'transparent', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--fg)', fontSize: 11, fontFamily: 'inherit',
  cursor: 'pointer', outline: 'none',
}
