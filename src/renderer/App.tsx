import { useEffect } from 'react'
import { DashboardView } from './views/DashboardView'
import { applyTheme, defaultTheme, themes } from './themes'

export default function App() {
  useEffect(() => {
    const saved = localStorage.getItem('operator.theme')
    applyTheme((saved && themes[saved]) || defaultTheme)
  }, [])

  return <DashboardView />
}
