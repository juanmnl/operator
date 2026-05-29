import type { SettingsFile, ClaudeSettings } from '../../../shared/types'

interface PluginsSectionProps {
  settingsFiles: SettingsFile[]
  onSave: (path: string, settings: ClaudeSettings) => void
}

export function PluginsSection({ settingsFiles, onSave }: PluginsSectionProps) {
  // Collect all plugins across settings files
  const allPlugins = new Map<string, { enabled: boolean; source: SettingsFile }>()

  for (const file of settingsFiles) {
    if (!file.exists || !file.settings.enabledPlugins) continue
    for (const [name, enabled] of Object.entries(file.settings.enabledPlugins)) {
      // Later files override earlier ones (project-local wins)
      allPlugins.set(name, { enabled, source: file })
    }
  }

  // Find the best writable file for saving plugin changes
  const writeTarget = settingsFiles.find((f) => f.exists && !f.readOnly && f.scope === 'project-local')
    || settingsFiles.find((f) => f.exists && !f.readOnly)

  const handleToggle = (pluginName: string, enabled: boolean) => {
    if (!writeTarget) return
    const current = writeTarget.settings.enabledPlugins || {}
    onSave(writeTarget.path, {
      enabledPlugins: { ...current, [pluginName]: enabled },
    })
  }

  if (allPlugins.size === 0) {
    return (
      <div>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.5 }}>
          No plugins configured in any settings file.
        </p>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '8px 0 0', opacity: 0.4 }}>
          Plugins are managed through Claude Code CLI. Configure them there and they'll appear here.
        </p>
      </div>
    )
  }

  return (
    <div>
      {writeTarget && (
        <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 12px', opacity: 0.6 }}>
          Changes save to: {writeTarget.label}
        </p>
      )}

      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        overflow: 'hidden',
      }}>
        {Array.from(allPlugins.entries()).map(([name, { enabled, source }], i) => (
          <div
            key={name}
            style={{
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: i < allPlugins.size - 1 ? '1px solid var(--border)' : 'none',
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: 'var(--fg)', fontWeight: 500 }}>
                {name}
              </div>
              <div style={{ fontSize: 9, color: 'var(--fg-muted)', marginTop: 2, opacity: 0.5 }}>
                from {source.label}
              </div>
            </div>
            <button
              onClick={() => handleToggle(name, !enabled)}
              disabled={!writeTarget}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                border: 'none',
                background: enabled ? 'var(--accent)' : 'var(--overlay-medium)',
                cursor: writeTarget ? 'pointer' : 'default',
                position: 'relative',
                transition: 'background 0.15s',
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
                left: enabled ? 19 : 3,
                transition: 'left 0.15s',
              }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
