import { useEffect, useState, useCallback } from 'react'
import type { FolderPreferences, ClaudeSettings, Project } from '../../../shared/types'
import { InstructionsSection } from './InstructionsSection'
import { PermissionsSection } from './PermissionsSection'
import { GeneralSection } from './GeneralSection'
import { HooksSection } from './HooksSection'
import { PluginsSection } from './PluginsSection'
import { EnvironmentSection } from './EnvironmentSection'
import { SkillsSection } from './SkillsSection'
import { PageShell } from '../settings/PageShell'

interface FolderPreferencesViewProps {
  projectPath: string
  projectName: string
  /** When true, loads global-only files (~/.claude/*) and hides project tabs context. */
  globalOnly?: boolean
  /** The Operator-side project record. Environment writes `projects.json` through `onPatch`,
   *  NOT the repo's `.claude/settings.json` — that file already has a writer on the tabs to the
   *  left, and one writer per file is the rule. Absent in the global view. */
  project?: Project | null
  onPatchProject?: (patch: Partial<Project>) => void
}

const TABS = ['Instructions', 'Permissions', 'General', 'Hooks', 'Plugins', 'Environment', 'Skills'] as const
type Tab = (typeof TABS)[number]

export function FolderPreferencesView({ projectPath, projectName, globalOnly = false, project = null, onPatchProject }: FolderPreferencesViewProps) {
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
    // save_md_file now surfaces fs errors; re-load either way so the editor
    // shows what's actually on disk rather than pretending the save landed.
    try {
      await window.operator.folderPrefsSaveMd(filePath, content)
    } catch (e) {
      console.error('folderPrefsSaveMd failed:', e)
    }
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
    <PageShell
      title={projectName}
      subtitle={projectPath}
      measure="form"
      tabs={TABS.map((t) => ({ id: t, label: t }))}
      active={activeTab}
      onSelectTab={(id) => setActiveTab(id as typeof TABS[number])}
    >
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
        {activeTab === 'Environment' && (
          <EnvironmentSection
            project={project}
            onPatch={(patch) => onPatchProject?.(patch)}
            settingsFiles={prefs.settingsFiles}
          />
        )}
        {activeTab === 'Skills' && (
          <SkillsSection
            projectPath={globalOnly ? '' : projectPath}
            settingsFiles={prefs.settingsFiles}
            globalSettings={prefs.settingsFiles.find((f) => f.scope === 'global') ?? null}
          />
        )}
    </PageShell>
  )
}
