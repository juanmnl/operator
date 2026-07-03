import { useCallback, useEffect, useRef, useState } from 'react'
import { persistFiles, imageFilesFrom } from '../../lib/paste-image'

// A project-scoped board of inspiration images. Images live in
// ~/.operator/projects/<id>/moodboard/ (bytes copied in, so the board is self-contained).
// Drop screenshots/files onto the panel — or click the + tile — to add; hover a tile to
// remove; click to view full-size. Keyed by projectId, so every session in a repo shares one
// board. When there's no project (a stray non-linked session) it shows a gentle empty note.

interface Shot { name: string; url: string }

export function MoodboardPanel({ projectId }: { projectId?: string }) {
  const [shots, setShots] = useState<Shot[]>([])
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const names = await window.operator.moodboardList(id)
      const loaded = await Promise.all(
        names.map(async (name) => {
          try { return { name, url: await window.operator.moodboardImage(id, name) } } catch { return null }
        }),
      )
      setShots(loaded.filter(Boolean) as Shot[])
    } catch { setShots([]) } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (!projectId) { setShots([]); return }
    void reload(projectId)
  }, [projectId, reload])

  const addFiles = useCallback(async (files: File[]) => {
    if (!projectId) return
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    setBusy(true)
    try {
      await persistFiles(images, (b64, ext) => window.operator.moodboardAdd(projectId, b64, ext))
      await reload(projectId)
    } finally { setBusy(false) }
  }, [projectId, reload])

  const remove = useCallback(async (name: string) => {
    if (!projectId) return
    setShots((prev) => prev.filter((s) => s.name !== name)) // optimistic
    try { await window.operator.moodboardRemove(projectId, name) } catch { void reload(projectId) }
  }, [projectId, reload])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    void addFiles(imageFilesFrom(e.dataTransfer))
  }, [addFiles])

  if (!projectId) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', lineHeight: 1.5 }}>
          The moodboard is shared across a project’s sessions.<br />This session isn’t linked to one yet.
        </p>
      </div>
    )
  }

  const empty = !loading && shots.length === 0

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
      onDrop={onDrop}
      style={{
        height: '100%', overflowY: 'auto', padding: 10, boxSizing: 'border-box',
        outline: dragOver ? '1.5px dashed var(--accent)' : '1.5px dashed transparent',
        outlineOffset: -6, transition: 'outline-color 120ms',
      }}
    >
      <input
        ref={fileRef} type="file" accept="image/*" multiple
        style={{ display: 'none' }}
        onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }}
      />

      {empty ? (
        <button
          onClick={() => fileRef.current?.click()}
          style={{
            width: '100%', minHeight: 160, marginTop: 8, cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
            border: '1.5px dashed var(--border)', borderRadius: 'var(--radius-md)', background: 'transparent',
            color: 'var(--fg-muted)', outline: 'none',
          }}
        >
          <PlusIcon size={22} />
          <span style={{ fontSize: 11, lineHeight: 1.5, textAlign: 'center', maxWidth: 200 }}>
            Drop images here, or click to add.<br />Captures &amp; references, saved with the project.
          </span>
        </button>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>
          {/* Add tile — always first so adding is one click even with a full board. */}
          <button
            onClick={() => fileRef.current?.click()}
            title="Add images"
            style={{
              aspectRatio: '1', display: 'grid', placeItems: 'center', cursor: 'pointer',
              border: '1.5px dashed var(--border)', borderRadius: 'var(--radius-sm)',
              background: 'transparent', color: 'var(--fg-muted)', outline: 'none',
            }}
          >
            <PlusIcon size={18} />
          </button>
          {shots.map((s) => (
            <div
              key={s.name}
              className="moodboard-tile"
              style={{
                position: 'relative', aspectRatio: '1', borderRadius: 'var(--radius-sm)',
                overflow: 'hidden', border: '1px solid var(--border)', cursor: 'zoom-in',
              }}
              onClick={() => setZoom(s.url)}
            >
              <img src={s.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              <button
                className="moodboard-remove"
                title="Remove"
                onClick={(e) => { e.stopPropagation(); void remove(s.name) }}
                style={{
                  position: 'absolute', top: 4, right: 4, width: 18, height: 18, padding: 0,
                  display: 'grid', placeItems: 'center', cursor: 'pointer',
                  border: 'none', borderRadius: 5, background: 'rgba(0,0,0,0.55)', color: '#fff',
                  outline: 'none', lineHeight: 1,
                }}
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      )}

      {busy && (
        <p style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 10, textAlign: 'center' }}>Adding…</p>
      )}

      {/* Lightbox: click anywhere to dismiss. */}
      {zoom && (
        <div
          onClick={() => setZoom(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.8)',
            display: 'grid', placeItems: 'center', padding: 32, cursor: 'zoom-out',
          }}
        >
          <img src={zoom} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--radius-md)', boxShadow: '0 12px 48px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </div>
  )
}

function PlusIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
