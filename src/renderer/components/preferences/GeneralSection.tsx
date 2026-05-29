import type { SettingsFile, ClaudeSettings } from '../../../shared/types'
import { SettingsFileTabBar } from './SettingsFileTabBar'
import { useSettingsScope } from './useSettingsScope'
import { ListEditor } from './ListEditor'

interface GeneralSectionProps {
  settingsFiles: SettingsFile[]
  onSave: (path: string, settings: ClaudeSettings) => void
  onCreate: (path: string) => void
}

const EFFORT_LEVELS = ['high', 'normal', 'low'] as const

export function GeneralSection({ settingsFiles, onSave, onCreate }: GeneralSectionProps) {
  const { activeScope, setActiveScope, activeFile, handleCreateFile } = useSettingsScope(settingsFiles, onCreate)

  if (!activeFile || !activeFile.exists) {
    return (
      <div>
        <SettingsFileTabBar
          files={settingsFiles}
          activeScope={activeScope}
          onSelect={(f) => setActiveScope(f.scope)}
          onCreate={handleCreateFile}
        />
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 10px' }}>
            No settings file selected or file doesn't exist.
          </p>
          {activeFile && (
            <button
              onClick={() => onCreate(activeFile.path)}
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
          )}
        </div>
      </div>
    )
  }

  const settings = activeFile.settings
  const isReadOnly = activeFile.readOnly

  const handleUpdate = (updates: Partial<ClaudeSettings>) => {
    if (isReadOnly) return
    onSave(activeFile.path, updates)
  }

  return (
    <div>
      <SettingsFileTabBar
        files={settingsFiles}
        activeScope={activeScope}
        onSelect={(f) => setActiveScope(f.scope)}
        onCreate={handleCreateFile}
      />

      {isReadOnly && (
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 16px', opacity: 0.7 }}>
          These settings are managed by your organization and cannot be edited.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Effort Level */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', display: 'block', marginBottom: 8 }}>
            Effort Level
          </label>
          <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px' }}>
            Controls how much reasoning effort Claude puts into responses.
          </p>
          <div style={{ display: 'flex', gap: 0, background: 'var(--bg-surface)', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden' }}>
            {EFFORT_LEVELS.map((level) => (
              <button
                key={level}
                disabled={isReadOnly}
                onClick={() => handleUpdate({ effortLevel: level })}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  textTransform: 'capitalize',
                  background: settings.effortLevel === level ? 'var(--accent)' : 'transparent',
                  color: settings.effortLevel === level ? 'var(--fg-on-accent)' : 'var(--fg-muted)',
                  border: 'none',
                  cursor: isReadOnly ? 'default' : 'pointer',
                  borderRight: level !== 'low' ? '1px solid var(--border)' : 'none',
                  opacity: isReadOnly ? 0.5 : 1,
                }}
              >
                {level}
              </button>
            ))}
          </div>
        </div>

        {/* Sandbox */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', display: 'block' }}>
                Sandbox
              </label>
              <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '2px 0 0' }}>
                Run commands in a sandboxed environment for safety.
              </p>
            </div>
            <ToggleSwitch
              checked={!!settings.sandbox?.enabled}
              disabled={isReadOnly}
              onChange={(checked) => handleUpdate({ sandbox: { ...settings.sandbox, enabled: checked } })}
            />
          </div>
        </div>

        {/* Denied MCP Servers */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', display: 'block', marginBottom: 4 }}>
            Denied MCP Servers
          </label>
          <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 8px' }}>
            MCP servers that are explicitly blocked from connecting.
          </p>
          <ListEditor
            items={settings.deniedMcpServers || []}
            placeholder="server-name"
            disabled={isReadOnly}
            onAdd={(value) => handleUpdate({ deniedMcpServers: [...(settings.deniedMcpServers || []), value] })}
            onRemove={(index) => {
              const updated = [...(settings.deniedMcpServers || [])]
              updated.splice(index, 1)
              handleUpdate({ deniedMcpServers: updated })
            }}
          />
        </div>
      </div>
    </div>
  )
}

function ToggleSwitch({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        background: checked ? 'var(--accent)' : 'var(--overlay-medium)',
        cursor: disabled ? 'default' : 'pointer',
        position: 'relative',
        transition: 'background 0.15s',
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      <div style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: 'var(--fg-on-accent)',
        position: 'absolute',
        top: 3,
        left: checked ? 19 : 3,
        transition: 'left 0.15s',
      }} />
    </button>
  )
}
