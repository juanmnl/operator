import { useEffect, useRef, useState } from 'react'

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

export function AppPreviewPanel({ url, storageKey }: { url: string | null; storageKey?: string }) {
  const overrideKey = storageKey ? `operator.preview.port.${storageKey}` : null
  const [override, setOverride] = useState<number | null>(() => {
    if (!overrideKey) return null
    try { const v = localStorage.getItem(overrideKey); return v ? parseInt(v, 10) || null : null } catch { return null }
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
    const target = override ? `http://localhost:${override}` : url

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

  // Track the frame area so a device preset can be scaled to fit.
  useEffect(() => {
    const el = frameWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [reach])

  const commitOverride = (raw: string) => {
    setEditing(false)
    const p = parseInt(raw.replace(/[^0-9]/g, ''), 10)
    const next = p > 0 && p < 65536 ? p : null
    setOverride(next)
    try {
      if (!overrideKey) return
      if (next) localStorage.setItem(overrideKey, String(next))
      else localStorage.removeItem(overrideKey)
    } catch { /* ignore */ }
  }

  const display = resolved || (override ? `http://localhost:${override}` : url)
  const host = display ? display.replace(/^https?:\/\//, '') : null

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        height: 30, padding: '0 8px 0 12px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)',
      }}>
        {editing ? (
          <input
            autoFocus
            defaultValue={override ? String(override) : ''}
            placeholder="port"
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
            title="Click to set the preview port"
            style={{
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, color: 'var(--fg-muted)',
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', outline: 'none',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220, textAlign: 'left',
            }}
          >
            {host || 'set port…'}
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
                fontFamily: "'Inter', system-ui, sans-serif", fontSize: 9.5, fontWeight: 600,
                padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', outline: 'none',
                background: 'transparent',
                color: preset === p.id ? 'var(--accent)' : 'var(--fg-muted)',
              }}
            >{p.label}</button>
          ))}
        </span>
        <button onClick={() => setNonce((n) => n + 1)} title="Reload preview" style={previewBtn}>⟳</button>
        <button onClick={() => display && window.operator.openExternal?.(display)} title="Open in browser" style={previewBtn}>↗</button>
      </div>

      {reach === 'up' && display ? (
        <div ref={frameWrapRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: '#fff', position: 'relative' }}>
          {/* Escape hatch: some apps refuse to embed (X-Frame-Options / CSP) or are
              native, so the frame can render black. This always-present button pops
              the running app into a real browser window. */}
          <button
            onClick={() => window.operator.openExternal?.(display)}
            title="Open the app in your browser (use this if the preview is blank)"
            style={{
              position: 'absolute', top: 8, right: 8, zIndex: 2,
              display: 'flex', alignItems: 'center', gap: 5,
              fontFamily: "'Inter', system-ui, sans-serif", fontSize: 10.5, fontWeight: 600,
              padding: '4px 9px', borderRadius: 6, cursor: 'pointer', outline: 'none',
              color: 'var(--fg)', background: 'var(--bg-surface)', border: '1px solid var(--border)',
            }}
          >
            Open app ↗
          </button>
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
      gap: 8, padding: 24, textAlign: 'center', fontFamily: "'Inter', system-ui, sans-serif",
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
  marginTop: 0, marginRight: 8, fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, cursor: 'pointer', outline: 'none',
  padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--btn-bg)', color: 'var(--fg)',
}
