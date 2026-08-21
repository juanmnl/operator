import { createRoot } from 'react-dom/client'
import { installSpikeBridge } from './bridge'
import App from '../../../src/renderer/App'
import '../../../src/renderer/styles.css'

// Same shape as `src/tauri-main.tsx` and `dev/mock-main.tsx` — the REAL App, over this
// shell's bridge. The renderer is byte-for-byte the shipped one; only the seam differs,
// which is the entire premise of the port.
installSpikeBridge()
createRoot(document.getElementById('root')!).render(<App />)
