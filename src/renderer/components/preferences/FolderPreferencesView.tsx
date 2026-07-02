import { useEffect, useState, useCallback } from 'react'
import type { FolderPreferences, ClaudeSettings } from '../../../shared/types'
import { InstructionsSection } from './InstructionsSection'
import { PermissionsSection } from './PermissionsSection'
import { GeneralSection } from './GeneralSection'
import { HooksSection } from './HooksSection'
import { PluginsSection } from './PluginsSection'

interface FolderPreferencesViewProps {
  projectPath: string
  projectName: string
  /** When true, loads global-only files (~/.claude/*) and hides project tabs context. */
  globalOnly?: boolean
}

const TABS = ['Instructions', 'Permissions', 'General', 'Hooks', 'Plugins'] as const
type Tab = (typeof TABS)[number]

export function FolderPreferencesView({ projectPath, projectName, globalOnly = false }: FolderPreferencesViewProps) {
  const [prefs, setPrefs] = useState<FolderPreferences | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('Instructions')

  const load = useCallback(async () => {
    const data = globalOnly
      ? await window.operator.folderPrefsLoadGlobal()
      : await window.operator.folderPrefsLoad(projectPath)
    setPrefs(data)
  }, [projectPath, globalOnly])

  useEffect(() => {
    load()
  }, [load])

  const handleSaveSettings = useCallback(async (filePath: string, settings: ClaudeSettings) => {
    await window.operator.folderPrefsSaveSettings(filePath, settings)
    load()
  }, [load])

  const handleSaveMd = useCallback(async (filePath: string, content: string) => {
    await window.operator.folderPrefsSaveMd(filePath, content)
    load()
  }, [load])

  const handleCreateFile = useCallback(async (filePath: string, type: 'settings' | 'md') => {
    await window.operator.folderPrefsCreateFile(filePath, type)
    load()
  }, [load])

  if (!prefs) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
        Loading...
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', fontFamily: "var(--font-body)", overflow: 'hidden' }}>
      {/* Header — centered max-width column (matches PrefsView so every page is
          balanced on a wide window instead of pinned left). */}
      <div style={{ padding: '16px 24px 0', flexShrink: 0, maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
          {projectName}
        </h2>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '4px 0 0', opacity: 0.6 }}>
          {projectPath}
        </p>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex',
        gap: 0,
        padding: '16px 24px 0',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box',
      }}>
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              color: tab === activeTab ? 'var(--fg)' : 'var(--fg-muted)',
              background: 'none',
              border: 'none',
              borderBottom: tab === activeTab ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px 40px', maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        {activeTab === 'Instructions' && (
          <InstructionsSection
            mdFiles={prefs.mdFiles}
            onSave={handleSaveMd}
            onCreate={(path) => handleCreateFile(path, 'md')}
          />
        )}
        {activeTab === 'Permissions' && (
          <PermissionsSection
            settingsFiles={prefs.settingsFiles}
            onSave={handleSaveSettings}
            onCreate={(path) => handleCreateFile(path, 'settings')}
          />
        )}
        {activeTab === 'General' && (
          <GeneralSection
            settingsFiles={prefs.settingsFiles}
            onSave={handleSaveSettings}
            onCreate={(path) => handleCreateFile(path, 'settings')}
          />
        )}
        {activeTab === 'Hooks' && (
          <HooksSection settingsFiles={prefs.settingsFiles} />
        )}
        {activeTab === 'Plugins' && (
          <PluginsSection
            settingsFiles={prefs.settingsFiles}
            onSave={handleSaveSettings}
          />
        )}
      </div>
    </div>
  )
}
