import { useEffect, useState } from 'react'
import type { RepoInfo } from '../../../shared/types'

export interface SessionConfig {
  effortLevel: 'high' | 'normal' | 'low'
  permissionMode: 'default' | 'auto' | 'bypassPermissions'
  model: string
  allowedTools: string
  useWorktree: boolean
  /** Number of parallel agents to fan the task out to (1 = a single session). */
  count: number
  /** Initial task submitted to every agent on launch (required when count > 1). */
  prompt: string
}

interface NewSessionPanelProps {
  cwd: string
  onLaunch: (cwd: string, config: SessionConfig) => void
  onCancel: () => void
}

const EFFORT_LEVELS = ['high', 'normal', 'low'] as const
const PERMISSION_MODES = [
  { value: 'default', label: 'Default', desc: 'Ask for write operations' },
  { value: 'auto', label: 'Auto', desc: 'Auto-approve most operations' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Skip all permission checks' },
] as const

// Lead model for the session. Empty = account default. Aliases map to `--model`.
const MODEL_OPTIONS = [
  { value: '', label: 'Default (account setting)' },
  { value: 'haiku', label: 'Haiku — fast & cheap' },
  { value: 'sonnet', label: 'Sonnet — balanced' },
  { value: 'opus', label: 'Opus — most capable' },
  { value: 'fable', label: 'Fable 5 — frontier' },
  { value: 'opusplan', label: 'Opus plan / Sonnet execution' },
] as const

// Per-model cost hint (public per-MTok input/output rates).
const MODEL_COST: Record<string, string> = {
  '': 'Your account default model',
  haiku: '$1 / $5 per Mtok — cheapest & fastest',
  sonnet: '$3 / $15 per Mtok — balanced',
  opus: '$5 / $25 per Mtok — most capable',
  fable: '$10 / $50 per Mtok — frontier',
  opusplan: 'Opus rates while planning, Sonnet while executing',
}

export function NewSessionPanel({ cwd, onLaunch, onCancel }: NewSessionPanelProps) {
  const [effortLevel, setEffortLevel] = useState<SessionConfig['effortLevel']>('high')
  const [permissionMode, setPermissionMode] = useState<SessionConfig['permissionMode']>('default')
  const [model, setModel] = useState('')
  const [allowedTools, setAllowedTools] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [count, setCount] = useState(1)
  const [prompt, setPrompt] = useState('')
  const projectName = cwd.split('/').pop() || cwd
  const fanning = count > 1

  useEffect(() => {
    let cancelled = false
    window.operator.inspectRepo(cwd).then((info) => {
      if (cancelled) return
      setRepoInfo(info)
      // Default ON when it's a git repo with commits — parallel-safe by default.
      if (info.isRepo) setUseWorktree(true)
    })
    return () => { cancelled = true }
  }, [cwd])

  const handleLaunch = () => {
    if (fanning && !prompt.trim()) return
    onLaunch(cwd, {
      effortLevel, permissionMode, model, allowedTools,
      // Fan-out requires per-agent isolation, so worktrees are forced on.
      useWorktree: (useWorktree || fanning) && !!repoInfo?.isRepo,
      count, prompt: prompt.trim(),
    })
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', system-ui, sans-serif",
        padding: '0 40px',
        overflow: 'auto',
        minHeight: 0,
      }}
    >
      <div style={{
        width: '100%',
        maxWidth: 380,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '24px',
      }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: '0 0 4px' }}>
          New Session
        </h3>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '0 0 20px', opacity: 0.6 }}>
          {cwd}
        </p>

        {/* Effort Level */}
        <SegmentedControl
          label="Effort"
          options={EFFORT_LEVELS.map((l) => ({ value: l, label: l }))}
          value={effortLevel}
          onChange={(v) => setEffortLevel(v as SessionConfig['effortLevel'])}
        />

        {/* Permission Mode */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Permissions</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {PERMISSION_MODES.map((mode) => (
              <button
                key={mode.value}
                onClick={() => setPermissionMode(mode.value as SessionConfig['permissionMode'])}
                style={{
                  flex: 1,
                  padding: '6px 0',
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: permissionMode === mode.value ? 'rgba(255,255,255,0.1)' : 'var(--bg-terminal)',
                  color: permissionMode === mode.value ? 'var(--fg)' : 'var(--fg-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  cursor: 'pointer',
                  transition: 'background 0.1s, color 0.1s',
                }}
                title={mode.desc}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.5, margin: '4px 0 0' }}>
            {PERMISSION_MODES.find((m) => m.value === permissionMode)?.desc}
          </p>
        </div>

        {/* Model — lead model for the session */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={selectStyle}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <p style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.5, margin: '4px 0 0' }}>
            {MODEL_COST[model] ?? ''}
          </p>
        </div>

        {/* Isolated worktree (git repos only) */}
        {repoInfo?.isRepo && (
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Isolation</label>
            <button
              onClick={() => setUseWorktree(!useWorktree)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                background: useWorktree ? 'var(--overlay-subtle)' : 'var(--bg-terminal)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <div style={{
                width: 14, height: 14, borderRadius: 3,
                background: useWorktree ? 'var(--accent)' : 'transparent',
                border: useWorktree ? 'none' : '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {useWorktree && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5l2 2 4-4" stroke="var(--fg-on-accent)" strokeWidth="1.6" fill="none" />
                  </svg>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg)' }}>
                  Isolated worktree
                </div>
                <div style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.6, marginTop: 1 }}>
                  {useWorktree
                    ? `New branch off ${repoInfo.branch || 'HEAD'} in ~/.operator/worktrees`
                    : `Run directly in ${repoInfo.branch || 'this branch'} — shared with other agents`}
                </div>
              </div>
            </button>
          </div>
        )}

        {/* Fan-out: run the same task on N parallel agents (git repos only) */}
        {repoInfo?.isRepo && (
          <div style={{ marginBottom: 16 }}>
            <SegmentedControl
              label="Agents"
              options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))}
              value={String(count)}
              onChange={(v) => setCount(parseInt(v, 10))}
            />
            <p style={{ fontSize: 9, color: 'var(--fg-muted)', opacity: 0.5, margin: '4px 0 0' }}>
              {fanning
                ? `Run the same task on ${count} agents in parallel, each in its own worktree.`
                : 'Run a single session.'}
            </p>
          </div>
        )}

        {fanning && (
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Task for all agents</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should every agent work on? Each gets this as its first prompt."
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, fontFamily: "'Inter', system-ui, sans-serif" }}
            />
          </div>
        )}

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            background: 'none', border: 'none', color: 'var(--fg-muted)',
            fontSize: 10, fontFamily: 'inherit', cursor: 'pointer',
            opacity: 0.5, padding: 0, marginBottom: showAdvanced ? 12 : 20,
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <span style={{
            display: 'inline-block', fontSize: 8,
            transform: showAdvanced ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
          }}>&#9654;</span>
          Advanced
        </button>

        {showAdvanced && (
          <div style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Allowed Tools */}
            <div>
              <label style={labelStyle}>Allowed Tools</label>
              <input
                type="text"
                value={allowedTools}
                onChange={(e) => setAllowedTools(e.target.value)}
                placeholder='e.g. Bash(git:*) Edit Read'
                style={inputStyle}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={cancelBtnStyle}>
            Cancel
          </button>
          <button
            onClick={handleLaunch}
            disabled={fanning && !prompt.trim()}
            style={{ ...launchBtnStyle, opacity: fanning && !prompt.trim() ? 0.5 : 1, cursor: fanning && !prompt.trim() ? 'default' : 'pointer' }}
          >
            {fanning ? `Launch ${count} agents` : `Launch ${projectName}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function SegmentedControl({ label, options, value, onChange }: {
  label: string
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={labelStyle}>{label}</label>
      <div style={{
        display: 'flex', gap: 0, borderRadius: 6,
        border: '1px solid var(--border)', overflow: 'hidden',
      }}>
        {options.map((opt, i) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1, padding: '7px 0', fontSize: 11, fontWeight: 500,
              fontFamily: 'inherit', textTransform: 'capitalize',
              background: value === opt.value ? 'rgba(255,255,255,0.1)' : 'var(--bg-terminal)',
              color: value === opt.value ? 'var(--fg)' : 'var(--fg-muted)',
              border: 'none', cursor: 'pointer',
              borderRight: i < options.length - 1 ? '1px solid var(--border)' : 'none',
              transition: 'background 0.1s, color 0.1s',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 500, color: 'var(--fg-muted)',
  display: 'block', marginBottom: 6, textTransform: 'uppercase',
  letterSpacing: 0.3,
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px', fontSize: 11,
  fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
  background: 'var(--bg-terminal)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 5,
  outline: 'none', boxSizing: 'border-box',
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', fontSize: 11, fontWeight: 500,
  fontFamily: "'Inter', system-ui, sans-serif",
  background: 'var(--bg-terminal)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 6,
  outline: 'none', boxSizing: 'border-box', cursor: 'pointer',
}

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: '8px 0', background: 'var(--bg-terminal)',
  border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--fg-muted)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
}

const launchBtnStyle: React.CSSProperties = {
  flex: 2, padding: '8px 0', background: 'var(--btn-bg)',
  border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--fg)', fontSize: 12, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
}
