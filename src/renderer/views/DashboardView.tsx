import { useEffect, useState, useCallback } from 'react'
import { AgentSession, OperatorRequest } from '../../shared/types'
import { Sidebar } from '../components/sidebar/Sidebar'
import { TerminalPane } from '../components/terminal/TerminalPane'
import { InlinePermission } from '../components/terminal/InlinePermission'
import { SessionActivityView } from '../components/session/SessionActivityView'
import { FolderPreferencesView } from '../components/preferences/FolderPreferencesView'
import { SessionToolbar } from '../components/session/SessionToolbar'
import { SessionInfoBar } from '../components/session/SessionInfoBar'
import { NewSessionPanel, SessionConfig } from '../components/session/NewSessionPanel'
import { themes, defaultTheme, applyTheme } from '../themes'
import type { OperatorTheme } from '../themes'
import logoUrl from '../../../assets/logo-light-64.png'

interface TerminalTab {
  id: string
  cwd: string
  effortLevel?: 'high' | 'normal' | 'low'
  permissionMode?: string
}

export function DashboardView() {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [pendingRequests, setPendingRequests] = useState<OperatorRequest[]>([])
  const [customNames, setCustomNames] = useState<Record<string, string>>({})
  const [activeFolderPrefs, setActiveFolderPrefs] = useState<{ projectPath: string; projectName: string } | null>(null)
  const [pendingSession, setPendingSession] = useState<string | null>(null) // cwd awaiting launch
  const [currentTheme, setCurrentTheme] = useState<OperatorTheme>(defaultTheme)
  const [hookPath, setHookPath] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleRename = useCallback((sessionId: string, name: string) => {
    setCustomNames((prev) => ({ ...prev, [sessionId]: name }))
  }, [])

  useEffect(() => {
    window.operator.getSessions().then(setSessions)
    window.operator.getQueue().then(setPendingRequests)
    window.operator.getHookPath().then(setHookPath)

    const unsubSession = window.operator.onSessionUpdate(setSessions)
    const unsubRequest = window.operator.onNewRequest((request) => {
      setPendingRequests((prev) => [...prev, request])
    })

    // Poll sessions every 1s for responsive status updates
    const pollInterval = setInterval(() => {
      window.operator.getSessions().then(setSessions)
      window.operator.getQueue().then(setPendingRequests)
    }, 1000)
    const unsubExit = window.operator.onTerminalExit((id) => {
      setTerminals((prev) => prev.filter((t) => t.id !== id))
      setActiveTerminalId((current) => (current === id ? null : current))
      setActiveSessionId((current) => {
        // If the ended terminal was the active session, clear it
        const wasActive = sessions.find((s) => s.terminalId === id && s.id === current)
        return wasActive ? null : current
      })
    })

    return () => { unsubSession(); unsubRequest(); unsubExit(); clearInterval(pollInterval) }
  }, [])

  const handleNewSession = useCallback(async () => {
    const folder = await window.operator.pickFolder()
    if (folder) {
      setPendingSession(folder)
      setActiveSessionId(null)
      setActiveTerminalId(null)
      setActiveFolderPrefs(null)
    }
  }, [])

  const handleLaunchSession = useCallback(async (cwd: string, config: SessionConfig) => {
    // Write effort level to global settings (Claude Code reads it from there)
    const prefs = await window.operator.folderPrefsLoad(cwd)
    const globalFile = prefs.settingsFiles.find((f) => f.scope === 'global')
    if (globalFile) {
      await window.operator.folderPrefsSaveSettings(globalFile.path, { effortLevel: config.effortLevel })
    }

    const launchOptions: Record<string, unknown> = {}
    if (config.permissionMode !== 'default') launchOptions.permissionMode = config.permissionMode
    if (config.model) launchOptions.model = config.model
    if (config.allowedTools) launchOptions.allowedTools = config.allowedTools

    const result = await window.operator.terminalSpawn(cwd, launchOptions)
    if (result) {
      const tab: TerminalTab = {
        id: result.terminalId,
        cwd: result.cwd,
        effortLevel: config.effortLevel,
        permissionMode: config.permissionMode,
      }
      setTerminals((prev) => [...prev, tab])
      setActiveTerminalId(result.terminalId)
      setActiveSessionId(`local-${result.terminalId}`)
    }
    setPendingSession(null)
  }, [])

  const handleSelectSession = useCallback((session: AgentSession) => {
    const localTerminalIds = new Set(terminals.map((t) => t.id))
    setActiveSessionId(session.id)
    setActiveFolderPrefs(null)
    setPendingSession(null)
    if (session.terminalId && localTerminalIds.has(session.terminalId)) {
      setActiveTerminalId(session.terminalId)
    } else {
      setActiveTerminalId(null)
    }
  }, [terminals])

  const handleToggleTheme = useCallback(() => {
    const next = currentTheme.isDark ? themes['light'] : themes['mr-pink']
    setCurrentTheme(next)
    applyTheme(next)
  }, [currentTheme])

  // Build effort level map from terminal tabs (keyed by terminalId)
  const effortLevels: Record<string, string> = {}
  for (const t of terminals) {
    if (t.effortLevel) effortLevels[t.id] = t.effortLevel
  }

  const handleOpenFolderPrefs = useCallback((projectPath: string, projectName: string) => {
    setActiveFolderPrefs({ projectPath, projectName })
    setActiveSessionId(null)
    setActiveTerminalId(null)
    setPendingSession(null)
  }, [])

  const handleRespond = useCallback(async (id: string, value: string) => {
    await window.operator.respond(id, value)
    setPendingRequests((prev) => prev.filter((r) => r.id !== id))
  }, [])

  // Build sidebar entries: local terminals + external sessions
  const localTerminalIds = new Set(terminals.map((t) => t.id))

  const localSessions: AgentSession[] = terminals.map((t) => {
    const hookSession = sessions.find((s) => s.terminalId === t.id)
    if (hookSession) return hookSession
    return {
      id: `local-${t.id}`,
      agentId: 'claude-code',
      workingDirectory: t.cwd,
      projectName: t.cwd.split('/').pop() || t.cwd,
      status: 'active' as const,
      phase: 'idle' as const,
      entries: [],
      activity: [],
      activeSubagents: 0,
      lastToolName: null,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      terminalId: t.id,
    }
  })

  const externalSessions = sessions.filter(
    (s) => s.status === 'active' && (!s.terminalId || !localTerminalIds.has(s.terminalId))
  )

  const allSidebarSessions = [...localSessions, ...externalSessions]

  // Notify main process of active session for widget visibility
  useEffect(() => {
    window.operator.setActiveSession(activeSessionId)
  }, [activeSessionId])

  // Keep activeSessionId in sync — if a local-* placeholder gets a real hook session, update
  useEffect(() => {
    if (activeSessionId?.startsWith('local-')) {
      const tid = activeSessionId.replace('local-', '')
      const hookSession = sessions.find((s) => s.terminalId === tid)
      if (hookSession) {
        setActiveSessionId(hookSession.id)
      }
    }
    // If active external session ended, clear selection
    if (activeSessionId && !activeTerminalId) {
      const extSession = sessions.find((s) => s.id === activeSessionId)
      if (extSession && extSession.status === 'ended') {
        setActiveSessionId(null)
      }
    }
  }, [sessions, activeSessionId, activeTerminalId])

  // Find pending requests for the active session
  const activeSession = allSidebarSessions.find((s) => s.id === activeSessionId)
  const activeRequests = pendingRequests.filter(
    (r) => r.terminalId === activeTerminalId || r.sessionId === activeSession?.id
  )

  // Determine what to show in content area
  const isExternalSelected = activeSessionId && !activeTerminalId
  const externalActiveSession = isExternalSelected
    ? sessions.find((s) => s.id === activeSessionId)
    : null

  const hookConfigSnippet = hookPath
    ? `{
  "hooks": {
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }],
    "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookPath}" }] }]
  }
}`
    : ''

  return (
    <div style={{ display: 'flex', width: '100%', height: '100vh', background: 'var(--bg-terminal)' }}>
      <Sidebar
        sessions={allSidebarSessions}
        activeSessionId={activeSessionId}
        localTerminalIds={localTerminalIds}
        customNames={customNames}
        pendingRequests={pendingRequests}
        activeFolderPrefs={activeFolderPrefs?.projectPath ?? null}
        effortLevels={effortLevels}
        isDark={currentTheme.isDark}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRename}
        onNewSession={handleNewSession}
        onOpenFolderPrefs={handleOpenFolderPrefs}
        onToggleTheme={handleToggleTheme}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Drag region — only show full height when no toolbar is visible */}
        {(pendingSession || activeFolderPrefs || !activeSession) && (
          <div style={{ height: 40,
            // @ts-expect-error Electron-specific CSS property
            WebkitAppRegion: 'drag',
            flexShrink: 0,
          }} />
        )}

        {/* Pre-launch session config */}
        {pendingSession && (
          <NewSessionPanel
            cwd={pendingSession}
            onLaunch={handleLaunchSession}
            onCancel={() => setPendingSession(null)}
          />
        )}

        {/* Session toolbar with effort badge + MCP indicator */}
        {!pendingSession && !activeFolderPrefs && activeSession && (
          <SessionToolbar
            key={activeSession.workingDirectory}
            projectPath={activeSession.workingDirectory}
            projectName={activeSession.projectName}
            effortLevel={terminals.find((t) => t.id === activeTerminalId)?.effortLevel}
            permissionMode={terminals.find((t) => t.id === activeTerminalId)?.permissionMode || activeSession.permissionMode}
            lastToolName={activeSession.lastToolName}
          />
        )}

        {/* Folder preferences view */}
        {!pendingSession && activeFolderPrefs && (
          <FolderPreferencesView
            projectPath={activeFolderPrefs.projectPath}
            projectName={activeFolderPrefs.projectName}
          />
        )}

        {/* Session info bar for local sessions */}
        {!pendingSession && !activeFolderPrefs && activeSession && activeTerminalId && (
          <SessionInfoBar session={activeSession} />
        )}

        {/* Terminal panes — all stay mounted, only active is visible */}
        {!pendingSession && !activeFolderPrefs && terminals.length > 0 && (
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: activeTerminalId ? 'block' : 'none' }}>
            {terminals.map((t) => (
              <div
                key={t.id}
                style={{
                  position: 'absolute',
                  inset: 0,
                  visibility: t.id === activeTerminalId ? 'visible' : 'hidden',
                }}
              >
                <TerminalPane
                  terminalId={t.id}
                  theme={currentTheme.xterm}
                  active={t.id === activeTerminalId}
                />
              </div>
            ))}
          </div>
        )}

        {/* External session activity view */}
        {!pendingSession && !activeFolderPrefs && externalActiveSession && (
          <SessionActivityView
            session={externalActiveSession}
            pendingRequests={activeRequests}
          />
        )}

        {/* Inline permission bar */}
        {!pendingSession && !activeFolderPrefs && activeSessionId && activeRequests.length > 0 && (
          <InlinePermission
            request={activeRequests[0]}
            onRespond={(value) => handleRespond(activeRequests[0].id, value)}
          />
        )}

        {/* Splash screen */}
        {!pendingSession && !activeFolderPrefs && !activeSessionId && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: "'Inter', system-ui, sans-serif",
              padding: '40px 40px',
              overflow: 'auto',
              minHeight: 0,
              maxWidth: 480,
              margin: '0 auto',
            }}
          >
            <img src={logoUrl} width={64} height={64} alt="" style={{ marginBottom: 20, filter: currentTheme.isDark ? 'none' : 'invert(1)' }} />
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <p style={{
                fontSize: 13,
                color: 'var(--fg)',
                fontWeight: 500,
                lineHeight: 1.7,
                margin: 0,
              }}>
                Mission control for your AI coding sessions.
              </p>
              <p style={{
                fontSize: 12,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '12px 0 0',
              }}>
                Operator connects to every Claude Code process on your machine.
                When an agent needs a decision, Operator surfaces it — as an
                inline prompt here, or as a notification pill over whatever
                app you're in. Approve, deny, keep moving.
              </p>
              <p style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                lineHeight: 1.7,
                margin: '10px 0 0',
                opacity: 0.6,
              }}>
                Run agents in any terminal. Operator picks them up automatically.
              </p>
            </div>

            <button
              onClick={handleNewSession}
              style={{
                padding: '7px 20px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--fg)',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              + New Session
            </button>
            <p style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.5, marginTop: 8 }}>
              Cmd+N
            </p>

            {/* Hook config (collapsible) */}
            <div style={{ marginTop: 28, width: '100%' }}>
              <button
                onClick={() => setShowSetup(!showSetup)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--fg-muted)',
                  fontSize: 10,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  opacity: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  margin: '0 auto',
                }}
              >
                <span style={{ transform: showSetup ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>
                  &#9654;
                </span>
                Hook configuration
              </button>

              {showSetup && hookPath && (
                <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
                    Operator configures hooks automatically on launch. If you need to set them up manually,
                    add this to <code style={{ fontSize: 10, background: 'var(--bg-terminal)', padding: '1px 4px', borderRadius: 3 }}>~/.claude/settings.json</code>:
                  </p>
                  <pre
                    style={{
                      fontSize: 10,
                      background: 'var(--bg-terminal)',
                      color: 'var(--fg)',
                      padding: '10px 12px',
                      borderRadius: 6,
                      overflow: 'auto',
                      margin: '0 0 8px',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {hookConfigSnippet}
                  </pre>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(hookConfigSnippet)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                    style={{
                      padding: '4px 12px',
                      background: copied ? 'var(--green)' : 'var(--bg-terminal)',
                      color: copied ? '#fff' : 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      fontSize: 11,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy Config'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
