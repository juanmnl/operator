import type { SettingsFile } from '../../../shared/types'

interface SettingsFileTabBarProps {
  files: SettingsFile[]
  activeScope: string
  onSelect: (file: SettingsFile) => void
  onCreate?: (file: SettingsFile) => void
}

export function SettingsFileTabBar({ files, activeScope, onSelect, onCreate }: SettingsFileTabBarProps) {
  const existing = files.filter((f) => f.exists)
  const missing = files.filter((f) => !f.exists && !f.readOnly)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 16 }}>
      {existing.map((file) => (
        <button
          key={file.scope}
          onClick={() => onSelect(file)}
          style={{
            padding: '4px 10px',
            fontSize: 10,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontFamily: 'inherit',
            background: file.scope === activeScope ? 'rgba(255,255,255,0.08)' : 'transparent',
            color: file.scope === activeScope ? 'var(--fg)' : 'var(--fg-muted)',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {file.label}
          {file.readOnly && ' (read-only)'}
        </button>
      ))}
      {onCreate && missing.length > 0 && (
        <div style={{ position: 'relative' }}>
          <CreateFileDropdown files={missing} onCreate={onCreate} />
        </div>
      )}
    </div>
  )
}

function CreateFileDropdown({ files, onCreate }: { files: SettingsFile[]; onCreate: (file: SettingsFile) => void }) {
  return (
    <select
      onChange={(e) => {
        const file = files.find((f) => f.scope === e.target.value)
        if (file) onCreate(file)
        e.target.value = ''
      }}
      value=""
      style={{
        padding: '3px 6px',
        fontSize: 10,
        fontFamily: 'inherit',
        background: 'transparent',
        color: 'var(--fg-muted)',
        border: '1px dashed rgba(255,255,255,0.15)',
        borderRadius: 4,
        cursor: 'pointer',
        opacity: 0.7,
      }}
    >
      <option value="" disabled>+ Create</option>
      {files.map((f) => (
        <option key={f.scope} value={f.scope}>{f.label}</option>
      ))}
    </select>
  )
}
