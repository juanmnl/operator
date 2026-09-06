import { createRoot } from 'react-dom/client'
import { installTuningBridge } from './qa-tuning-bridge'
import App from '../src/renderer/App'
import '../src/renderer/styles.css'

installTuningBridge()
createRoot(document.getElementById('root')!).render(<App />)
