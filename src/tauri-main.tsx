import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { installBridge } from './operator-bridge'
import App from './renderer/App'
import './renderer/styles.css'

// Provide window.operator before React mounts so the existing UI just works.
installBridge()

// THE SPLASH SAFETY NET LIVES HERE, not in App's effect.
//
// The main window launches hidden behind a splash; `app_ready` closes the splash and reveals
// it. App.tsx schedules that reveal (and its own fallback timer) inside a useEffect — and an
// effect only runs after a successful commit. So if DashboardView or anything it imports
// throws during render, App never mounts, the timer is never scheduled, `app_ready` is never
// invoked, and the window stays hidden behind a splash forever with nothing on screen saying
// why. The fallback was inside the thing it was meant to protect.
//
// This timer is armed before React is even asked to render, so a render failure cannot reach
// it. Revealing a broken window beats hiding a broken app: the error is then visible in the
// window (and in devtools) instead of presenting as an unexplained hang. App's own faster
// reveal still wins the race in the normal case — `app_ready` is idempotent on the backend.
setTimeout(() => { void invoke('app_ready').catch(() => {}) }, 8000)

// And braces: a render throw reveals immediately rather than waiting out the timer.
try {
  createRoot(document.getElementById('root')!).render(<App />)
} catch {
  void invoke('app_ready').catch(() => {})
}
