import { useEffect, useRef, useState } from 'react'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers, Decoration, type DecorationSet } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { FileContent } from '../../../shared/types'
import { codeHighlightStyle, codeTheme } from './cm-theme'

// THE one viewer, shared by both placements. Everything placement-specific is a prop (§9).
//
// CodeMirror 6, read-only. The design's §6 specifies a hand-written tokenizer; the correction to
// this brief replaces it with CM6, which is a better trade for the same reason the research gives:
// CM6's theming API takes plain CSS strings, so one `HighlightStyle` against the app's existing
// variables IS all six palettes, with no per-theme JS object to maintain and no re-mount when the
// theme changes. The five-role mapping from §6 is preserved exactly — see `cm-theme.ts`.
//
// Read-only is `EditorState.readOnly` plus `editable: false`, not a disabled editor: selection
// works, copy works, and the surface says `read-only` once, positively, in its footer.

/** The arrival highlight, as a StateField so it survives reconfiguration and can be cleared by
 *  dispatching an effect rather than by rebuilding the editor. */
const setArrival = StateEffect.define<{ from: number; to: number; faded: boolean } | null>()

const arrivalField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setArrival)) continue
      if (!e.value) return Decoration.none
      const { from, to, faded } = e.value
      const marks = []
      for (let line = from; line <= to; line++) {
        if (line < 1 || line > tr.state.doc.lines) continue
        const info = tr.state.doc.line(line)
        marks.push(
          Decoration.line({ class: faded ? 'op-arrival op-arrival-faded' : 'op-arrival' }).range(info.from),
        )
      }
      return Decoration.set(marks)
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Resolve a `@codemirror/language-data` entry to a live extension.
 *
 *  Dynamically imported per language, which is the point of `language-data`: the grammars a
 *  session never opens are never downloaded into the bundle. An unknown or failed language
 *  renders as plain mono — honest, and never wrong.
 *
 *  `StreamLanguage` and `LanguageSupport` are imported eagerly only so the types resolve; the
 *  grammar modules themselves are not. */
async function languageExtension(name: string | null): Promise<Extension | null> {
  if (!name) return null
  const desc = languages.find((l) => l.name === name)
  if (!desc) return null
  try {
    // `desc.load()` resolves to a `LanguageSupport`, which IS an Extension. The dynamic import is
    // the point of `language-data`: a grammar a session never opens is never fetched.
    return await desc.load()
  } catch {
    // A grammar that fails to load renders as plain mono. Honest, and never wrong.
    return null
  }
}

export interface FileViewerProps {
  /** Worktree or main checkout, absolute. */
  root: string
  /** Repo-relative. */
  path?: string
  /** Deep-link target. `[from, to]` for a hunk range. */
  highlight?: [number, number]
  /** Density — drives the footer and whether line numbers are affordable. Line numbers stay in
   *  every form: they are the addressing scheme, and dropping them is what makes a deep link
   *  unverifiable. */
  form?: 'wide' | 'medium' | 'narrow'
  onAsk?: (path: string, range?: [number, number]) => void
}

/** How long the arrival wash stays before it fades to the gutter mark alone. */
const ARRIVAL_MS = 2000

export function FileViewer({ root, path, highlight, form = 'medium', onAsk }: FileViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(false)

  // --- read the file -------------------------------------------------------------------------
  const reload = useRef<() => void>(() => {})
  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (!root || !path) { setContent(null); setError(null); return }
      setLoading(true)
      window.operator.fileRead(root, path)
        .then((c) => { if (!cancelled) { setContent(c); setError(null); setStale(false) } })
        .catch((e) => { if (!cancelled) { setContent(null); setError(String(e)) } })
        .finally(() => { if (!cancelled) setLoading(false) })
    }
    reload.current = run
    run()
    return () => { cancelled = true }
  }, [root, path])

  // The agent is ACTIVELY EDITING these files, so a change under an open file is the common case,
  // not an edge one. The view does not re-render underneath a reader — it offers.
  useEffect(() => {
    if (!root || !path) return
    const unsub = window.operator.onFileChange?.((changedRoot, paths) => {
      if (changedRoot === root && paths.includes(path)) setStale(true)
    })
    return () => { unsub?.() }
  }, [root, path])

  // --- the editor ----------------------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current
    if (!host || !content || content.binary) return
    let cancelled = false
    let view: EditorView | null = null

    const build = async () => {
      const lang = await languageExtension(content.language)
      if (cancelled || !hostRef.current) return
      const state = EditorState.create({
        doc: content.text,
        extensions: [
          lineNumbers(),
          syntaxHighlighting(codeHighlightStyle),
          codeTheme,
          arrivalField,
          // BOTH, and they are not the same thing: `readOnly` stops transactions changing the
          // document, `editable: false` stops the DOM being contentEditable at all — which is
          // what keeps a caret from appearing and the surface from reading as a disabled editor.
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...(lang ? [lang] : []),
        ],
      })
      view = new EditorView({ state, parent: hostRef.current })
      viewRef.current = view
    }
    void build()
    return () => {
      cancelled = true
      view?.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
  }, [content])

  // --- arrival: scroll to the line, tint it, let the tint fade --------------------------------
  useEffect(() => {
    const view = viewRef.current
    if (!view || !highlight) return
    const [from, to] = highlight
    const lines = view.state.doc.lines
    if (from < 1 || from > lines) return
    const pos = view.state.doc.line(Math.min(from, lines)).from
    view.dispatch({
      // A range scrolls its FIRST line to a third of the way down, not to the top — context above
      // the target is the reason you followed the link.
      effects: [EditorView.scrollIntoView(pos, { y: 'start', yMargin: 120 }), setArrival.of({ from, to, faded: false })],
    })
    const timer = setTimeout(() => {
      viewRef.current?.dispatch({ effects: setArrival.of({ from, to, faded: true }) })
    }, ARRIVAL_MS)
    return () => clearTimeout(timer)
  }, [highlight, content])

  // --- states --------------------------------------------------------------------------------
  if (!path) return <Empty>Choose a file to read.</Empty>
  if (error) {
    // Never a blank pane and never a silent no-op — a dead link that does nothing reads as the
    // feature being broken.
    return (
      <Empty>
        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)', marginBottom: 6 }}>{path}</div>
        <div>{/outside the root/.test(error) ? 'Not in this worktree.' : 'Could not read this file.'}</div>
      </Empty>
    )
  }
  if (!content) return <Empty>{loading ? '' : 'Choose a file to read.'}</Empty>
  if (content.binary) {
    return <Empty>Binary file · {formatBytes(content.bytes)}</Empty>
  }
  if (content.bytes === 0) return <Empty>Empty file · 0 bytes</Empty>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      {stale && (
        <button
          onClick={() => { reload.current() }}
          style={{
            flexShrink: 0, textAlign: 'left', padding: '4px 10px', fontSize: 10,
            fontFamily: 'var(--font-mono)', color: 'var(--accent)', background: 'transparent',
            border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', outline: 'none',
          }}
        >↻ changed on disk — re-read</button>
      )}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }} />
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 10px', height: 24, borderTop: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)',
        textTransform: 'uppercase', letterSpacing: '0.1em',
      }}>
        {/* Stated once, positively — not apologised for, and never a greyed toolbar. */}
        <span>read-only</span>
        <span>·</span>
        <span>{content.language ?? 'plain text'}</span>
        {form !== 'narrow' && (
          <>
            <span>·</span>
            <span>{content.lines} lines</span>
            <span>·</span>
            <span>{formatBytes(content.bytes)}</span>
          </>
        )}
        {content.truncated && (
          <>
            <span>·</span>
            <span style={{ color: 'var(--yellow)' }}>truncated</span>
          </>
        )}
        {onAsk && path && (
          // The answer to "I want to change this" is the app's own answer. Editing isn't missing;
          // it is delegated to the thing that edits, and this single affordance is what stops the
          // surface reading as crippled.
          <button
            onClick={() => onAsk(path, highlight)}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', outline: 'none',
              cursor: 'pointer', color: 'var(--accent)', font: 'inherit', letterSpacing: 'inherit', padding: 0,
            }}
          >
            {highlight ? `Ask the lane about L${highlight[0]} →` : 'Ask the lane →'}
          </button>
        )}
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 4, padding: 16, textAlign: 'center', fontSize: 11, color: 'var(--fg-muted)', minHeight: 0,
    }}>{children}</div>
  )
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
