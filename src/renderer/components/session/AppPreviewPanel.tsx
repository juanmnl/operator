import { useEffect, useMemo, useRef, useState } from 'react'
import { type Annotation, loadAnnotations, saveAnnotations, composeMessage } from '../../lib/annotations'

// Live preview of the session's running app. The reserved/detected port is only a
// HINT — projects often ignore the injected PORT and bind their own default (Vite
// → 5173), or run the server outside the session entirely, so the URL never streams
// for us to sniff. So instead of trusting one port, we PROBE a candidate set (the
// passed-in url first, then the common dev-server defaults) and render whichever is
// actually answering. A manual port box pins a specific one when the guess is wrong.

type Reach = 'checking' | 'up' | 'down'
type Preset = 'fit' | 375 | 768 | 1280
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'fit', label: 'Fit' },
  { id: 375, label: '375' },
  { id: 768, label: '768' },
  { id: 1280, label: '1280' },
]

// Common dev-server ports to fall back on when the reserved/detected port isn't
// serving. Vite (5173/5174), CRA/Next (3000/3001), Astro (4321), Vite preview
// (4173), Python/http (8000/8080), SvelteKit (5173). Ordered by likelihood.
const COMMON_PORTS = [5173, 5174, 3000, 3001, 4321, 4173, 8080, 8000, 5000, 4200]

// Is something answering at this origin? A no-cors fetch resolves (opaque) if a
// server replies, throws on connection-refused (fast on localhost).
// A pinned override is a full URL (has a scheme) or a bare port → localhost.
function overrideUrl(o: string): string {
  return /:\/\//.test(o) ? o : `http://localhost:${o}`
}

async function ping(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', signal })
    return true
  } catch {
    return false
  }
}

export function AppPreviewPanel({ url, storageKey, onDispatch, onSendToTasks, annotate = false, onAnnotateChange }: {
  url: string | null
  storageKey?: string
  /** Send the composed feedback straight to the Console pty (quick path). */
  onDispatch?: (text: string) => void
  /** Add the composed feedback to the project's task backlog (assign to a lane later). */
  onSendToTasks?: (text: string) => void
  /** Annotate vs Interact mode — controlled by DashboardView so a shortcut can toggle it. */
  annotate?: boolean
  onAnnotateChange?: (annotate: boolean) => void
}) {
  const overrideKey = storageKey ? `operator.preview.port.${storageKey}` : null
  // A pinned target: a bare port ("5173") OR a full URL ("https://app.example.com") — so the
  // preview (+ inspect/annotate) works for ANY web app, not just the session's dev server.
  const [override, setOverride] = useState<string | null>(() => {
    if (!overrideKey) return null
    try { return localStorage.getItem(overrideKey) || null } catch { return null }
  })
  const [nonce, setNonce] = useState(0)
  const [resolved, setResolved] = useState<string | null>(null) // the live URL we landed on
  const [reach, setReach] = useState<Reach>('checking')
  const [editing, setEditing] = useState(false)
  const [preset, setPreset] = useState<Preset>('fit')
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<number[]>([])
  const frameWrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  // --- Annotations: pin/box feedback over the preview, dispatched to the agent -----------
  const annKey = storageKey ? `main-${storageKey}` : null
  const annotating = annotate
  const setAnnotate = (b: boolean) => { onAnnotateChange?.(b); setDraft(null) }
  // Inspect mode: a native child webview embedded over the preview frame (Operator owns it, so
  // its injected script CAN read the DOM — hover-outline + click-capture). Off = the iframe.
  const [inspecting, setInspecting] = useState(false)
  const [annotations, setAnnotations] = useState<Annotation[]>(() => (annKey ? loadAnnotations(annKey) : []))
  // A note being authored: pending geometry + text (isNew distinguishes create vs edit).
  const [draft, setDraft] = useState<null | (Pick<Annotation, 'id' | 'xPct' | 'yPct' | 'wPct' | 'hPct' | 'note'> & { isNew: boolean })>(null)
  const dragRef = useRef<null | { x0: number; y0: number }>(null)
  const [rubber, setRubber] = useState<null | { x: number; y: number; w: number; h: number }>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setAnnotations(annKey ? loadAnnotations(annKey) : []) }, [annKey])
  const persistAnn = (next: Annotation[]) => { setAnnotations(next); if (annKey) saveAnnotations(annKey, next) }

  // Explicit discovery: probe the common dev ports and list whatever responds, so the
  // user can pick the right one (instead of us guessing and possibly grabbing another
  // session's server). Picking pins it as the override.
  const scan = async () => {
    setScanning(true); setFound([])
    const ctrl = new AbortController()
    const hits = await Promise.all(COMMON_PORTS.map(async (p) => (await ping(`http://localhost:${p}`, ctrl.signal)) ? p : null))
    setFound(hits.filter((p): p is number => p !== null))
    setScanning(false)
  }

  // Resolve a live port, but ONLY one we can attribute to THIS session: a manual
  // override, or the session's own port (`url` = the port sniffed from this session's
  // output, else its reserved port). We deliberately DON'T blind-probe the common
  // dev ports here — another session's (or a system) server answering on :5173 would
  // be shown as this session's app, which is wrong. Discovery is an explicit action
  // (Scan) in the empty state instead.
  useEffect(() => {
    setReach('checking')
    const ctrl = new AbortController()
    let timer = 0
    let stopped = false
    const target = override ? overrideUrl(override) : url

    const tick = async () => {
      if (target && await ping(target, ctrl.signal)) {
        if (stopped) return
        setResolved(target); setReach('up')
        timer = window.setTimeout(tick, 3000) // keep watching in case it dies
        return
      }
      if (stopped) return
      setResolved(target)
      setReach('down')
      timer = window.setTimeout(tick, 2000)
    }
    tick()
    return () => { stopped = true; ctrl.abort(); clearTimeout(timer) }
  }, [url, override, nonce])

  // Track the frame area so a device preset can be scaled to fit. Bail the state
  // update when the size is UNCHANGED (return the same object ref) — otherwise every
  // ResizeObserver fire set a fresh {w,h} object, re-rendering unconditionally, and a
  // spurious re-fire (WebKit's "ResizeObserver loop") never converged → 100% CPU spin
  // that froze the app when the preview panel was resized.
  useEffect(() => {
    const el = frameWrapRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [reach])

  const commitOverride = (raw: string) => {
    setEditing(false)
    const v = raw.trim()
    let next: string | null = null
    if (/:\/\//.test(v)) next = v                                       // full URL
    else if (/^\d{2,5}$/.test(v)) next = v                              // bare port
    else if (/^localhost(:\d+)?$/.test(v) || /^[\w-]+(\.[\w-]+)+/.test(v)) next = `http://${v}` // host
    setOverride(next)
    try {
      if (!overrideKey) return
      if (next) localStorage.setItem(overrideKey, next)
      else localStorage.removeItem(overrideKey)
    } catch { /* ignore */ }
  }

  const display = resolved || (override ? overrideUrl(override) : url)
  const host = display ? display.replace(/^https?:\/\//, '') : null
  // Best-effort route (the iframe is cross-origin — this is the URL WE loaded, not any
  // in-app navigation the user did afterwards).
  const route = useMemo(() => { try { return display ? new URL(display).pathname : '/' } catch { return '/' } }, [display])

  // Inspect embeds a native webview OVER the frame (inline). It reads the app's DOM (a cross-origin
  // iframe can't) → hover-outline + a floating compose card next to the clicked element. Close on
  // toggle-off / url change / unmount. Re-runs on `display` so it follows a URL change.
  useEffect(() => {
    if (!inspecting || !display) { window.operator.previewInspectClose?.(); return }
    const el = frameWrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void window.operator.previewInspectOpen?.(display, r.left, r.top, r.width, r.height)
    return () => { window.operator.previewInspectClose?.() }
  }, [inspecting, display])
  // Keep the embedded inspector aligned to the frame as the panel resizes.
  useEffect(() => {
    if (!inspecting) return
    const id = requestAnimationFrame(() => {
      const el = frameWrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      window.operator.previewInspectMove?.(r.left, r.top, r.width, r.height)
    })
    return () => cancelAnimationFrame(id)
  }, [box, inspecting])
  // The inspector's floating card composes the note itself and beacons preview:pick with the final
  // payload (message + element + chosen target). We format it and route to the Console or Tasks.
  useEffect(() => {
    const unsub = window.operator.onPreviewPick?.((data) => {
      try {
        const p = JSON.parse(data) as { selector?: string; tag?: string; text?: string; component?: string | null; source?: string | null; message?: string; target?: 'console' | 'tasks' }
        const who = p.component || p.tag || 'element'
        const loc = p.source ? `${who} @ ${p.source}` : `${who}${p.selector ? ` (${p.selector})` : ''}`
        const msg = `${(p.message || '').trim()}\n\n↳ ${loc}${p.text ? ` — “${p.text}”` : ''}`.trim()
        if (p.target === 'console') onDispatch?.(msg); else onSendToTasks?.(msg)
      } catch { /* ignore */ }
    })
    return () => unsub?.()
  }, [onDispatch, onSendToTasks])

  const onOverlayDown = (e: React.MouseEvent) => {
    const r = overlayRef.current?.getBoundingClientRect(); if (!r) return
    dragRef.current = { x0: e.clientX - r.left, y0: e.clientY - r.top }
  }
  const onOverlayMove = (e: React.MouseEvent) => {
    const s = dragRef.current, r = overlayRef.current?.getBoundingClientRect(); if (!s || !r) return
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    if (Math.hypot(cx - s.x0, cy - s.y0) > 6) setRubber({ x: Math.min(s.x0, cx), y: Math.min(s.y0, cy), w: Math.abs(cx - s.x0), h: Math.abs(cy - s.y0) })
  }
  const onOverlayUp = (e: React.MouseEvent) => {
    const s = dragRef.current, r = overlayRef.current?.getBoundingClientRect()
    dragRef.current = null; setRubber(null)
    if (!s || !r) return
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    const W = r.width || 1, H = r.height || 1
    if (Math.hypot(cx - s.x0, cy - s.y0) > 6) {
      const x = Math.min(s.x0, cx), y = Math.min(s.y0, cy)
      setDraft({ id: crypto.randomUUID(), xPct: (x / W) * 100, yPct: (y / H) * 100, wPct: (Math.abs(cx - s.x0) / W) * 100, hPct: (Math.abs(cy - s.y0) / H) * 100, note: '', isNew: true })
    } else {
      setDraft({ id: crypto.randomUUID(), xPct: (s.x0 / W) * 100, yPct: (s.y0 / H) * 100, note: '', isNew: true })
    }
  }
  // A newly-authored annotation captures the FULL session-side context it was made in —
  // the full URL (not just the pathname), the pixel viewport, and the device preset — so the
  // dispatched feedback carries page + breakpoint, not just a position. Existing annotations
  // keep the context they were captured with (only the note is editable afterward).
  const deviceLabel = preset === 'fit' ? 'Fit' : `${preset}px`
  const buildAnnotation = (d: NonNullable<typeof draft>): Annotation => ({
    id: d.id, xPct: d.xPct, yPct: d.yPct, wPct: d.wPct, hPct: d.hPct, note: d.note,
    route, url: display || undefined, viewport: box.w ? { w: box.w, h: box.h } : undefined,
    device: deviceLabel, createdAt: new Date().toISOString(),
  })
  const saveDraft = () => {
    if (!draft) return
    const exists = annotations.some((a) => a.id === draft.id)
    if (exists) persistAnn(annotations.map((a) => (a.id === draft.id ? { ...a, note: draft.note } : a)))
    else persistAnn([...annotations, buildAnnotation(draft)])
    setDraft(null)
  }
  const deleteDraft = () => { if (draft) persistAnn(annotations.filter((a) => a.id !== draft.id)); setDraft(null) }
  // Send THIS annotation (the one in the open card) to the Console or Tasks — same self-contained
  // pattern as the Inspect card. Persist it first so it stays in the punch-list, then dispatch.
  const dispatchDraft = (target: 'console' | 'tasks') => {
    if (!draft) return
    const existing = annotations.find((a) => a.id === draft.id)
    const ann: Annotation = existing ? { ...existing, note: draft.note } : buildAnnotation(draft)
    persistAnn(existing ? annotations.map((a) => (a.id === draft.id ? ann : a)) : [...annotations, ann])
    const msg = composeMessage([ann], route, { w: box.w, h: box.h })
    if (msg) { if (target === 'tasks') onSendToTasks?.(msg); else onDispatch?.(msg) }
    setDraft(null)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        height: 30, padding: '0 8px 0 12px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)',
      }}>
        {editing ? (
          <input
            autoFocus
            defaultValue={override ?? ''}
            placeholder="port or URL"
            onBlur={(e) => commitOverride(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitOverride(e.currentTarget.value)
              if (e.key === 'Escape') setEditing(false)
            }}
            style={{
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, width: 90,
              background: 'var(--btn-bg)', color: 'var(--fg)', outline: 'none',
              border: '1px solid var(--accent)', borderRadius: 4, padding: '2px 6px',
            }}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Click to set the preview target — a port or any URL"
            style={{
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, color: 'var(--fg-muted)',
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', outline: 'none',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220, textAlign: 'left',
            }}
          >
            {host || 'set URL / port…'}
            {/* Live dot only when something is actually answering. */}
            {reach === 'up' && <span style={{ color: 'var(--color-success, #3fb950)' }}> ●</span>}
            {override && <span style={{ color: 'var(--accent)' }}> ·pinned</span>}
          </button>
        )}
        {/* Device-width presets */}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              title={p.id === 'fit' ? 'Fit to panel' : `${p.id}px wide`}
              style={{
                fontFamily: "var(--font-body)", fontSize: 9.5, fontWeight: 600,
                padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', outline: 'none',
                background: 'transparent',
                color: preset === p.id ? 'var(--accent)' : 'var(--fg-muted)',
              }}
            >{p.label}</button>
          ))}
        </span>
        {(onDispatch || onSendToTasks) && reach === 'up' && (
          <>
            {/* Mode: Interact (clicks pass to your app) vs Annotate (pin/box feedback). */}
            <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, padding: 1 }}>
              {([['interact', 'Interact'], ['annotate', 'Annotate']] as const).map(([m, label]) => {
                const on = (m === 'annotate') === annotating
                return (
                  <button
                    key={m}
                    onClick={() => setAnnotate(m === 'annotate')}
                    title={m === 'annotate' ? 'Pin/box feedback over the app' : 'Interact with the running app'}
                    style={{
                      height: 20, padding: '0 8px', border: 'none', borderRadius: 5, background: 'transparent',
                      cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600,
                      color: on ? 'var(--accent)' : 'var(--fg-muted)',
                    }}
                  >
                    {label}{m === 'annotate' && annotations.length > 0 ? ` ${annotations.length}` : ''}
                  </button>
                )
              })}
            </span>
            {/* Inspect: embeds an Operator-owned webview over the frame with a DOM inspector —
                hover to outline the real element, click to capture it (component@file:line).
                Cross-origin blocks this in the iframe, so it's a native child webview. */}
            {display && (
              <button
                onClick={() => setInspecting((v) => !v)}
                title={inspecting ? 'Stop inspecting' : 'Inspect elements — hover to outline, click to add a note → Console / Tasks'}
                style={{ ...previewBtn, width: 'auto', padding: '0 8px', fontSize: 10.5,
                  color: inspecting ? 'var(--accent)' : 'var(--fg-muted)',
                  borderColor: inspecting ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'var(--border)' }}
              >Inspect ⧉</button>
            )}
          </>
        )}
        <button onClick={() => setNonce((n) => n + 1)} title="Reload preview" style={previewBtn}>⟳</button>
        <button onClick={() => display && window.operator.openExternal?.(display)} title="Open in browser" style={previewBtn}>↗</button>
      </div>

      {reach === 'up' && display ? (
        <div ref={frameWrapRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: '#fff', position: 'relative' }}>
          {/* (If the frame renders blank — X-Frame-Options / CSP — the toolbar's ↗ opens the
              app in a real browser; no need for a second button floating over the content.) */}
          {(() => {
            if (preset === 'fit' || box.w === 0) {
              return <iframe key={nonce} src={display} title="App preview" style={{ width: '100%', height: '100%', border: 'none' }} />
            }
            const scale = Math.min(1, box.w / preset)
            return (
              <iframe
                key={nonce}
                src={display}
                title="App preview"
                style={{
                  width: preset, height: box.h / scale, border: 'none',
                  transform: `scale(${scale})`, transformOrigin: 'top left',
                }}
              />
            )
          })()}

          {/* Annotation markers — numbered pins / boxes over the preview. Only shown while
              annotating: switching to Interact reveals the clean app (no leftover boxes). */}
          {annotating && annotations.map((a, i) => (
            <div
              key={a.id}
              onClick={(e) => { e.stopPropagation(); setDraft({ id: a.id, xPct: a.xPct, yPct: a.yPct, wPct: a.wPct, hPct: a.hPct, note: a.note, isNew: false }) }}
              title={a.note || `Note ${i + 1}`}
              style={{
                position: 'absolute', zIndex: 3, left: `${a.xPct}%`, top: `${a.yPct}%`,
                pointerEvents: 'auto', cursor: 'pointer',
                ...(a.wPct != null ? { width: `${a.wPct}%`, height: `${a.hPct}%`, border: '2px solid var(--accent)', borderRadius: 4, background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : {}),
              }}
            >
              <span style={{
                position: 'absolute', top: -9, left: -9, width: 18, height: 18, borderRadius: '50%',
                background: 'var(--accent)', color: 'var(--fg-on-accent, #06210c)', display: 'grid', placeItems: 'center',
                fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
              }}>{i + 1}</span>
            </div>
          ))}

          {/* Interaction overlay — only while annotating; intercepts clicks to pin/box. */}
          {annotating && (
            <div
              ref={overlayRef}
              onMouseDown={onOverlayDown}
              onMouseMove={onOverlayMove}
              onMouseUp={onOverlayUp}
              style={{ position: 'absolute', inset: 0, zIndex: 2, cursor: 'crosshair', background: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}
            >
              {rubber && (
                <div style={{ position: 'absolute', left: rubber.x, top: rubber.y, width: rubber.w, height: rubber.h, border: '1.5px dashed var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', pointerEvents: 'none' }} />
              )}
            </div>
          )}

          {/* Note popover for the active draft (Enter saves, Esc cancels). */}
          {draft && (
            <div style={{
              position: 'absolute', zIndex: 5,
              left: `min(${draft.xPct}%, calc(100% - 234px))`,
              top: `min(calc(${draft.yPct}% + 14px), calc(100% - 178px))`,
              width: 222, padding: 8, borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
            }}>
              {/* Context this note will carry — device · page · pixel position — so it's visible
                  that annotate sends more than a coordinate. Mirrors composeMessage's header. */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, fontFamily: 'var(--font-mono)',
                fontSize: 9.5, color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden',
              }}>
                <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{deviceLabel}</span>
                <span style={{ opacity: 0.5, flexShrink: 0 }}>·</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{route}</span>
                {box.w > 0 && (
                  <span style={{ marginLeft: 'auto', flexShrink: 0, opacity: 0.7 }}>
                    {draft.wPct != null
                      ? `${Math.round((draft.wPct / 100) * box.w)}×${Math.round((draft.hPct! / 100) * box.h)}px`
                      : `${Math.round((draft.xPct / 100) * box.w)},${Math.round((draft.yPct / 100) * box.h)}px`}
                  </span>
                )}
              </div>
              <textarea
                autoFocus
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveDraft() } if (e.key === 'Escape') setDraft(null) }}
                placeholder="What should change here?"
                rows={3}
                style={{ width: '100%', boxSizing: 'border-box', resize: 'none', fontFamily: 'var(--font-body)', fontSize: 12, background: 'var(--overlay-subtle)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', outline: 'none' }}
              />
              {/* Send THIS note straight to the Console/Tasks — self-contained, same as the Inspect card. */}
              {(onDispatch || onSendToTasks) && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  {onDispatch && <button onClick={() => dispatchDraft('console')} title="Send this note to the Console now" style={{ ...sendBtn, flex: 1, justifyContent: 'center' }}>→ Console</button>}
                  {onSendToTasks && <button onClick={() => dispatchDraft('tasks')} title="Add this note as a task in the queue" style={{ ...sendBtn, flex: 1, justifyContent: 'center' }}>→ Tasks</button>}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button onClick={saveDraft} title="Keep this note in the punch-list without sending" style={{ ...retryBtn, marginRight: 0, fontSize: 10.5, padding: '3px 9px' }}>Save</button>
                {!draft.isNew && <button onClick={deleteDraft} style={{ ...retryBtn, marginRight: 0, fontSize: 10.5, padding: '3px 9px' }}>Delete</button>}
                <button onClick={() => setDraft(null)} style={{ ...retryBtn, marginRight: 0, marginLeft: 'auto', fontSize: 10.5, padding: '3px 9px', color: 'var(--fg-muted)' }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <Centered title={reach === 'checking' ? 'Looking for this session’s app…' : 'No app running for this session'}>
          {reach === 'down' && (
            <>
              {override
                ? `Nothing is answering on port ${override}.`
                : host
                  ? `This session hasn’t started a server on ${host}. If its app runs on a different port, set it or scan for it.`
                  : 'This session hasn’t started a dev server. If you have one running elsewhere, set its port or scan for it.'}
              <span style={{ display: 'block', marginTop: 12 }}>
                <button onClick={() => setNonce((n) => n + 1)} style={retryBtn}>Retry</button>
                <button onClick={() => setEditing(true)} style={retryBtn}>Set port…</button>
                <button onClick={scan} disabled={scanning} style={retryBtn}>{scanning ? 'Scanning…' : 'Scan for a server'}</button>
              </span>
              {found.length > 0 && (
                <span style={{ display: 'block', marginTop: 12 }}>
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', opacity: 0.7, marginBottom: 6 }}>
                    Found {found.length === 1 ? 'a server' : 'servers'} — pick one to preview:
                  </span>
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                    {found.map((p) => (
                      <button key={p} onClick={() => commitOverride(String(p))} style={{ ...retryBtn, marginRight: 0, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                        localhost:{p}
                      </button>
                    ))}
                  </span>
                </span>
              )}
            </>
          )}
        </Centered>
      )}
    </div>
  )
}

function Centered({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 8, padding: 24, textAlign: 'center', fontFamily: "var(--font-body)",
    }}>
      <span style={{ fontSize: 12, color: 'var(--fg)' }}>{title}</span>
      {children && (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.75, maxWidth: 320, lineHeight: 1.5 }}>
          {children}
        </span>
      )}
    </div>
  )
}

const previewBtn: React.CSSProperties = {
  width: 22, height: 22, flexShrink: 0, padding: 0, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 13, cursor: 'pointer', outline: 'none',
  color: 'var(--fg-muted)', background: 'var(--btn-bg)',
  border: '1px solid var(--border)', borderRadius: 5,
}
const retryBtn: React.CSSProperties = {
  marginTop: 0, marginRight: 8, fontFamily: "var(--font-body)", fontSize: 11, cursor: 'pointer', outline: 'none',
  padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--btn-bg)', color: 'var(--fg)',
}
// Send-target buttons inside the annotation card (→ Console / → Tasks).
const sendBtn: React.CSSProperties = {
  flexShrink: 0, height: 24, padding: '0 8px', display: 'flex', alignItems: 'center',
  fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
  outline: 'none', borderRadius: 5, background: 'transparent', color: 'var(--accent)',
  border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border))',
}
