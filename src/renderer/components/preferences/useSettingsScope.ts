import { useState, useCallback } from 'react'
import type { SettingsFile } from '../../../shared/types'

export function useSettingsScope(settingsFiles: SettingsFile[], onCreate: (path: string) => void) {
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

  return { activeScope, setActiveScope, activeFile, handleCreateFile }
}
