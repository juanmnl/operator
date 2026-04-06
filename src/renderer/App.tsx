import { useEffect, useState } from 'react'
import { DashboardView } from './views/DashboardView'
import { WidgetView } from './views/WidgetView'
import { applyTheme, defaultTheme } from './themes'

function getRoute(): string {
  const hash = window.location.hash.replace('#', '')
  return hash || '/dashboard'
}

export default function App() {
  const [route, setRoute] = useState(getRoute)

  useEffect(() => {
    applyTheme(defaultTheme)
  }, [])

  useEffect(() => {
    const onHashChange = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Set transparent bg class for widget window
  useEffect(() => {
    if (route === '/widget') {
      document.body.classList.add('widget-bg')
    }
  }, [route])

  switch (route) {
    case '/widget':
      return <WidgetView />
    case '/dashboard':
    default:
      return <DashboardView />
  }
}
