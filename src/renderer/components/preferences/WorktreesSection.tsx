import { Fragment, useCallback, useEffect, useState } from 'react'
import type { DevServerProc, ReapClass, ReapEntry, ReapPlan } from '../../../shared/types'
import { sectionHeader, sectionDesc } from '../settings/PageShell'
import { groupWorktrees, isSelectable, pruneSelection, toggleGroup, unsavedLabel } from '../../lib/worktree-groups'

// Every directory under ~/.operator/worktrees, grouped by the repository it came from.
//
// From `dev/results/worktree-lifecycle-audit.md`: 107 directories, 34.0 GB, and defect #4 was
// that there was no way to even AUDIT them from inside the app. The 2026-09-16 gap audit found
// the next gap: 43 of 55 directories (15.4 GB) sat in classes the page could only display.
//
// TWO WAYS ANYTHING IS REMOVED FROM HERE, both a press:
// - "Remove selected": any rows the user ticks, except a row with a lane open in it. Rows with
//   unsaved work (or where git cannot tell) need a second confirmation. Main re-checks all of it.
// - "Remove N safe worktrees": the reaper's automatic tier, unchanged.
// "Would remove automatically" is a report. Nothing on this page, and no trigger, acts on it yet.

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

const TRIGGER_LABEL: Record<string, string> = {
  boot: 'app start',
  'lane-exit': 'a lane exited',
  'task-done': 'a task was marked done',
}

const GB = 1024 ** 3
const MB = 1024 ** 2
function size(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const baseName = (p: string) => p.split('/').pop() ?? p

export function WorktreesSection() {
  const [plan, setPlan] = useState<ReapPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 0 = not confirming · 1 = the list is shown · 2 = the unsaved-work confirmation is shown.
  const [removeStep, setRemoveStep] = useState<0 | 1 | 2>(0)

  const load = useCallback((refreshSizes = false) => {
    setError(null)
    window.operator.worktreeReapPlan({ refreshSizes })
      .then((p) => {
        setPlan(p)
        setSelected((prev) => pruneSelection(prev, p.entries))
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => { load() }, [load])

  const runReap = useCallback(async () => {
    setBusy(true)
    setConfirming(false)
    try {
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

  const chosen = (plan?.entries ?? []).filter((e) => selected.has(e.path) && isSelectable(e))
  const unsaved = chosen.filter((e) => e.needsUnsavedConfirm)
  const chosenBytes = chosen.reduce((n, e) => n + e.sizeBytes, 0)

  const runRemoveSelected = useCallback(async (paths: string[], confirmedUnsaved: string[]) => {
    setBusy(true)
    setRemoveStep(0)
    try {
      const r = await window.operator.worktreeRemoveSelected(paths, confirmedUnsaved)
      setOutcome(
        `Removed ${r.removed.length} director${r.removed.length === 1 ? 'y' : 'ies'}.`
        + (r.failed.length ? ` ${r.failed.length} not removed: ${r.failed.map((f) => `${baseName(f.path)} (${f.error})`).join('; ')}` : ''),
      )
      setSelected(new Set())
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [load])

  const groups = groupWorktrees(plan?.entries ?? [])
  const showSize = !!plan && !plan.sizesOmitted

  return (
    <div>
      <h3 style={sectionHeader}>Worktrees</h3>
      <p style={sectionDesc}>
        Every directory under <code style={{ fontFamily: 'var(--font-mono)' }}>~/.operator/worktrees</code>,
        grouped by the repository it came from. Removing one deletes the directory and keeps its
        branch. Nothing is removed by opening this page.
      </p>

      {error && (
        <div style={{ ...boxStyle, padding: '8px 12px', marginBottom: 12, fontSize: 11, color: 'var(--fg)' }}>
          Couldn't read the worktree plan. {error}{' '}
          <button onClick={() => load()} style={linkBtn}>retry</button>
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
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, fontSize: 11, color: 'var(--fg-muted)', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>
              {plan.entries.length} worktree{plan.entries.length === 1 ? '' : 's'}
            </span>
            {showSize && <span style={{ fontFamily: 'var(--font-mono)' }}>{size(plan.totalBytes)}</span>}
            <span>·</span>
            <span>{groups.length} repositor{groups.length === 1 ? 'y' : 'ies'}</span>
            <button onClick={() => load(true)} disabled={busy} style={{ ...linkBtn, marginLeft: 'auto' }}
                    title="Sizes are cached and re-measured when a directory changes. This re-measures every directory.">
              Refresh sizes
            </button>
          </div>

          <WouldRemove plan={plan} showSize={showSize} />

          {groups.map((g) => {
            const selectable = g.rows.filter(isSelectable)
            const picked = selectable.filter((r) => selected.has(r.path)).length
            return (
              <div key={g.key || '(unknown)'} style={{ marginBottom: 16 }}>
                <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, cursor: selectable.length ? 'pointer' : 'default' }}
                       title={g.key || 'No provenance record and no readable .git pointer names a repository'}>
                  <input
                    type="checkbox"
                    checked={selectable.length > 0 && picked === selectable.length}
                    ref={(el) => { if (el) el.indeterminate = picked > 0 && picked < selectable.length }}
                    disabled={selectable.length === 0 || busy}
                    onChange={() => setSelected((prev) => toggleGroup(prev, g))}
                    aria-label={`Select all in ${g.label}`}
                    style={{ margin: 0, flexShrink: 0 }}
                  />
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
                    textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--fg)',
                  }}>{g.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>
                    {g.rows.length} folder{g.rows.length === 1 ? '' : 's'}
                    {showSize && ` · ${size(g.bytes)}`}
                  </span>
                </label>
                <div style={boxStyle}>
                  {g.rows.map((r, i) => (
                    <Row
                      key={r.path}
                      entry={r}
                      last={i === g.rows.length - 1}
                      showSize={showSize}
                      checked={selected.has(r.path)}
                      disabled={busy}
                      onToggle={() => setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(r.path)) next.delete(r.path)
                        else next.add(r.path)
                        return next
                      })}
                    />
                  ))}
                </div>
              </div>
            )
          })}

          {plan.entries.length === 0 && (
            <div style={{ ...boxStyle, padding: '10px 12px', fontSize: 11, color: 'var(--fg-muted)' }}>
              No worktrees on disk. Nothing to clean up.
            </div>
          )}

          {outcome && (
            <p style={{ ...sectionDesc, margin: '12px 0 0' }}>{outcome}</p>
          )}

          {plan.entries.length > 0 && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {removeStep === 0 && (
                <div>
                  <button onClick={() => setRemoveStep(1)} disabled={busy || chosen.length === 0} style={primaryBtn}>
                    Remove selected{chosen.length ? ` (${chosen.length}${showSize ? `, ${size(chosenBytes)}` : ''})` : ''}
                  </button>
                </div>
              )}

              {removeStep === 1 && (
                <div style={{ ...boxStyle, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, color: 'var(--fg)', marginBottom: 8 }}>
                    {chosen.length} director{chosen.length === 1 ? 'y' : 'ies'} will be deleted. Every branch is kept.
                  </div>
                  <ConfirmList rows={chosen} showSize={showSize} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                    {unsaved.length > 0 ? (
                      <button onClick={() => setRemoveStep(2)} disabled={busy} style={primaryBtn}>Continue</button>
                    ) : (
                      <button onClick={() => runRemoveSelected(chosen.map((e) => e.path), [])} disabled={busy} style={primaryBtn}>
                        {busy ? 'Removing…' : 'Remove them'}
                      </button>
                    )}
                    <button onClick={() => setRemoveStep(0)} style={linkBtn}>Cancel</button>
                  </div>
                </div>
              )}

              {removeStep === 2 && (
                <div style={{ ...boxStyle, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, color: 'var(--fg)', marginBottom: 8 }}>
                    {unsaved.length} of these {unsaved.length === 1 ? 'has' : 'have'} unsaved work, or git
                    cannot tell. Uncommitted files in {unsaved.length === 1 ? 'it' : 'them'} will be lost.
                    Commits stay on their branches.
                  </div>
                  <ConfirmList rows={unsaved} showSize={showSize} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => runRemoveSelected(chosen.map((e) => e.path), unsaved.map((e) => e.path))}
                      disabled={busy} style={primaryBtn}
                    >
                      {busy ? 'Removing…' : `Remove all ${chosen.length}, including unsaved work`}
                    </button>
                    {chosen.length > unsaved.length && (
                      <button
                        onClick={() => runRemoveSelected(chosen.filter((e) => !e.needsUnsavedConfirm).map((e) => e.path), [])}
                        disabled={busy} style={primaryBtn}
                      >
                        Remove only the {chosen.length - unsaved.length} without
                      </button>
                    )}
                    <button onClick={() => setRemoveStep(0)} style={linkBtn}>Cancel</button>
                  </div>
                </div>
              )}

              {plan.auto.length > 0 && removeStep === 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
                    <button onClick={() => setConfirming(true)} disabled={busy} style={primaryBtn}
                            title="Merged worktrees Operator can prove it created, plus creation debris.">
                      Remove {plan.auto.length} safe worktree{plan.auto.length === 1 ? '' : 's'}
                      {showSize && ` (${size(plan.autoBytes)})`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <DevServers />
    </div>
  )
}

/** The report-only list. Stage 1: the rule is computed at app start, when a lane exits on its own
 *  and when a task is marked done, and shown here. Nothing removes these automatically yet. */
function WouldRemove({ plan, showSize }: { plan: ReapPlan; showSize: boolean }) {
  const rows = plan.wouldRemove
  const last = plan.lastCheck
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
          textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--fg)',
        }}>Would remove automatically</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>{rows.length}</span>
      </div>
      <p style={{ ...sectionDesc, margin: '0 0 6px' }}>
        Report only — nothing is removed automatically yet. The rule: clean, no commits that exist
        only here, no lane open, unused for 24 hours; or already dropped by git.
        {last && ` Last checked ${new Date(last.at).toLocaleString()} after ${TRIGGER_LABEL[last.trigger] ?? last.trigger}: ${last.entries.length}.`}
      </p>
      {rows.length > 0 ? (
        <div style={boxStyle}>
          {rows.map((r, i) => (
            <div key={r.path} style={{
              display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 12px',
              borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <span title={r.path} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)', flexShrink: 0 }}>
                {baseName(r.path)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)', flex: '1 1 auto', minWidth: 0 }}>{r.wouldRemove}</span>
              {showSize && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flex: '0 0 60px', textAlign: 'right' }}>
                  {size(r.sizeBytes)}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ ...boxStyle, padding: '8px 12px', fontSize: 11, color: 'var(--fg-muted)' }}>
          Nothing matches the rule right now.
        </div>
      )}
    </div>
  )
}

function ConfirmList({ rows, showSize }: { rows: ReapEntry[]; showSize: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: showSize ? 'minmax(0, 1fr) auto minmax(0, 1.4fr)' : 'minmax(0, 1fr) minmax(0, 1.4fr)', columnGap: 12, rowGap: 3 }}>
      {rows.map((r) => (
        <Fragment key={r.path}>
          <span title={r.path} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {baseName(r.path)}
          </span>
          {showSize && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', textAlign: 'right' }}>{size(r.sizeBytes)}</span>}
          <span style={{ fontSize: 11, color: r.needsUnsavedConfirm ? 'var(--fg)' : 'var(--fg-muted)' }}>{unsavedLabel(r)}</span>
        </Fragment>
      ))}
    </div>
  )
}

// ── Dev servers ──────────────────────────────────────────────────────────────────────────────
//
// THE HALF THE REAPER IS NOT ALLOWED TO DO. Everything on this list is a process the automatic
// path deliberately refuses: a row with no `OPERATOR_APP_PID` could be this run's lane, an
// eleven-day-old lane from another project, or something that merely inherited the variable from
// a shell — a Homebrew `postgres` and an Xcode `Python3` were both carrying lane tags on the dev
// machine when this was written. Killing on that evidence is how a reaper takes down a database,
// so the code refuses forever and defers to a person. This is the person's surface.
//
// Same shape as the worktree reaper above on purpose: list first, say how each row is attributed,
// confirm, then act. Nothing here runs on a timer.

const OWNER_LABEL: Record<DevServerProc['owner'], string> = {
  'dead-app': 'Operator no longer running',
  'abandoned-lane': 'Lane closed',
  'untagged': 'No Operator tag',
  'live-lane': 'Lane open now',
}

/** What selecting this row actually means. The owner alone is a category; this is the
 *  consequence, which is what someone needs before pressing a kill button. */
const OWNER_NOTE: Record<DevServerProc['owner'], string> = {
  'dead-app': 'Left by an Operator that has exited. Safe to stop.',
  'abandoned-lane': 'Its lane is closed but the server outlived it. Safe to stop.',
  'untagged': 'Under one of your projects, but nothing proves Operator started it — it may be a server you started yourself.',
  'live-lane': 'A lane is open and using this. Stopping it will break that lane\u2019s preview.',
}

function age(seconds?: number): string {
  if (seconds == null) return ''
  if (seconds < 90) return `${seconds}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

function DevServers() {
  const [rows, setRows] = useState<DevServerProc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    setConfirming(false)
    window.operator.devServerList()
      .then((r) => {
        setRows(r)
        // Drop selections for pids that are gone, so a confirm can never act on a stale pick.
        setPicked((prev) => new Set([...prev].filter((pid) => r.some((x) => x.pid === pid))))
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(load, [load])

  const toggle = (pid: number) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(pid)) next.delete(pid)
    else next.add(pid)
    return next
  })

  const kill = useCallback(async () => {
    setBusy(true)
    setConfirming(false)
    try {
      const n = await window.operator.devServerKill([...picked])
      setOutcome(`Stopped ${n} process${n === 1 ? '' : 'es'}.`)
      setPicked(new Set())
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [picked, load])

  // Only ever selected rows, never "everything" — this list contains live lanes' servers, and a
  // select-all button next to a kill button is how someone takes their own work down by reflex.
  const chosen = (rows ?? []).filter((r) => picked.has(r.pid))
  const risky = chosen.filter((r) => r.owner === 'live-lane').length

  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={sectionHeader}>Dev servers</h3>
      <p style={sectionDesc}>
        Every dev server Operator can see under your projects and worktrees. These are the
        processes the automatic cleanup refuses to touch, because a tag alone cannot prove who
        started something — so nothing here is stopped unless you pick it and confirm.
      </p>

      {error && (
        <div style={{ ...boxStyle, padding: '8px 12px', marginBottom: 12, fontSize: 11, color: 'var(--fg)' }}>
          Couldn't read the process list. {error}{' '}
          <button onClick={load} style={linkBtn}>retry</button>
        </div>
      )}

      {rows && rows.length === 0 && !error && (
        <div style={{ ...boxStyle, padding: '10px 12px', fontSize: 11, color: 'var(--fg-muted)' }}>
          No dev servers running. Nothing to clean up.
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          <div style={boxStyle}>
            {rows.map((r, i) => (
              <label
                key={r.pid}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 12px', cursor: 'pointer',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
                }}
                title={`${r.command}${r.cwd ? `\n${r.cwd}` : ''}`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(r.pid)}
                  onChange={() => toggle(r.pid)}
                  style={{ margin: 0, flexShrink: 0 }}
                />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0, width: 52 }}>
                  {r.pid}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)',
                  flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {r.cwd ?? r.command}
                </span>
                {/* RESERVATION, not an observed binding — finding the real holder of a port needs
                    per-pid lsof, which fires a TCC prompt. The label says so rather than
                    implying this process was seen holding it. */}
                {r.reservedPort != null && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0 }}
                        title={`Reserved port ${r.reservedPort} — not confirmed as the port this process bound`}>
                    :{r.reservedPort}
                  </span>
                )}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0, width: 34, textAlign: 'right' }}>
                  {age(r.ageSeconds)}
                </span>
                <span style={{ fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0, width: 150, textAlign: 'right' }}>
                  {OWNER_LABEL[r.owner]}
                </span>
              </label>
            ))}
          </div>

          <p style={{ ...sectionDesc, margin: '10px 0 0' }}>
            {[...new Set(rows.map((r) => r.owner))].map((o) => `${OWNER_LABEL[o]} — ${OWNER_NOTE[o]}`).join(' ')}
          </p>

          {outcome && <p style={{ ...sectionDesc, margin: '8px 0 0' }}>{outcome}</p>}

          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {confirming ? (
              <>
                <span style={{ fontSize: 11, color: 'var(--fg)', flex: '1 1 100%' }}>
                  {chosen.length} process{chosen.length === 1 ? '' : 'es'} and everything under
                  {chosen.length === 1 ? ' it' : ' them'} will be stopped.
                  {risky > 0 && ` ${risky} belong${risky === 1 ? 's' : ''} to a lane that is open right now — its preview will stop working.`}
                </span>
                <button onClick={kill} disabled={busy} style={primaryBtn}>
                  {busy ? 'Stopping…' : 'Stop them'}
                </button>
                <button onClick={() => setConfirming(false)} style={linkBtn}>Cancel</button>
              </>
            ) : (
              <>
                <button onClick={() => setConfirming(true)} disabled={busy || chosen.length === 0} style={primaryBtn}>
                  Stop {chosen.length || ''} selected
                </button>
                <button onClick={load} disabled={busy} style={linkBtn}>Refresh</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ entry, last, showSize, checked, disabled, onToggle }: {
  entry: ReapEntry
  last: boolean
  showSize: boolean
  checked: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const selectable = isSelectable(entry)
  return (
    <label
      style={{
        display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 12px',
        borderBottom: last ? 'none' : '1px solid var(--border)',
        cursor: selectable ? 'pointer' : 'default',
      }}
      title={`${entry.path}\n${entry.reason}`}
    >
      <input
        type="checkbox"
        checked={selectable && checked}
        disabled={!selectable || disabled}
        onChange={onToggle}
        aria-label={selectable ? `Select ${baseName(entry.path)}` : `${baseName(entry.path)}: a lane is open here`}
        style={{ margin: 0, flexShrink: 0, alignSelf: 'center' }}
      />
      <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {/* The basename carries the identity (`operator-a30080`); the full path is in the title.
            Truncating at the END, never the middle — the short id is the distinguishing part. */}
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {baseName(entry.path)}
        </span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {CLASS_LABEL[entry.cls]}{entry.backfilled ? ' (provenance backfilled)' : ''} · {unsavedLabel(entry)}
        </span>
      </span>
      {entry.branch && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.branch}
        </span>
      )}
      {showSize && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', flex: '0 0 60px', textAlign: 'right' }}>
          {size(entry.sizeBytes)}
        </span>
      )}
    </label>
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
