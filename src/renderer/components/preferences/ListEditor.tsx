import { useState } from 'react'

interface ListEditorProps {
  items: string[]
  placeholder: string
  disabled?: boolean
  monospace?: boolean
  emptyLabel?: string
  onAdd: (value: string) => void
  onRemove: (index: number) => void
}

export function ListEditor({
  items,
  placeholder,
  disabled = false,
  monospace = true,
  emptyLabel = 'None configured',
  onAdd,
  onRemove,
}: ListEditorProps) {
  const [input, setInput] = useState('')
  const fontFamily = monospace ? "'SF Mono', 'Fira Code', Menlo, monospace" : 'inherit'

  const submit = () => {
    const trimmed = input.trim()
    if (!trimmed || items.includes(trimmed)) return
    onAdd(trimmed)
    setInput('')
  }

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
    }}>
      {items.length === 0 && (
        <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--fg-muted)', }}>
          {emptyLabel}
        </div>
      )}
      {items.map((item, i) => (
        <div
          key={`${item}-${i}`}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            color: 'var(--fg)',
            fontFamily,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
          }}
        >
          <span>{item}</span>
          {!disabled && (
            <button
              onClick={() => onRemove(i)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                fontSize: 14,
                padding: '0 4px',
                
                lineHeight: 1,
              }}
            >
              x
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div style={{ display: 'flex', borderTop: items.length > 0 ? '1px solid var(--border)' : 'none' }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={placeholder}
            style={{
              flex: 1,
              padding: '6px 12px',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--fg)',
              fontSize: 11,
              fontFamily,
            }}
          />
          <button
            onClick={submit}
            style={{
              padding: '4px 10px',
              background: 'none',
              border: 'none',
              borderLeft: '1px solid var(--border)',
              color: 'var(--fg-muted)',
              fontSize: 11,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}
