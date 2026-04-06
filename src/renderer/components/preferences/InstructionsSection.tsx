import { useState, useRef, useCallback } from 'react'
import type { ClaudeMdFile } from '../../../shared/types'

interface InstructionsSectionProps {
  mdFiles: ClaudeMdFile[]
  onSave: (path: string, content: string) => void
  onCreate: (path: string) => void
}

const SCOPE_ORDER: Record<string, number> = { global: 0, 'project-nested': 1, project: 2 }
const SCOPE_DESC: Record<string, string> = {
  global: 'Applied to all projects. Lowest priority.',
  'project-nested': 'Project-level instructions inside .claude/ directory.',
  project: 'Project root instructions. Highest priority.',
}

export function InstructionsSection({ mdFiles, onSave, onCreate }: InstructionsSectionProps) {
  const sorted = [...mdFiles].sort((a, b) => (SCOPE_ORDER[a.scope] ?? 0) - (SCOPE_ORDER[b.scope] ?? 0))

  return (
    <div>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 16px', lineHeight: 1.6 }}>
        CLAUDE.md files provide instructions to Claude Code. Files cascade from global to project-level — lower files take higher priority.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {sorted.map((file) => (
          <MdFileCard key={file.path} file={file} onSave={onSave} onCreate={onCreate} />
        ))}
      </div>
    </div>
  )
}

function MdFileCard({ file, onSave, onCreate }: { file: ClaudeMdFile; onSave: (path: string, content: string) => void; onCreate: (path: string) => void }) {
  const [value, setValue] = useState(file.content)
  const [saved, setSaved] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleBlur = useCallback(() => {
    if (value !== file.content) {
      onSave(file.path, value)
      setSaved(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setSaved(false), 2000)
    }
  }, [value, file.content, file.path, onSave])

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: file.exists ? '1px solid var(--border)' : 'none',
      }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>
            {file.label}
          </div>
          <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 2, opacity: 0.6 }}>
            {SCOPE_DESC[file.scope] || ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {saved && (
            <span style={{ fontSize: 10, color: 'var(--green, #4ade80)' }}>Saved</span>
          )}
          {file.exists && (
            <span style={{
              fontSize: 9,
              padding: '2px 6px',
              background: 'rgba(255,255,255,0.06)',
              borderRadius: 3,
              color: 'var(--fg-muted)',
            }}>
              {file.path.replace(/^\/Users\/[^/]+/, '~')}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      {file.exists ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleBlur}
          spellCheck={false}
          style={{
            width: '100%',
            minHeight: 120,
            maxHeight: 400,
            padding: '12px 14px',
            background: 'var(--bg-terminal)',
            color: 'var(--fg)',
            border: 'none',
            outline: 'none',
            resize: 'vertical',
            fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.6,
            display: 'block',
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <div style={{ padding: '16px 14px', textAlign: 'center' }}>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 10px' }}>
            This file doesn't exist yet.
          </p>
          <button
            onClick={() => onCreate(file.path)}
            style={{
              padding: '5px 14px',
              background: 'var(--btn-bg)',
              border: '1px solid var(--border)',
              borderRadius: 5,
              color: 'var(--fg)',
              fontSize: 11,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Create {file.label.split('(')[0].trim()}
          </button>
        </div>
      )}
    </div>
  )
}
