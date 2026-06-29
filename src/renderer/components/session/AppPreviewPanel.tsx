import { useEffect, useRef, useState } from 'react'

// Live preview of the session's running app: iframes the dev server Operator
// detected (or the reserved port as a fallback). Pings the URL first so a
// not-yet-booted / wrong port shows a friendly state instead of a broken frame,
// and offers device-width presets for responsive checking.

type Reach = 'checking' | 'up' | 'down'
type Preset = 'fit' | 375 | 768 | 1280
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'fit', label: 'Fit' },
  { id: 375, label: '375' },
  { id: 768, label: '768' },
  { id: 1280, label: '1280' },
]

// Is the dev server reachable? A no-cors fetch resolves (opaque) if something
// answers, throws on connection-refused. Works for the localhost dev origin.
async function ping(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', signal })
    return true
  } catch {
    return false
  }
}

export function AppPreviewPanel({ url, reserved }: { url: string | null; reserved?: boolean }) {
  const [nonce, setNonce] = useState(0)
  const [reach, setReach] = useState<Reach>('checking')
  const [preset, setPreset] = useState<Preset>('fit')
  const frameWrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  // Poll reachability until up (handles a still-booting dev server), then stop.
  useEffect(() => {
    if (!url) return
    setReach('checking')
    const ctrl = new AbortController()
    let timer = 0
    let stopped = false
    const tick = async () => {
      const ok = await ping(url, ctrl.signal)
      if (stopped) return
      setReach(ok ? 'up' : 'down')
      if (!ok) timer = window.setTimeout(tick, 2000)
    }
    tick()
    return () => { stopped = true; ctrl.abort(); clearTimeout(timer) }
  }, [url, nonce])

  // Track the frame area so a device preset can be scaled to fit.
  useEffect(() => {
    const el = frameWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [reach])

  if (!url) {
    return (
      <Centered title="No dev server detected yet">
        When the session starts one on its reserved port, it’ll render here live.
      </Centered>
    )
  }

  const host = url.replace(/^https?:\/\//, '')

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        height: 30, padding: '0 8px 0 12px', boxSizing: 'border-box', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 11, color: 'var(--fg-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {host}{reserved ? ' ·reserved' : ''}
        </span>
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
        <button onClick={() => window.operator.openExternal?.(url)} title="Open in browser" style={previewBtn}>↗</button>
      </div>

      {reach === 'up' ? (
        <div ref={frameWrapRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: '#fff', position: 'relative' }}>
          {(() => {
            if (preset === 'fit' || box.w === 0) {
              return <iframe key={nonce} src={url} title="App preview" style={{ width: '100%', height: '100%', border: 'none' }} />
            }
            const scale = Math.min(1, box.w / preset)
            return (
              <iframe
                key={nonce}
                src={url}
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
        <Centered title={reach === 'checking' ? `Connecting to ${host}…` : `Nothing serving on ${host} yet`}>
          {reach === 'down' && (
            <>
              {reserved
                ? 'This is the reserved port — the app may not have started a server there yet.'
                : 'The dev server may still be booting.'}{' '}
              Retrying…
              <button onClick={() => setNonce((n) => n + 1)} style={retryBtn}>Retry now</button>
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
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.75, maxWidth: 300, lineHeight: 1.5 }}>
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
  marginTop: 10, fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, cursor: 'pointer', outline: 'none',
  padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--btn-bg)', color: 'var(--fg)',
}
