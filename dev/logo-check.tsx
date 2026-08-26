import { createRoot } from 'react-dom/client'
import { LogoMark } from '../src/renderer/components/LogoMark'
import '../src/renderer/styles.css'

// DEV-ONLY. The brand mark on its own, so a harness can check that it still shimmers. Pass 1
// renamed the orb's `twinkle` keyframe and left this component pointing at a rule that no longer
// existed — the mark stopped animating and nothing caught it, because nothing looked.
document.documentElement.style.setProperty('--fg', '#e6eaf0')
document.documentElement.style.setProperty('--fg-muted', '#8a94a0')
document.body.style.background = '#07090b'
createRoot(document.getElementById('root')!).render(<LogoMark size={96} cells={11} />)
