import { useMemo, useState } from 'react'
import type { WorktreeDiff, FileChange } from '../../../shared/types'

// Shared diff renderer: summary bar + per-file collapsible sections with tinted +/− rows.
// Used by CanvasDiffPanel (live session diff) and TaskDiffCard (a task's change). The raw
// unified diff is parsed into per-file bodies; noise headers are stripped.

export interface DiffFile {
  path: string
  lines: string[] // hunk + content lines (preamble headers stripped)
  /** What the stripped preamble said happened, when the hunks can't say it themselves:
   *  a rename, a mode change. Without this a chmod-only or rename-only change parses to a
   *  file section with an empty body. */
  note?: string
}

/** Preamble headers worth nothing on screen — the section header already names the file.
 *  `rename`/`old mode`/`new mode` are handled before this and become a `note` instead. */
const PREAMBLE_NOISE = /^(index |--- |\+\+\+ |new file|deleted file|similarity |dissimilarity )/

/** Split a unified diff into per-file bodies. A file starts at `diff --git`; the **b/** path is
 *  the file name, i.e. what the file is called NOW.
 *
 *  Two things here are load-bearing, and both were found by running this and DiffPanel's
 *  now-deleted second parser over real `git diff` output rather than by reading them:
 *
 *  1. HEADERS ARE ONLY STRIPPED BEFORE THE FIRST HUNK. `---`/`+++` are preamble markers, but
 *     they are also what a removed `-- dashes` and an added `++ pluses` look like once git has
 *     prefixed them. Stripping by prefix anywhere in the file silently deleted those content
 *     lines; the old DiffPanel parser kept them but painted them as muted headers. Neither
 *     showed the change. Past the first `@@`, every line is content.
 *  2. THE PATH IS PARSED WITH `.+`, NOT `\S+`. `a/(\S+) b/\S+` cannot match a path containing a
 *     space — on a real diff of `my file.ts` it fell through to a placeholder, which in
 *     DiffPanel meant the file could be selected but its diff never appeared, permanently. */
export function parseDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = []
  let cur: DiffFile | null = null
  let inHunk = false
  let notes: string[] = []
  let renameFrom = ''
  let oldMode = ''

  const note = (s: string) => { notes.push(s); if (cur) cur.note = notes.join(' · ') }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/)
      cur = { path: m ? m[1] : line.replace('diff --git ', ''), lines: [] }
      out.push(cur)
      inHunk = false
      notes = []
      renameFrom = ''
      oldMode = ''
      continue
    }
    if (!cur) continue
    if (line.startsWith('@@')) inHunk = true
    if (!inHunk) {
      // Rescued from the preamble rather than dropped: these say the only thing that happened
      // when there are no hunks at all, and they add what the hunks can't when there are.
      if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
        renameFrom = line.slice(line.indexOf('from ') + 5); continue
      }
      if (line.startsWith('rename to ')) { note(`Renamed from ${renameFrom || '?'}`); continue }
      if (line.startsWith('copy to ')) { note(`Copied from ${renameFrom || '?'}`); continue }
      if (line.startsWith('old mode ')) { oldMode = line.slice(9).trim(); continue }
      if (line.startsWith('new mode ')) { note(`Mode ${oldMode} → ${line.slice(9).trim()}`); continue }
      if (PREAMBLE_NOISE.test(line)) continue
    }
    cur.lines.push(line)
  }
  return out
}

export function DiffBody({ diff, compact }: { diff: WorktreeDiff; compact?: boolean }) {
  // Track which files are EXPANDED (default: all collapsed, so the panel opens as a
  // browsable list of changed files instead of one endless scroll).
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const files = diff.files
  const totalAdded = files.reduce((n, f) => n + (f.added || 0), 0)
  const totalRemoved = files.reduce((n, f) => n + (f.removed || 0), 0)
  // Per-file counts by path, to annotate each parsed section header.
  const countByPath = useMemo(() => {
    const m = new Map<string, FileChange>()
    for (const f of files) m.set(f.path, f)
    return m
  }, [files])
  const parsed = useMemo(() => parseDiff(diff.diff ?? ''), [diff.diff])

  const toggle = (p: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })
  const expandAll = () => setExpanded(new Set(parsed.map((f) => f.path)))
  const collapseAll = () => setExpanded(new Set())
  const allExpanded = parsed.length > 0 && parsed.every((f) => expanded.has(f.path))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Summary bar */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        height: compact ? 26 : 30, padding: '0 14px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)',
      }}>
        <span style={{ fontWeight: 700, color: 'var(--fg)' }}>{files.length} file{files.length === 1 ? '' : 's'}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--add-fg)' }}>+{totalAdded}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--del-fg)' }}>−{totalRemoved}</span>
        <button
          onClick={allExpanded ? collapseAll : expandAll}
          title={allExpanded ? 'Collapse all files' : 'Expand all files'}
          style={{
            marginLeft: 'auto', fontFamily: 'inherit', fontSize: 10, fontWeight: 600,
            cursor: 'pointer', outline: 'none', padding: '2px 8px', borderRadius: 5,
            border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-muted)',
          }}
        >
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <div className="scroll-hidden" style={{ flex: 1, overflow: 'auto' }}>
        {parsed.length === 0 && (
          <div style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)' }}>
            No changes.
          </div>
        )}
        {parsed.map((file) => {
          const fc = countByPath.get(file.path)
          const status = fc?.status?.trim()
          const isCollapsed = !expanded.has(file.path)
          return (
            <section key={file.path} data-file={file.path}>
              {/* Sticky file header — also the collapse toggle + navigation anchor */}
              <button
                onClick={() => toggle(file.path)}
                title={file.path}
                style={{
                  position: 'sticky', top: 0, zIndex: 1,
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 12px', border: 'none', borderBottom: '1px solid var(--border)',
                  background: 'var(--bg-surface, var(--overlay-subtle))', cursor: 'pointer',
                  fontFamily: 'inherit', textAlign: 'left', outline: 'none',
                }}
              >
                <span style={{
                  flexShrink: 0, width: 10, color: 'var(--fg-muted)', fontSize: 9,
                  transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.12s',
                }}>▾</span>
                <FilePath path={file.path} />
                {/* The porcelain status letter, kept when DiffPanel's separate file list was
                    folded into this one — `??` (untracked) vs `M` is not derivable from the
                    hunks, and dropping it would have been an information regression. */}
                {status && <span data-file-status style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)' }}>{status}</span>}
                {fc && fc.added > 0 && <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--add-fg)' }}>+{fc.added}</span>}
                {fc && fc.removed > 0 && <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--del-fg)' }}>−{fc.removed}</span>}
              </button>
              {!isCollapsed && (
                <div style={{ fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, lineHeight: 1.55 }}>
                  {/* A rename or a chmod has no hunks at all, so without this the section opens
                      onto nothing and reads as a rendering failure rather than as the change. */}
                  {file.note && (
                    <div data-file-note style={{ padding: '4px 12px', color: 'var(--fg-muted)', fontStyle: 'italic' }}>{file.note}</div>
                  )}
                  {file.lines.map((line, i) => <DiffLine key={i} line={line} />)}
                  {!file.note && file.lines.length === 0 && (
                    <div style={{ padding: '4px 12px', color: 'var(--fg-muted)' }}>No textual change.</div>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// Show the directory muted + the file name in full strength, with the directory
// truncating from the LEFT so the file name is never clipped (the old single-span
// ellipsis hid the start of the path).
function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash) : '' // directory WITHOUT the trailing slash
  const name = slash >= 0 ? path.slice(slash + 1) : path
  return (
    <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', fontFamily: "'SF Mono', Menlo, monospace", fontSize: 11.5 }}>
      {dir && (
        // direction:rtl truncates the path from the LEFT (ellipsis at the start). Keep
        // the separating "/" OUT of this span — as a neutral char, rtl bidi reorders it
        // away from the dir, which glued the dir name onto the filename.
        <span style={{ color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
          {dir}
        </span>
      )}
      {slash >= 0 && <span style={{ flexShrink: 0, color: 'var(--fg-muted)', }}>/</span>}
      <span style={{ flexShrink: 0, color: 'var(--fg)', fontWeight: 500 }}>{name}</span>
    </span>
  )
}

// One diff line: tinted row for +/−, accent-tinted @@ hunk separator, muted context.
// Uses the landing's diff palette (--add-fg/--del-fg + their bg tints).
function DiffLine({ line }: { line: string }) {
  const base: React.CSSProperties = { padding: '0 12px', whiteSpace: 'pre', minHeight: '1.55em' }
  if (line.startsWith('@@')) {
    return <div style={{ ...base, color: 'var(--fg-muted)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', padding: '3px 12px' }}>{line}</div>
  }
  if (line.startsWith('+')) {
    return <div style={{ ...base, color: 'var(--add-fg)', background: 'var(--add-bg)' }}>{line}</div>
  }
  if (line.startsWith('-')) {
    return <div style={{ ...base, color: 'var(--del-fg)', background: 'var(--del-bg)' }}>{line}</div>
  }
  return <div style={{ ...base, color: 'color-mix(in srgb, var(--fg) 60%, transparent)' }}>{line || ' '}</div>
}
