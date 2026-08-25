import { useEffect, useMemo, useRef, useState } from 'react'
import { type Annotation, loadAnnotations, saveAnnotations, composeMessage, ANNOTATION_GEOM_VERSION } from '../../lib/annotations'
import { pickPreviewUrl, portOf, parseTarget, formatTarget, EMPTY_TARGET } from '../../lib/preview-port'
import type { SessionPort } from '../../../shared/types'
import { PANEL_SUBHEAD_H } from '../../lib/chrome'

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
async function ping(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', signal })
    return true
  } catch {
    return false
  }
}

export function AppPreviewPanel({ url, terminalId, storageKey, onDispatch, onSendToTasks, annotate = false, onAnnotateChange }: {
  url: string | null
  /** The session's terminal, so we can ask the backend which ports IT is serving on. */
  terminalId?: string | null
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
  // A pinned target, stored as the STRING THE USER TYPED — a port, a port and a path
  // ("5173/admin"), a bare path ("/admin"), or a full URL. Kept as text rather than as a record
  // so the existing per-session storage keys keep working unchanged: every value ever written
  // there parses correctly under `parseTarget`, and there is no migration to get wrong.
  const [override, setOverride] = useState<string | null>(() => {
    if (!overrideKey) return null
    try { return localStorage.getItem(overrideKey) || null } catch { return null }
  })
  // The initializer runs only once, but this panel isn't remounted per session — so on a
  // switch (overrideKey changes) re-read the new session's pin, else session B keeps showing
  // A's pinned URL. Within a session overrideKey is stable, so an in-session commitOverride
  // isn't clobbered.
  useEffect(() => {
    try { setOverride(overrideKey ? localStorage.getItem(overrideKey) || null : null) } catch { setOverride(null) }
  }, [overrideKey])
  const [nonce, setNonce] = useState(0)
  const [resolved, setResolved] = useState<string | null>(null) // the live URL we landed on
  const [reach, setReach] = useState<Reach>('checking')
  const [editing, setEditing] = useState(false)
  const [preset, setPreset] = useState<Preset>('fit')
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<number[]>([])
  // Ports THIS session is serving on — the backend's reserved+sniffed candidate set,
  // filtered to what answers. Unlike `found` (a blind localhost probe, user-initiated),
  // these are attributable — so we can act on them automatically without risking
  // showing a sibling lane's app.
  // …and each carries HOW WELL it is attributed: a `foreign` port is answering but is not this
  // lane's, and must never be previewed as its app. See lib/preview-port.
  const [servers, setServers] = useState<SessionPort[]>([])
  const frameWrapRef = useRef<HTMLDivElement>(null)
  /** THE STAGE — the frame's VISIBLE box, and the one coordinate system everything drawn over
   *  the preview shares. See the derivation below `deviceLabel`. */
  const stageRef = useRef<HTMLDivElement>(null)
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

  // Poll which ports this session is serving on. Cheap (a loopback connect per candidate
  // port — no process inspection, see session_ports) and it has to repeat, because a dev
  // server can come up, die, or be joined by a second one (an API alongside the web
  // server) at any point in a turn.
  useEffect(() => {
    // Reset per-session discovery on switch. Without this, `servers` keeps the PREVIOUS
    // session's ports until B's first poll resolves — and since `autoUrl` falls back to
    // `servers[0]`, it can stay stale-EQUAL across the switch (A's 5173 not in B's reserved
    // set → picks 5173 again), so the resolve effect (keyed on autoUrl) never re-runs and B
    // shows A's app. Clearing here forces autoUrl → B's reserved url immediately.
    setServers([])
    setResolved(null)
    if (!terminalId) return
    let cancelled = false
    const poll = () => {
      window.operator.sessionPorts?.(terminalId)
        .then((ps) => { if (!cancelled) setServers(ps || []) })
        .catch(() => { /* best-effort: no servers is a normal answer, not an error */ })
    }
    poll()
    const t = window.setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [terminalId])

  /** The pinned target, parsed. A PATH SURVIVES A PORT CHANGE because the two are stored apart:
   *  `/admin` with no port follows whichever server the lane is actually on. */
  const target = useMemo(() => (override ? parseTarget(override) : EMPTY_TARGET), [override])

  // Which server to show, and whether something unattributable is answering. `pick.url` is null
  // when the only thing listening is FOREIGN — a stale orphan or a sibling lane on our reserved
  // port — which is the case that used to show a stranger's app as this session's.
  const pick = useMemo(() => pickPreviewUrl(servers, url, target), [servers, url, target])
  const autoUrl = pick.url

  // Resolve a live port, but ONLY one we can attribute to THIS session: a manual
  // override, or a port from the session's own candidate set (`autoUrl`). We
  // deliberately DON'T blind-probe the common dev ports here — another session's (or
  // a system) server answering on :5173 would be shown as this session's app, which
  // is wrong. Discovery is an explicit action (Scan) in the empty state instead.
  useEffect(() => {
    setReach('checking')
    const ctrl = new AbortController()
    let timer = 0
    let stopped = false
    // `pick` already resolved the pin, the attribution and the path into one URL — there is no
    // second opinion to form here, and forming one is how the panel and the picker drifted apart
    // in the first place (the panel re-derived the override URL with its own rules).
    const target = autoUrl

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
  }, [autoUrl, override, nonce])

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
    // Normalised through the parser so what gets stored is what the box will show back, and so
    // `5173/admin`, `/admin` and `localhost:5173` all land in the same shape.
    const parsed = parseTarget(raw)
    const next = raw.trim() ? formatTarget(parsed) || null : null
    setOverride(next)
    try {
      if (!overrideKey) return
      if (next) localStorage.setItem(overrideKey, next)
      else localStorage.removeItem(overrideKey)
    } catch { /* ignore */ }
  }

  /** The servers we can actually attribute — what the picker offers and what "several ports"
   *  counts. */
  const ourServers = useMemo(() => servers.filter((sp) => sp.attributed !== 'foreign'), [servers])
  const display = resolved || pick.url
  const host = display ? display.replace(/^https?:\/\//, '') : null
  // Which of the session's ports is on screen, so the picker can mark it.
  const displayPort = useMemo(() => portOf(display), [display])
  // Best-effort route (the iframe is cross-origin — this is the URL WE loaded, not any
  // in-app navigation the user did afterwards).
  const route = useMemo(() => { try { return display ? new URL(display).pathname : '/' } catch { return '/' } }, [display])

  // Inspect embeds a native webview OVER the frame (inline). It reads the app's DOM (a cross-origin
  // iframe can't) → hover-outline + a floating compose card next to the clicked element. Close on
  // toggle-off / url change / unmount. Re-runs on `display` so it follows a URL change.
  useEffect(() => {
    if (!inspecting || !display) { window.operator.previewInspectClose?.(); return }
    // THE STAGE'S rect, not the wrapper's. The wrapper is the whole panel, so at any preset
    // narrower than it the inspector was laid over the empty gutter as well as the page — every
    // hover outline offset by half the slack.
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void window.operator.previewInspectOpen?.(display, r.left, r.top, r.width, r.height)
    return () => { window.operator.previewInspectClose?.() }
  }, [inspecting, display])
  // Keep the embedded inspector aligned to the frame as the panel resizes — and as the PRESET
  // changes, which is new: the stage now moves and resizes without `box` changing at all, so a
  // preset switch that the wrapper never noticed would have stranded the webview at the old width.
  useEffect(() => {
    if (!inspecting) return
    const id = requestAnimationFrame(() => {
      const el = stageRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      window.operator.previewInspectMove?.(r.left, r.top, r.width, r.height)
    })
    return () => cancelAnimationFrame(id)
  }, [box, preset, inspecting])
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

  // THE STAGE. One element that IS the frame's visible box, centred in the wrapper — and the
  // parent of everything drawn over the preview.
  //
  // The left pin was `transformOrigin: 'top left'` inside a full-width wrapper, but centring is
  // only half of what the stage is for. THREE things derive "where the page is" — the iframe, the
  // annotation pins + capture overlay (percentages), and the native inspect webview (a rect) —
  // and all three read the WRAPPER. "x% across the wrapper" is only "x% across the page" while
  // the frame FILLS the wrapper, which stopped being true at any preset narrower than the panel:
  // pins were stored against a box that included the empty gutter, and the inspector webview was
  // laid over that same too-wide box. That drift predates centring; centring only makes it
  // symmetrical. One stage fixes both, because there is now exactly one box to be a percentage of.
  //
  // WHICH CASE MOVES, and which must not:
  //   preset ≤ box.w → `scale` clamps to 1, the page is `preset` px in a wider box, and the slack
  //                    is the gutter. THIS is the case being centred.
  //   preset > box.w → `scale = box.w / preset`, so the scaled width is box.w EXACTLY: `stageW`
  //                    is the full width, the gutter is 0, and the render is pixel-identical to
  //                    before. `Math.min(preset, box.w)` rather than `preset * scale` states that
  //                    in integers instead of trusting a float to land on box.w.
  const fitting = preset === 'fit' || box.w === 0
  const scale = fitting ? 1 : Math.min(1, box.w / preset)
  /** The stage's box in PANEL pixels — the page AFTER scaling. */
  const stageW = fitting ? box.w : Math.min(preset, box.w)
  /** Split evenly, and NOT rounded: half of an odd remainder is what makes the two gutters equal
   *  rather than off by one. Vertical is untouched — the page stays top-aligned. */
  const gutter = fitting ? 0 : Math.max(0, (box.w - stageW) / 2)
  /** The page's OWN pixel box — what the app inside the iframe believes its viewport to be, which
   *  is not the panel's. At a narrow preset that is `preset` wide; at a wide one the page is still
   *  `preset` wide and `box.h / scale` tall, and it is the SCALE that fits it on screen.
   *
   *  This is the number the percentages have to be multiplied by now. The pins became
   *  page-relative when they moved into the stage, so a pixel hint computed against the wrapper
   *  would name a coordinate that does not exist on the page — `Annotation.viewport` is documented
   *  as "pixel viewport of the preview frame", and `lib/annotations.pxOf` multiplies by it. */
  const pageBox = fitting ? { w: box.w, h: box.h } : { w: preset, h: box.h / scale }

  const buildAnnotation = (d: NonNullable<typeof draft>): Annotation => ({
    id: d.id, xPct: d.xPct, yPct: d.yPct, wPct: d.wPct, hPct: d.hPct, note: d.note,
    route, url: display || undefined, viewport: pageBox.w ? { w: pageBox.w, h: pageBox.h } : undefined,
    // STAMPED, so the migration never touches a note written by this code. It happens to be a
    // no-op on one of these (the recorded viewport IS the page box, so the rebase factor is 1),
    // but relying on that coincidence is how a second rebase eventually lands on a note it
    // shouldn't.
    device: deviceLabel, v: ANNOTATION_GEOM_VERSION, createdAt: new Date().toISOString(),
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
    // The PAGE's box, not the panel's — same reason as `buildAnnotation`'s viewport. This is only
    // the fallback anyway: `composeMessage` prefers the annotation's own captured viewport.
    const msg = composeMessage([ann], route, pageBox)
    if (msg) { if (target === 'tasks') onSendToTasks?.(msg); else onDispatch?.(msg) }
    setDraft(null)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        height: PANEL_SUBHEAD_H, padding: '0 8px 0 12px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)',
      }}>
        {editing ? (
          <input
            autoFocus
            defaultValue={override ?? ''}
            placeholder="port, /path, or URL"
            onBlur={(e) => commitOverride(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitOverride(e.currentTarget.value)
              if (e.key === 'Escape') setEditing(false)
            }}
            style={{
              // Wider than the old port-only box: it now takes `5173/admin/users` too, and a
              // field that visibly cannot hold what it accepts reads as not accepting it.
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, width: 200,
              background: 'var(--btn-bg)', color: 'var(--fg)', outline: 'none',
              border: '1px solid var(--accent)', borderRadius: 4, padding: '2px 6px',
            }}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Click to set the preview target — a port, a path like /admin, or any URL"
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
        {/* Multi-server picker: only when this session is serving on more than one port
            (e.g. a web server + an API). One port needs no choice — the auto-pick above
            already landed on it. Picking PINS it, so an explicit choice survives a
            restart and won't be overridden the next time the port set shifts. */}
        {/* Only the ports we can attribute to this session are offered. A `foreign` one is
            answering, but showing it here would invite the user to pin someone else's app. */}
        {ourServers.length > 1 && (
          <span
            title="This session is serving on several ports — pick which to preview"
            style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, padding: 1, gap: 1 }}
          >
            {ourServers.map((sp) => (
              <button
                key={sp.port}
                // Keeps whatever path is being viewed — pinning a port is not a reason to be
                // thrown back to the site root.
                onClick={() => commitOverride(`${sp.port}${target.path}`)}
                style={{
                  height: 20, padding: '0 7px', border: 'none', borderRadius: 5, background: 'transparent',
                  cursor: 'pointer', outline: 'none',
                  fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 10,
                  color: displayPort === sp.port ? 'var(--accent)' : 'var(--fg-muted)',
                }}
              >
                :{sp.port}
              </button>
            ))}
          </span>
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
        <div ref={frameWrapRef} style={{
          flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative',
          // THE GUTTER'S OWN TONE. `#fff` used to be here and it is now on the stage, where it
          // belongs — it is the PAGE's backdrop (an app with a transparent body should sit on
          // white, not on the app's chrome). A white page in a white panel has no visible edge, so
          // a centred 375 would have looked like nothing happened. `--bg-deep` is the app field in
          // every palette, so the page reads as a device on a surface at all six. A token, never a
          // hex — and a background, so no colour-changing border on a radiused element.
          background: 'var(--bg-deep)',
        }}>
          {/* (If the frame renders blank — X-Frame-Options / CSP — the toolbar's ↗ opens the
              app in a real browser; no need for a second button floating over the content.) */}

          {/* THE STAGE — see the derivation above. Absolutely positioned rather than centred by a
              flex parent, because the annotation layer needs it to be the containing block its
              percentages resolve against.
              OVERFLOW IS VISIBLE, deliberately: a pin's numbered badge is chrome centred ON the
              pin, so at the page's edge it should spill into the gutter rather than be sliced in
              half with empty space right beside it. Nothing else can spill — a scaled iframe's
              PAINT is exactly `stageW` wide however tall its layout box is — and the wrapper still
              clips at the panel edge, so the wide case is untouched either way. */}
          <div
            ref={stageRef}
            data-preview-stage
            style={{
              position: 'absolute', top: 0, left: fitting ? 0 : gutter,
              width: fitting ? '100%' : stageW, height: '100%',
              background: '#fff',
            }}
          >
          {fitting
            ? <iframe key={nonce} src={display} title="App preview" style={{ width: '100%', height: '100%', border: 'none' }} />
            : (
              <iframe
                key={nonce}
                src={display}
                title="App preview"
                style={{
                  width: preset, height: box.h / scale, border: 'none',
                  // `top left` INSIDE the stage: the stage is already the page's visible box, so
                  // the origin has nothing left to pin the page against — it just fills it.
                  transform: `scale(${scale})`, transformOrigin: 'top left',
                }}
              />
            )}

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
              }}><span className="ink-centred" style={{ ['--track' as string]: '0px' }}>{i + 1}</span></span>
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
                {/* Against the PAGE's box, not the panel's. The percentages are page-relative now,
                    so `× box.w` would have quoted a coordinate off the end of a 375px page. */}
                {pageBox.w > 0 && (
                  <span style={{ marginLeft: 'auto', flexShrink: 0, opacity: 0.7 }}>
                    {draft.wPct != null
                      ? `${Math.round((draft.wPct / 100) * pageBox.w)}×${Math.round((draft.hPct! / 100) * pageBox.h)}px`
                      : `${Math.round((draft.xPct / 100) * pageBox.w)},${Math.round((draft.yPct / 100) * pageBox.h)}px`}
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
        </div>
      ) : (
        <Centered title={
          pick.foreign && !pick.url
            ? 'Something else is on this session’s port'
            : reach === 'checking' ? 'Looking for this session’s app…' : 'No app running for this session'
        }>
          {/* THE WARNING. Something answers on the port Operator reserved for this lane, but it
              cannot be attributed to it — a stale dev server from a previous run, or a sibling
              lane that got there first. Showing it would be showing a stranger's app as this
              session's, which is the bug this whole path exists to stop. */}
          {pick.foreign && !pick.url && (
            <>
              {`A server is answering on ${portOf(url) ?? 'this session’s reserved port'}, but it isn’t one this session started — so it isn’t being shown. If it IS the app you want, pin it.`}
              <span style={{ display: 'block', marginTop: 12 }}>
                <button onClick={() => setEditing(true)} style={retryBtn}>Pin it anyway…</button>
                <button onClick={() => setNonce((n) => n + 1)} style={retryBtn}>Retry</button>
              </span>
            </>
          )}
          {reach === 'down' && !(pick.foreign && !pick.url) && (
            <>
              {override
                ? `Nothing is answering at ${override}.`
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
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 6 }}>
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
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', maxWidth: 320, lineHeight: 1.5 }}>
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
