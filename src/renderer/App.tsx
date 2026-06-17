import { useEffect } from 'react'
import { DashboardView } from './views/DashboardView'
import { applyTheme, themes, resolveThemeKey } from './themes'

export default function App() {
  useEffect(() => {
    applyTheme(themes[resolveThemeKey(localStorage.getItem('operator.theme'))])
  }, [])

  return <DashboardView />
}
