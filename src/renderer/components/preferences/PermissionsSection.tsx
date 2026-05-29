import type { SettingsFile, ClaudeSettings } from '../../../shared/types'
import { SettingsFileTabBar } from './SettingsFileTabBar'
import { useSettingsScope } from './useSettingsScope'
import { ListEditor } from './ListEditor'

interface PermissionsSectionProps {
  settingsFiles: SettingsFile[]
  onSave: (path: string, settings: ClaudeSettings) => void
  onCreate: (path: string) => void
}

const RULE_KINDS = [
  { key: 'allow' as const, title: 'Allow', description: 'Tools and patterns automatically approved', color: 'var(--color-success)' },
  { key: 'deny' as const, title: 'Deny', description: 'Tools and patterns automatically blocked', color: 'var(--color-error)' },
  { key: 'ask' as const, title: 'Ask', description: 'Tools and patterns that require approval each time', color: 'var(--color-warning)' },
]

export function PermissionsSection({ settingsFiles, onSave, onCreate }: PermissionsSectionProps) {
  const { activeScope, setActiveScope, activeFile, handleCreateFile } = useSettingsScope(settingsFiles, onCreate)

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
    const updated = { ...permissions, [key]: [...current, value] }
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
      {RULE_KINDS.map(({ key, title, description, color }) => (
        <RuleListBlock
          key={key}
          title={title}
          description={description}
          color={color}
          rules={permissions[key] || []}
          onAdd={(v) => handleAdd(key, v)}
          onRemove={(i) => handleRemove(key, i)}
        />
      ))}
    </div>
  )
}

function RuleListBlock({ title, description, color, rules, onAdd, onRemove }: {
  title: string
  description: string
  color: string
  rules: string[]
  onAdd: (value: string) => void
  onRemove: (index: number) => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>{title}</span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{description}</span>
      </div>
      <ListEditor
        items={rules}
        placeholder="e.g. Bash(npm run *)"
        emptyLabel="No rules configured"
        onAdd={onAdd}
        onRemove={onRemove}
      />
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
          background: 'var(--btn-bg)',
          border: '1px solid var(--border)',
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
