import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { DashboardView } from './views/DashboardView'
import { applyTheme, themes, resolveThemeKey } from './themes'

export default function App() {
  useEffect(() => {
    applyTheme(themes[resolveThemeKey(localStorage.getItem('operator.theme'))])
    // Re-apply the saved dock-icon choice — setApplicationIconImage only affects
    // the running app, so it must be set on every launch (default: light/bundle).
    const dock = localStorage.getItem('operator.dockIcon') === 'dark' ? 'dark' : 'light'
    window.operator.setDockIcon?.(dock)

    // The main window launches hidden behind the splash. Once we've painted a
    // frame (two rAFs + a short beat so the splash doesn't just flash), tell the
    // backend to close the splash and reveal the fully-rendered window. A timer
    // is the safety net in case rAF never settles.
    let revealed = false
    const reveal = () => {
      if (revealed) return
      revealed = true
      void invoke('app_ready').catch(() => {})
    }
    // Hold the splash ~1s so it registers as an intentional launch beat, not a flash.
    // The safety timer (longer) still guarantees reveal if rAF never settles.
    const safety = setTimeout(reveal, 3000)
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(reveal, 1000)))

    // Liveness heartbeat for the backend stall watchdog. While the main thread runs,
    // this fires every second; if the thread hangs (e.g. a ghostty resize/render loop),
    // the pings stop and the backend kills+respawns the frozen WebContent to self-heal.
    window.operator.rendererHeartbeat?.()
    const heartbeat = setInterval(() => window.operator.rendererHeartbeat?.(), 1000)
    return () => { clearTimeout(safety); clearInterval(heartbeat) }
  }, [])

  return <DashboardView />
}
