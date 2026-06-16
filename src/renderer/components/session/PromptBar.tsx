import { useState, useRef, useEffect } from 'react'

interface PromptBarProps {
  terminalId: string
}

type Attachment = {
  id: string
  kind: 'text' | 'image'
  label: string
  /** What gets sent to the agent: the full text, or the temp-file path. */
  payload: string
}

// Base64-encode bytes in chunks (String.fromCharCode blows the call stack on a
// whole multi-MB image at once).
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * Attach bar for the active session. NOT a message input — typing belongs in the
 * terminal, and a plain text field here just duplicates it. This is the one
 * thing the embedded terminal can't do: turn a pasted/dropped image into a path
 * the agent can read, and compact a big paste into a chip. Paste (⌘V) or drop
 * onto the bar → chips; Enter (or "Attach") writes the paths/text into the pty.
 */
export function PromptBar({ terminalId }: PromptBarProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [flash, setFlash] = useState(false)
  const [hover, setHover] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  // Drop attachments when switching sessions.
  useEffect(() => { setAttachments([]) }, [terminalId])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(false), 900)
    return () => clearTimeout(t)
  }, [flash])

  const addAttachment = (a: Omit<Attachment, 'id'>) =>
    setAttachments((prev) => [...prev, { ...a, id: `${Date.now()}-${prev.length}` }])
  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

  // Shared by paste and drop: pull images + text out of a DataTransfer.
  const ingest = async (dt: DataTransfer | null) => {
    if (!dt) return
    const imageItems = Array.from(dt.items).filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    )
    if (imageItems.length) {
      for (const it of imageItems) {
        const file = it.getAsFile()
        if (!file) continue
        const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const path = await window.operator.savePastedImage(bytesToBase64(bytes), ext)
          addAttachment({ kind: 'image', label: file.name || `image.${ext}`, payload: path })
        } catch {
          /* save failed — drop it rather than dumping bytes */
        }
      }
      return
    }
    const text = dt.getData('text')
    if (text) {
      const lines = text.split('\n').length
      addAttachment({ kind: 'text', label: lines > 1 ? `${lines} lines` : `${text.length} chars`, payload: text })
    }
  }

  const onPaste = (e: React.ClipboardEvent) => { e.preventDefault(); void ingest(e.clipboardData) }
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setHover(false); void ingest(e.dataTransfer) }

  const attach = () => {
    if (attachments.length === 0) return
    const msg = attachments.map((a) => a.payload).join('\n')
    // Wrap in a bracketed paste so multiline content lands as one block instead
    // of submitting line-by-line, then CR to submit.
    const payload = msg.includes('\n') ? `\x1b[200~${msg}\x1b[201~\r` : `${msg}\r`
    window.operator.terminalWrite(terminalId, payload)
    setAttachments([])
    setFlash(true)
  }

  const empty = attachments.length === 0

  return (
    <div
      ref={barRef}
      tabIndex={0}
      onPaste={onPaste}
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setHover(true) }}
      onDragLeave={() => setHover(false)}
      onClick={() => barRef.current?.focus()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); attach() }
        if ((e.key === 'Backspace' || e.key === 'Delete') && attachments.length) {
          e.preventDefault(); setAttachments((prev) => prev.slice(0, -1))
        }
      }}
      title="Paste (⌘V) or drop an image or text to attach it to the agent"
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px',
        borderBottom: '1px solid var(--border)',
        background: hover ? 'var(--overlay-subtle)' : 'var(--bg-surface)',
        flexShrink: 0,
        cursor: 'default',
        outline: 'none',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      {/* paperclip */}
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.6 }}>
        <path d="M11.5 5.5 6 11a2 2 0 0 1-2.83-2.83l5.66-5.66a3 3 0 0 1 4.24 4.24l-5.65 5.66a4 4 0 0 1-5.66-5.66l5.3-5.3"
          stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      {empty ? (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.7 }}>
          {flash ? 'Attached ✓' : 'Paste or drop an image or text to attach · ⌘V'}
        </span>
      ) : (
        <>
          {attachments.map((a) => (
            <span
              key={a.id}
              title={a.kind === 'image' ? a.payload : a.payload.slice(0, 4000)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 4px 2px 7px', flexShrink: 0,
                fontSize: 10, lineHeight: '16px',
                color: 'var(--fg-muted)',
                background: 'var(--overlay-subtle)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                maxWidth: 200,
              }}
            >
              <span style={{ opacity: 0.7 }}>{a.kind === 'image' ? '🖼' : '¶'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeAttachment(a.id) }}
                title="Remove"
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--fg-muted)', opacity: 0.6, padding: '0 2px',
                  fontSize: 11, lineHeight: '14px', fontFamily: 'inherit',
                }}
              >
                ×
              </button>
            </span>
          ))}
          <button
            onClick={(e) => { e.stopPropagation(); attach() }}
            style={{
              marginLeft: 'auto', flexShrink: 0,
              padding: '2px 10px', fontSize: 10, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer',
              color: 'var(--fg-on-accent)', background: 'var(--accent)',
              border: 'none', borderRadius: 'var(--radius-sm)',
            }}
          >
            Attach →
          </button>
        </>
      )}
    </div>
  )
}
