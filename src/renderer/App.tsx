import { useEffect } from 'react'
import { DashboardView } from './views/DashboardView'
import { applyTheme, themes, resolveThemeKey } from './themes'

export default function App() {
  useEffect(() => {
    applyTheme(themes[resolveThemeKey(localStorage.getItem('operator.theme'))])
    // Re-apply the saved dock-icon choice — setApplicationIconImage only affects
    // the running app, so it must be set on every launch (default: light/bundle).
    const dock = localStorage.getItem('operator.dockIcon') === 'dark' ? 'dark' : 'light'
    window.operator.setDockIcon?.(dock)
  }, [])

  return <DashboardView />
}
