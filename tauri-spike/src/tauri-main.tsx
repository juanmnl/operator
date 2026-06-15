import { createRoot } from 'react-dom/client'
import { installBridge } from './operator-bridge'
import App from '../../src/renderer/App'
import '../../src/renderer/styles.css'

// Provide window.operator before React mounts so the existing UI just works.
installBridge()

createRoot(document.getElementById('root')!).render(<App />)
