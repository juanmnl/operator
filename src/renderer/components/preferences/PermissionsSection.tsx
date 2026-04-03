import { useState, useCallback } from 'react'
import type { SettingsFile, ClaudeSettings } from '../../../shared/types'
import { SettingsFileTabBar } from './SettingsFileTabBar'

interface PermissionsSectionProps {
  settingsFiles: SettingsFile[]
  onSave: (path: string, settings: ClaudeSettings) => void
  onCreate: (path: string) => void
}

export function PermissionsSection({ settingsFiles, onSave, onCreate }: PermissionsSectionProps) {
  const writableFiles = settingsFiles.filter((f) => !f.readOnly)
  const [activeScope, setActiveScope] = useState(() => {
    const existing = writableFiles.find((f) => f.exists)
    return existing?.scope || writableFiles[0]?.scope || 'project-local'
  })

  const activeFile = settingsFiles.find((f) => f.scope === activeScope)

  const handleCreateFile = useCallback((file: SettingsFile) => {
    onCreate(file.path)
    setActiveScope(file.scope)
  }, [onCreate])

  return (
    <div>
      <SettingsFileTabBar
        files={settingsFiles}
        activeScope={activeScope}
        onSelect={(f) => setActiveScope(f.scope)}
        onCreate={handleCreateFile}
      />

      {activeFile ? (
        activeFile.readOnly ? (
          <ReadOnlyNotice label={activeFile.label} />
        ) : activeFile.exists ? (
          <PermissionRulesEditor file={activeFile} onSave={onSave} />
        ) : (
          <FileNotFound file={activeFile} onCreate={onCreate} />
        )
      ) : (
        <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>No settings file selected.</p>
      )}
    </div>
  )
}

function PermissionRulesEditor({ file, onSave }: { file: SettingsFile; onSave: (path: string, settings: ClaudeSettings) => void }) {
  const permissions = file.settings.permissions || {}

  const handleAdd = (key: 'allow' | 'deny' | 'ask', value: string) => {
    const current = permissions[key] || []
    if (!value.trim() || current.includes(value.trim())) return
    const updated = { ...permissions, [key]: [...current, value.trim()] }
    onSave(file.path, { permissions: updated })
  }

  const handleRemove = (key: 'allow' | 'deny' | 'ask', index: number) => {
    const current = [...(permissions[key] || [])]
    current.splice(index, 1)
    const updated = { ...permissions, [key]: current }
    onSave(file.path, { permissions: updated })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <RuleList
        title="Allow"
        description="Tools and patterns automatically approved"
        color="#4ade80"
        rules={permissions.allow || []}
        onAdd={(v) => handleAdd('allow', v)}
        onRemove={(i) => handleRemove('allow', i)}
      />
      <RuleList
        title="Deny"
        description="Tools and patterns automatically blocked"
        color="#ef5252"
        rules={permissions.deny || []}
        onAdd={(v) => handleAdd('deny', v)}
        onRemove={(i) => handleRemove('deny', i)}
      />
      <RuleList
        title="Ask"
        description="Tools and patterns that require approval each time"
        color="#f59e0b"
        rules={permissions.ask || []}
        onAdd={(v) => handleAdd('ask', v)}
        onRemove={(i) => handleRemove('ask', i)}
      />
    </div>
  )
}

function RuleList({ title, description, color, rules, onAdd, onRemove }: {
  title: string
  description: string
  color: string
  rules: string[]
  onAdd: (value: string) => void
  onRemove: (index: number) => void
}) {
  const [input, setInput] = useState('')

  const handleSubmit = () => {
    if (input.trim()) {
      onAdd(input)
      setInput('')
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>{title}</span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{description}</span>
      </div>

      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        overflow: 'hidden',
      }}>
        {rules.length === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--fg-muted)', opacity: 0.5 }}>
            No rules configured
          </div>
        )}
        {rules.map((rule, i) => (
          <div
            key={`${rule}-${i}`}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              color: 'var(--fg)',
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: i < rules.length - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <span>{rule}</span>
            <button
              onClick={() => onRemove(i)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                fontSize: 14,
                padding: '0 4px',
                opacity: 0.5,
                lineHeight: 1,
              }}
            >
              x
            </button>
          </div>
        ))}

        {/* Add rule input */}
        <div style={{
          display: 'flex',
          borderTop: rules.length > 0 ? '1px solid var(--border)' : 'none',
        }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder='e.g. Bash(npm run *)'
            style={{
              flex: 1,
              padding: '6px 12px',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--fg)',
              fontSize: 11,
              fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
            }}
          />
          <button
            onClick={handleSubmit}
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
      </div>
    </div>
  )
}

function ReadOnlyNotice({ label }: { label: string }) {
  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        {label} settings are read-only and managed by your organization.
      </p>
    </div>
  )
}

function FileNotFound({ file, onCreate }: { file: SettingsFile; onCreate: (path: string) => void }) {
  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 10px' }}>
        {file.label} file doesn't exist yet.
      </p>
      <button
        onClick={() => onCreate(file.path)}
        style={{
          padding: '5px 14px',
          background: '#1C1C24',
          border: '1px solid rgba(0,0,0,0.4)',
          borderRadius: 5,
          color: 'var(--fg)',
          fontSize: 11,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        Create File
      </button>
    </div>
  )
}
