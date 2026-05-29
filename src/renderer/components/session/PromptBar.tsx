import { useState, useRef, useEffect } from 'react'

interface PromptBarProps {
  terminalId: string
}

/**
 * Quick-send input for the active session. Writes text + carriage return to
 * the pty, the same byte stream xterm would produce. Lets you fire off
 * instructions without focusing the terminal.
 */
export function PromptBar({ terminalId }: PromptBarProps) {
  const [value, setValue] = useState('')
  const [sentFlash, setSentFlash] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset draft when switching sessions.
  useEffect(() => { setValue('') }, [terminalId])

  useEffect(() => {
    if (!sentFlash) return
    const t = setTimeout(() => setSentFlash(false), 900)
    return () => clearTimeout(t)
  }, [sentFlash])

  const submit = () => {
    const text = value
    if (!text.trim()) return
    // Send the text followed by CR — claude's Ink input treats CR as submit.
    window.operator.terminalWrite(terminalId, text + '\r')
    setValue('')
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
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={sentFlash ? 'Sent ✓' : 'Send to agent (Enter to submit)'}
        style={{
          flex: 1,
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
