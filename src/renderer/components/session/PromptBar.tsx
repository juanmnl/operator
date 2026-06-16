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

// Text shorter than this with no newline is just typed inline — only "a bunch"
// gets compacted into a chip.
const COMPACT_TEXT_CHARS = 240

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
 * Quick-send input for the active session. Writes text + carriage return to the
 * pty, the same byte stream xterm would produce. Pasted images and large text
 * are compacted into chips (like iTerm / Claude Code's own paste handling)
 * instead of dumping a long path or blob into the field; they're expanded back
 * to their full content on submit.
 */
export function PromptBar({ terminalId }: PromptBarProps) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sentFlash, setSentFlash] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const idRef = useRef(0)

  // Reset draft + attachments when switching sessions.
  useEffect(() => { setValue(''); setAttachments([]) }, [terminalId])

  useEffect(() => {
    if (!sentFlash) return
    const t = setTimeout(() => setSentFlash(false), 900)
    return () => clearTimeout(t)
  }, [sentFlash])

  const addAttachment = (a: Omit<Attachment, 'id'>) =>
    setAttachments((prev) => [...prev, { ...a, id: String(idRef.current++) }])
  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

  const onPaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    const cd = e.clipboardData

    // Images → temp file → chip holding the path.
    const imageItems = Array.from(cd.items).filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    )
    if (imageItems.length) {
      e.preventDefault()
      for (const it of imageItems) {
        const file = it.getAsFile()
        if (!file) continue
        const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const path = await window.operator.savePastedImage(bytesToBase64(bytes), ext)
          addAttachment({ kind: 'image', label: file.name || `image.${ext}`, payload: path })
        } catch {
          /* save failed — drop it silently rather than dumping bytes in the field */
        }
      }
      return
    }

    // A bunch of text → chip; small inline snippets paste normally.
    const text = cd.getData('text')
    if (text && (text.includes('\n') || text.length > COMPACT_TEXT_CHARS)) {
      e.preventDefault()
      const lines = text.split('\n').length
      const label = lines > 1 ? `${lines} lines` : `${text.length} chars`
      addAttachment({ kind: 'text', label, payload: text })
    }
  }

  const submit = () => {
    const typed = value.trim()
    if (!typed && attachments.length === 0) return
    // Attachments first (matching the chips' left-to-right order), then the
    // typed line.
    const parts = [...attachments.map((a) => a.payload), typed].filter((s) => s.length > 0)
    const msg = parts.join('\n')
    // Embedded newlines (multiline paste, or a path + a typed line) would submit
    // early line-by-line. Wrap in a bracketed paste so the agent's input treats
    // it as one pasted block, then CR to submit.
    const payload = msg.includes('\n') ? `\x1b[200~${msg}\x1b[201~\r` : `${msg}\r`
    window.operator.terminalWrite(terminalId, payload)
    setValue('')
    setAttachments([])
    setSentFlash(true)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 14px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-surface)',
      flexShrink: 0,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <span style={{
        color: 'var(--accent)', fontSize: 11, fontWeight: 600,
        fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
        opacity: 0.7,
      }}>
        ›
      </span>

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
            maxWidth: 180,
          }}
        >
          <span style={{ opacity: 0.7 }}>{a.kind === 'image' ? '🖼' : '¶'}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.label}
          </span>
          <button
            onClick={() => removeAttachment(a.id)}
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

      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
          // Backspace on an empty field pops the last chip — same as a token input.
          if (e.key === 'Backspace' && value === '' && attachments.length > 0) {
            e.preventDefault()
            setAttachments((prev) => prev.slice(0, -1))
          }
        }}
        placeholder={
          sentFlash ? 'Sent ✓'
            : attachments.length ? 'Add a message (Enter to send)'
            : 'Send to agent (Enter to submit)'
        }
        style={{
          flex: 1,
          minWidth: 80,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: sentFlash ? 'var(--color-success)' : 'var(--fg)',
          fontSize: 12,
          fontFamily: 'inherit',
          padding: '2px 0',
          transition: 'color 0.2s',
        }}
      />
    </div>
  )
}
