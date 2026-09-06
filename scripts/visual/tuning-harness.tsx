// Visual-verification harness for the Tuning page.
//
// Mounts the REAL `TuningView` — not a copy — against the mock bridge's fixture window, which is
// shaped to exercise the branches worth seeing: one lane over the card's 25% threshold with a
// step available, a second lane, and an unattributed transcript so the "Not attributed" row and
// the shares-still-sum rule both render.
//
// `tsc` proves the page compiles. This proves it DRAWS, which is a different claim and the one a
// layout regression breaks first.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/styles.css'
import { installMockBridge } from '../../dev/mock-bridge'
import { TuningView } from '../../src/renderer/components/tuning/TuningView'
import type { Project, SavedSession } from '../../src/shared/types'

installMockBridge()

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') ?? 'mission-control-dark'

// The roster the fixture sessions join to. Ids match `mock-bridge`'s `getTuning` sessions.
const projects: Project[] = [{
  id: 'p-op', name: 'operator', path: '/Users/dev/operator', createdAt: '',
  roster: [
    { id: 'code', name: 'Code', model: 'opus', effort: 'xhigh', accent: '#7ee787' },
    { id: 'research', name: 'Research', model: 'sonnet', accent: '#5ac8fa' },
  ],
} as Project]

const saved: SavedSession[] = [
  { id: 'a', cwd: '/Users/dev/operator', claudeSessionId: 's-code', roleId: 'code', projectId: 'p-op' },
  { id: 'b', cwd: '/Users/dev/operator', claudeSessionId: 's-research', roleId: 'research', projectId: 'p-op' },
] as SavedSession[]

createRoot(document.getElementById('tuning')!).render(
  createElement(TuningView, { projects, saved }),
)
