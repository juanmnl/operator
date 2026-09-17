import { useEffect, useState, useCallback } from 'react'
import type { FolderPreferences, ClaudeSettings, Project } from '../../../shared/types'
import { InstructionsSection } from './InstructionsSection'
import { PermissionsSection } from './PermissionsSection'
import { GeneralSection } from './GeneralSection'
import { HooksSection } from './HooksSection'
import { PluginsSection } from './PluginsSection'
import { EnvironmentSection } from './EnvironmentSection'
import { SkillsSection } from './SkillsSection'
import { WorktreesSection } from './WorktreesSection'
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
  /** Open on this tab rather than the first, e.g. `Environment` from a deep link. Applied when the
   *  view opens and whenever a different tab or project is asked for. */
  initialTab?: FolderPrefsTab
  /** Every project in the store. Only the global view passes it, for the Environment tab's
   *  doorway — a project's own page has a `project` and never reads this. */
  projects?: Project[]
  /** Opens another project's settings on a tab. Only the global view passes it. */
  onOpenFolderPrefs?: (projectPath: string, projectName: string, tab?: FolderPrefsTab) => void
}

export const FOLDER_PREFS_TABS = ['Instructions', 'Permissions', 'General', 'Hooks', 'Plugins', 'Environment', 'Skills', 'Worktrees'] as const
const TABS = FOLDER_PREFS_TABS
export type FolderPrefsTab = (typeof TABS)[number]
type Tab = FolderPrefsTab

/** The page title. `Project settings · <name>` for a project, `Global settings` for `~/.claude`.
 *  The name is bound to the separator with non-breaking spaces, so a narrow pane cannot leave the
 *  project name alone on the second line with its `·` stranded at the end of the first. */
export function folderPrefsTitle(projectName: string, globalOnly: boolean): string {
  if (globalOnly) return 'Global settings'
  const name = projectName.trim()
  return name ? `Project settings\u00a0·\u00a0${name}` : 'Project settings'
}

/** The line under the title: where the files live, and for global, that it applies everywhere. */
export function folderPrefsSubtitle(projectPath: string, globalOnly: boolean): string {
  return globalOnly ? '~/.claude · applies to every\u00a0project' : projectPath
}

export function FolderPreferencesView({ projectPath, projectName, globalOnly = false, project = null, onPatchProject, initialTab, projects, onOpenFolderPrefs }: FolderPreferencesViewProps) {
  const [prefs, setPrefs] = useState<FolderPreferences | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'Instructions')
  useEffect(() => { if (initialTab) setActiveTab(initialTab) }, [initialTab, projectPath])

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
      title={folderPrefsTitle(projectName, globalOnly)}
      subtitle={folderPrefsSubtitle(projectPath, globalOnly)}
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
            projects={projects}
            onOpenFolderPrefs={onOpenFolderPrefs}
          />
        )}
        {/* Machine-wide, not project-scoped — `~/.operator/worktrees` holds every project's
            lanes. It sits here because this is where the app's file-level settings live, and a
            second full-page view for one list would be a worse trade. */}
        {activeTab === 'Worktrees' && <WorktreesSection />}
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
