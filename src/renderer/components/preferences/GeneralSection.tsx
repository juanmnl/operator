import type { SettingsFile, ClaudeSettings } from '../../../shared/types'
import { SettingsFileTabBar } from './SettingsFileTabBar'
import { useSettingsScope } from './useSettingsScope'
import { ListEditor } from './ListEditor'

interface GeneralSectionProps {
  settingsFiles: SettingsFile[]
  onSave: (path: string, settings: ClaudeSettings) => void
  onCreate: (path: string) => void
}

// NO EFFORT FIELD HERE, deliberately. It used to write `settings.json`'s `effortLevel`, which
// governs only Claude Code sessions started OUTSIDE Operator — a lane launched from the app gets
// its effort from the `--effort` flag and never reads this. So the control edited a value that
// could not affect anything the user was looking at, while sitting beside two settings that do —
// and while a roster pin and the session toolbar's chip both really set a lane's effort. Three
// controls for one word, two of them real. See lib/effort for the flag-vs-file split.

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
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 16px', }}>
          These settings are managed by your organization and cannot be edited.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
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
