import { createRoot } from 'react-dom/client'
import { installMockBridge } from './mock-bridge'
import App from '../src/renderer/App'
import '../src/renderer/styles.css'

// Same shape as src/tauri-main.tsx, but with the mock bridge — so the REAL App
// renders in a browser the test harness can click and type into.
installMockBridge()
createRoot(document.getElementById('root')!).render(<App />)
