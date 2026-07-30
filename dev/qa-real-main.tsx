import { createRoot } from 'react-dom/client'
import { installRealBridge } from './qa-real-bridge'
import App from '../src/renderer/App'
import '../src/renderer/styles.css'

installRealBridge()
createRoot(document.getElementById('root')!).render(<App />)
