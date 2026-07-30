// Visual-verification harness for the CANVAS chat's lane identity.
//
// The chat transcript is PAINTED on a <canvas>, so nothing about who the agent says it is
// — the turn's name, its ink, its orb — is queryable or unit-testable. This mounts the real
// CanvasConversation twice against fixture sessions (one on a lane, one lane-less) so a
// headless WebKit screenshot can confirm the three things that used to be wrong: the header
// read a hardcoded "Agent", the name was painted --fg-muted, and the orb ignored the role.
//
// It imports the REAL styles.css + applyTheme so --fg / --lane-ink-blend are production
// values (the ink blend is exactly what keeps a lane accent legible on light themes).
// Loaded by scripts/visual/chat.html, captured by capture.mjs --page chat.
import '../../src/renderer/styles.css'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import type { AgentSession, NarrationEntry, Role } from '../../src/shared/types'
import { CanvasConversation } from '../../src/renderer/components/session/CanvasConversation'
import { applyTheme, themes, defaultTheme } from '../../src/renderer/themes'

// Minimal preload stub: the chat only reaches for IPC on history load and on interaction,
// neither of which a static screenshot exercises. Typed loosely on purpose — this is a
// harness, and mirroring the full preload surface here would just be a second thing to drift.
;(window as unknown as { operator: unknown }).operator = {
  chatHistory: async () => [],
  openExternal: () => {},
  terminalWrite: () => {},
  savePastedImage: async () => '',
  folderPrefsLoad: async () => ({}),
  folderPrefsSaveSettings: async () => {},
}

const AT = '2026-07-28T21:07:00.000Z'
const turns: NarrationEntry[] = [
  { kind: 'user', text: 'Deep-dive Contífico and map its SRI integration.', timestamp: AT },
  { kind: 'thinking', text: 'Checking which comprobantes they actually emit before comparing.', timestamp: AT },
  {
    kind: 'text',
    text: 'Mapped it. They emit **factura**, nota de crédito and retención; guías de remisión\nare the gap worth probing next.',
    timestamp: AT,
  },
]

function session(id: string, roleId?: string): AgentSession {
  return {
    id,
    agentId: id,
    workingDirectory: '/Users/x/Developer/mantel-landing',
    projectName: 'mantel-landing',
    projectId: 'mantel-landing',
    roleId,
    status: 'active',
    phase: 'idle',
    activity: [],
    messages: turns,
    activeSubagents: 0,
    lastToolName: null,
    startedAt: AT,
    lastActivityAt: AT,
    // No summary: with a lane the name comes from the roster, and lane-less falls through
    // the ladder to the model — both rungs we want visible in one shot.
    model: 'sonnet',
  }
}

// The real default-roster lane, accent included — not a colour invented for the harness.
const research: Role = { id: 'research', name: 'Research', model: 'sonnet', effort: 'high', accent: '#5ac8fa' }

// `?theme=` so one harness covers both shifts: the lane ink-blend only does work on a light
// canvas, where a raw accent as text measures as low as 1.34:1.
const themeKey = new URLSearchParams(location.search).get('theme') || 'mission-control-dark'
applyTheme(themes[themeKey] ?? defaultTheme)

// Sized INLINE, not by a `#chat > div` rule: the panes are the flex items themselves, and a
// zero-height pane paints no transcript at all (the canvas bails under 40px of width).
const pane = { width: 520, height: 460, position: 'relative' as const, overflow: 'hidden' }

createRoot(document.getElementById('chat')!).render(
  createElement(
    'div',
    { style: { display: 'flex', gap: 12 } },
    createElement('div', { key: 'lane', style: pane }, createElement(CanvasConversation, {
      session: session('s-lane', 'research'),
      role: research,
      accent: research.accent,
    })),
    createElement('div', { key: 'bare', style: pane }, createElement(CanvasConversation, {
      session: session('s-bare'),
    })),
  ),
)

// capture.mjs waits on this rather than a timer: the canvas paints on rAF after layout.
requestAnimationFrame(() => requestAnimationFrame(() => {
  setTimeout(() => { (window as unknown as { __visualReady: boolean }).__visualReady = true }, 400)
}))
