import type { SettingsFile, ClaudeHookEntry } from '../../../shared/types'

interface HooksSectionProps {
  settingsFiles: SettingsFile[]
}

export function HooksSection({ settingsFiles }: HooksSectionProps) {
  // Collect all hooks across settings files
  const allHooks: { scope: string; event: string; entries: ClaudeHookEntry[] }[] = []

  for (const file of settingsFiles) {
    if (!file.exists || !file.settings.hooks) continue
    const hooks = file.settings.hooks as Record<string, ClaudeHookEntry[]>
    for (const [event, entries] of Object.entries(hooks)) {
      if (Array.isArray(entries) && entries.length > 0) {
        allHooks.push({ scope: file.label, event, entries })
      }
    }
  }

  return (
    <div>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 16px', lineHeight: 1.6, }}>
        Hooks are managed by Operator and your Claude Code configuration. They are shown here for transparency and cannot be edited through this UI.
      </p>

      {allHooks.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', }}>
          No hooks configured.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {allHooks.map(({ scope, event, entries }, gi) => (
          <div
            key={`${scope}-${event}-${gi}`}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            <div style={{
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)' }}>{event}</span>
              <span style={{ fontSize: 9, color: 'var(--fg-muted)', padding: '2px 6px', background: 'rgba(255,255,255,0.04)', borderRadius: 3 }}>
                {scope}
              </span>
            </div>
            {entries.map((entry, i) => (
              <div
                key={i}
                style={{
                  padding: '6px 12px',
                  fontSize: 11,
                  color: 'var(--fg-muted)',
                  fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                  borderBottom: i < entries.length - 1 ? '1px solid var(--border)' : 'none',
                }}
              >
                {entry.matcher && (
                  <span style={{ color: 'var(--fg)', marginRight: 8 }}>
                    [{entry.matcher}]
                  </span>
                )}
                {entry.hooks?.map((h, hi) => (
                  <span key={hi}>
                    {h.command}
                    {h.command?.includes('operator-hook') && (
                      <span style={{ fontSize: 9, color: 'var(--accent)', marginLeft: 6 }}>
                        (Operator)
                      </span>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
