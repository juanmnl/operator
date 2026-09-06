import { createRoot } from 'react-dom/client'
import { WorktreesSection } from '../src/renderer/components/preferences/WorktreesSection'
import { applyTheme, defaultTheme } from '../src/renderer/themes/index'
import '../src/renderer/styles.css'
import fixtureRows from './qa-devservers-fixture.json'

applyTheme(defaultTheme)

const calls: Array<{ fn: string; args: unknown[] }> = []
;(window as unknown as { __calls: unknown[] }).__calls = calls

;(window as unknown as { operator: unknown }).operator = new Proxy({
  devServerList: async () => fixtureRows,
  devServerKill: async (pids: number[]) => {
    calls.push({ fn: 'devServerKill', args: [pids] })
    return pids.length
  },
  worktreeReapPlan: async () => ({ entries: [], auto: [], asks: [], totalBytes: 0, autoBytes: 0, sizesOmitted: true }),
  worktreeReap: async () => { throw new Error('not exercised by this harness') },
}, {
  get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : (...args: unknown[]) => { calls.push({ fn: p, args }); return Promise.resolve(undefined) }),
})

createRoot(document.getElementById('root')!).render(<WorktreesSection />)
