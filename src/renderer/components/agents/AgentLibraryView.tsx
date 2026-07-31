import { useEffect, useState, useCallback } from 'react'
import type { AgentDefinition, AgentScope } from '../../../shared/types'
import { pageTitle, pageSubtitle, fieldLabel, MEASURE_FORM, MEASURE_GRID } from '../settings/PageShell'
import { SplitPane } from '../SplitPane'

// Model choices surfaced as a dropdown — the headline of the whole view.
// Empty value = omit the field (inherit the parent session's model).
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Inherit from session' },
  { value: 'haiku', label: 'Haiku — fast & cheap' },
  { value: 'sonnet', label: 'Sonnet — balanced' },
  { value: 'opus', label: 'Opus — most capable' },
  { value: 'fable', label: 'Fable 5 — frontier' },
  { value: 'opusplan', label: 'Opus in plan, Sonnet in execution' },
  { value: 'default', label: 'Account default' },
]

// Sentinel `<select>` value (never a stored model) that swaps the dropdown for a free-typed
// id — see the Model field in Editor.
const CUSTOM_MODEL = '__custom'

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

// Per-model hint shown at the point of choosing — routing intelligence: what each
// model is FOR, so grunt work goes cheap and the expensive one is saved for where it
// pays off. Deliberately no $/Mtok figures here — they read as noise while picking a
// model, and Operator no longer reports spend anywhere (the Usage & cost view is gone).
const MODEL_HINT: Record<string, string> = {
  '': 'Runs on whatever model the session uses.',
  haiku: 'Cheapest & fastest — good for extraction, search, simple edits.',
  sonnet: 'Balanced — a good default for most coding.',
  opus: 'Most capable — reserve for hard reasoning & review.',
  fable: 'Frontier — only for the most demanding work.',
  opusplan: 'Opus while planning, Sonnet while executing.',
  default: 'Falls back to your account default model.',
}

// Common tools. Empty selection = inherit all tools from the parent.
const TOOL_OPTIONS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'Agent']

function emptyDraft(scope: AgentScope, projectPath?: string): AgentDefinition {
  return { name: '', description: '', model: '', tools: [], effort: '', prompt: '', scope, projectPath, path: '' }
}

function modelLabel(model?: string): string {
  if (!model) return 'inherit'
  return MODEL_OPTIONS.find((m) => m.value === model)?.label.split(' — ')[0].toLowerCase() || model
}

/** opus / sonnet / haiku for the `.op-badge` tier chip, '' otherwise (inherit/default). */
function modelTier(model?: string): string {
  const m = (model || '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return ''
}

export function AgentLibraryView({ embedded = false }: { embedded?: boolean } = {}) {
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<AgentDefinition | null>(null)
  const [originalPath, setOriginalPath] = useState<string>('')
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const list = await window.operator.agentsList(projectPath ?? undefined)
    setAgents(list)
  }, [projectPath])

  useEffect(() => { load() }, [load])

  const selectAgent = (agent: AgentDefinition) => {
    setSelected({ ...agent, tools: agent.tools ? [...agent.tools] : [] })
    setOriginalPath(agent.path)
    setDirty(false)
    setError(null)
  }

  const startNew = (scope: AgentScope) => {
    setSelected(emptyDraft(scope, scope === 'project' ? projectPath ?? undefined : undefined))
    setOriginalPath('')
    setDirty(false)
    setError(null)
  }

  const patch = (updates: Partial<AgentDefinition>) => {
    setSelected((prev) => (prev ? { ...prev, ...updates } : prev))
    setDirty(true)
    setError(null)
  }

  const toggleTool = (tool: string) => {
    setSelected((prev) => {
      if (!prev) return prev
      const set = new Set(prev.tools ?? [])
      if (set.has(tool)) set.delete(tool)
      else set.add(tool)
      return { ...prev, tools: Array.from(set) }
    })
    setDirty(true)
  }

  const pickProject = async () => {
    const folder = await window.operator.pickFolder()
    if (folder) setProjectPath(folder)
  }

  const handleSave = async () => {
    if (!selected) return
    if (selected.scope === 'project' && !selected.projectPath) {
      setError('Pick a project folder for a project-scoped agent.')
      return
    }
    const result = await window.operator.agentSave(selected, originalPath || undefined)
    if (!result.ok) {
      setError(result.error || 'Failed to save')
      return
    }
    setDirty(false)
    setOriginalPath(result.path || '')
    setSelected((prev) => (prev ? { ...prev, path: result.path || prev.path } : prev))
    await load()
  }

  const handleDelete = async () => {
    if (!selected || !selected.path) { setSelected(null); return }
    const result = await window.operator.agentDelete(selected.path)
    if (!result.ok) { setError(result.error || 'Failed to delete'); return }
    setSelected(null)
    await load()
  }

  const userAgents = agents.filter((a) => a.scope === 'user')
  const projectAgents = agents.filter((a) => a.scope === 'project')

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', fontFamily: "var(--font-body)", overflow: 'hidden' }}>
      {/* Standalone header. It wears PageShell's TOKENS rather than PageShell itself: the
          shell's body is a single scroller with a measure box, and this page's body is a
          two-pane list+editor where each column scrolls on its own — wrapping that in the
          shell's scroller would break the panes and re-inset their scrollbars. Same type,
          same measure, same data-attrs the theme pass probes. Suppressed when embedded in
          the Agents hub, which supplies the real PageShell header + tabs. */}
      {!embedded && (
        <div style={{ padding: '16px 24px 12px', flexShrink: 0, borderBottom: '1px solid var(--border)', maxWidth: MEASURE_GRID, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
          <h2 data-page-title style={pageTitle}>Agents</h2>
          <p data-page-subtitle style={{ ...pageSubtitle }}>
            Define subagents and pick which model handles each kind of task. Saved as{' '}
            <code style={{ background: 'var(--bg-surface)', padding: '0 4px', borderRadius: 3 }}>.claude/agents/*.md</code>{' '}
            — Claude Code delegates to them by their description.
          </p>
        </div>
      )}

      {/* The house list-and-detail split, extracted to `SplitPane` — the same two independent
          scrollers this view has always had, now shared. Full width, NOT capped at 1100: a capped
          ancestor parks both scrollbars at its edge instead of the window's. */}
      <SplitPane
        index={(
          <>
          <ListGroup
            title="User"
            sub="~/.claude/agents"
            agents={userAgents}
            selectedPath={selected?.path}
            onSelect={selectAgent}
            onAdd={() => startNew('user')}
          />

          <div style={{ marginTop: 16 }}>
            <ListGroup
              title="Project"
              sub={projectPath ? projectPath.split('/').filter(Boolean).pop() : undefined}
              agents={projectAgents}
              selectedPath={selected?.path}
              onSelect={selectAgent}
              onAdd={projectPath ? () => startNew('project') : undefined}
            />
            {!projectPath ? (
              <button onClick={pickProject} style={linkBtn}>+ Add project folder…</button>
            ) : (
              <button onClick={() => setProjectPath(null)} style={linkBtn}>Clear project</button>
            )}
          </div>
          </>
        )}
        detail={selected ? (
            <Editor
              agent={selected}
              isNew={!originalPath}
              dirty={dirty}
              error={error}
              onPatch={patch}
              onToggleTool={toggleTool}
              onPickProject={pickProject}
              onSave={handleSave}
              onDelete={handleDelete}
              onCancel={() => { setSelected(null); setError(null) }}
            />
        ) : undefined}
        empty={(
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', textAlign: 'center', lineHeight: 1.7 }}>
            Select an agent to edit, or create one.<br />Each agent can run on its own model.
          </p>
        )}
      />
    </div>
  )
}

function ListGroup({ title, sub, agents, selectedPath, onSelect, onAdd }: {
  title: string
  sub?: string
  agents: AgentDefinition[]
  selectedPath?: string
  onSelect: (a: AgentDefinition) => void
  onAdd?: () => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px 6px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--fg-muted)', }}>
          {title}{sub ? ` · ${sub}` : ''}
        </span>
        {onAdd && (
          <button onClick={onAdd} title={`New ${title.toLowerCase()} agent`} style={{
            background: 'none', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer',
            fontSize: 15, lineHeight: 1, padding: 0, 
          }}>+</button>
        )}
      </div>
      {agents.length === 0 && (
        <p style={{ fontSize: 10, color: 'var(--fg-muted)', padding: '2px 6px 0' }}>None yet</p>
      )}
      {agents.map((a) => {
        const active = a.path && a.path === selectedPath
        return (
          <button
            key={a.path || a.name}
            onClick={() => onSelect(a)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 8px', marginBottom: 2, borderRadius: 5,
              background: active ? 'var(--overlay-subtle)' : 'transparent',
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {a.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <span className={`op-badge${modelTier(a.model) ? ' ' + modelTier(a.model) : ''}`}>
                {modelLabel(a.model)}
              </span>
              <span style={{ fontSize: 10, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {a.description || 'No description'}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function Editor({ agent, isNew, dirty, error, onPatch, onToggleTool, onPickProject, onSave, onDelete, onCancel }: {
  agent: AgentDefinition
  isNew: boolean
  dirty: boolean
  error: string | null
  onPatch: (u: Partial<AgentDefinition>) => void
  onToggleTool: (t: string) => void
  onPickProject: () => void
  onSave: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const tools = new Set(agent.tools ?? [])
  // Escape hatch for a model tier Claude Code's CLI accepts before Operator ships a preset
  // for it: "Other…" swaps the dropdown for a free-typed id. An agent already saved with a
  // non-preset model opens in this mode too, so editing one can't silently rewrite its model
  // back to a preset. (The listed tiers never need this — Claude Code resolves opus/sonnet/…
  // to the current point release itself.)
  const [customOpen, setCustomOpen] = useState(false)
  const customModel = customOpen || !MODEL_OPTIONS.some((m) => m.value === (agent.model || ''))
  // Reset only when a DIFFERENT agent loads (path = file identity) — keying on name/model
  // would collapse the input while the user is typing into it.
  useEffect(() => { setCustomOpen(false) }, [agent.path])

  return (
    <div style={{ padding: '18px 24px', maxWidth: MEASURE_FORM }}>
      <Field label="Name" hint="Lowercase identifier, e.g. code-reviewer. Sets the filename.">
        <input
          value={agent.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="code-reviewer"
          style={textInput}
        />
      </Field>

      <Field label="Description" hint="When should Claude delegate to this agent? This is the only signal it uses to pick.">
        <textarea
          value={agent.description}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder="Use to review code changes for bugs and style after edits."
          rows={2}
          style={{ ...textInput, resize: 'vertical', lineHeight: 1.5 }}
        />
      </Field>

      <Field
        label="Model"
        hint={customModel
          ? 'Any model id or alias your Claude Code CLI accepts — for a tier with no preset here yet.'
          : MODEL_HINT[agent.model || ''] ?? 'Which model runs this agent — the headline of its config.'}
      >
        <select
          value={customModel ? CUSTOM_MODEL : (agent.model || '')}
          onChange={(e) => {
            // Picking "Other…" only reveals the input — it keeps whatever id is set, so the
            // field is pre-filled to edit rather than blanked.
            if (e.target.value === CUSTOM_MODEL) { setCustomOpen(true); return }
            setCustomOpen(false)
            onPatch({ model: e.target.value })
          }}
          style={{ ...textInput, cursor: 'pointer' }}
        >
          {MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          <option value={CUSTOM_MODEL}>Other — type a model id…</option>
        </select>
        {customModel && (
          <input
            value={agent.model || ''}
            onChange={(e) => onPatch({ model: e.target.value })}
            placeholder="Exactly as you'd type it after /model"
            style={{ ...textInput, marginTop: 6, fontFamily: 'var(--font-mono)' }}
          />
        )}
      </Field>

      <div style={{ display: 'flex', gap: 12 }}>
        <Field label="Effort" hint="Reasoning effort." style={{ flex: 1, minWidth: 0 }}>
          <select value={agent.effort || ''} onChange={(e) => onPatch({ effort: e.target.value })} style={{ ...textInput, cursor: 'pointer' }}>
            {EFFORT_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Max turns" hint="Optional cap." style={{ width: 120, flexShrink: 0 }}>
          <input
            type="number"
            min={1}
            value={agent.maxTurns ?? ''}
            onChange={(e) => onPatch({ maxTurns: e.target.value ? parseInt(e.target.value, 10) : undefined })}
            placeholder="—"
            style={textInput}
          />
        </Field>
      </div>

      <Field label="Tools" hint="Leave all unchecked to inherit every tool from the parent session.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TOOL_OPTIONS.map((tool) => {
            const on = tools.has(tool)
            return (
              <button
                key={tool}
                onClick={() => onToggleTool(tool)}
                style={{
                  padding: '3px 10px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
                  borderRadius: 5, border: '1px solid var(--border)',
                  background: on ? 'var(--btn-bg)' : 'transparent',
                  color: on ? 'var(--fg)' : 'var(--fg-muted)',
                  
                }}
              >
                {tool}
              </button>
            )
          })}
        </div>
      </Field>

      <Field label="System prompt" hint="The agent's instructions — becomes the file body.">
        <textarea
          value={agent.prompt}
          onChange={(e) => onPatch({ prompt: e.target.value })}
          placeholder="You are a focused code reviewer. When invoked..."
          rows={10}
          style={{ ...textInput, resize: 'vertical', lineHeight: 1.6, fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace", fontSize: 12 }}
        />
      </Field>

      {agent.scope === 'project' && (
        <Field label="Project" hint="Where this project agent is saved.">
          <button onClick={onPickProject} style={{ ...textInput, cursor: 'pointer', textAlign: 'left', color: agent.projectPath ? 'var(--fg)' : 'var(--fg-muted)' }}>
            {agent.projectPath || 'Pick a project folder…'}
          </button>
        </Field>
      )}

      {error && <p style={{ fontSize: 11, color: 'var(--color-error)', margin: '0 0 12px' }}>{error}</p>}

      {/* Action bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button
          onClick={onSave}
          disabled={!dirty && !isNew}
          style={{
            padding: '6px 16px', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
            background: 'var(--btn-bg)', color: 'var(--fg)', border: '1px solid var(--border)',
            borderRadius: 6, cursor: (!dirty && !isNew) ? 'default' : 'pointer',
            opacity: (!dirty && !isNew) ? 0.5 : 1,
          }}
        >
          {isNew ? 'Create agent' : 'Save'}
        </button>
        <button onClick={onCancel} style={{
          padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', background: 'transparent',
          color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
        }}>
          {dirty ? 'Discard' : 'Close'}
        </button>
        <div style={{ flex: 1 }} />
        {!isNew && (
          <button onClick={onDelete} style={{
            padding: '6px 12px', fontSize: 11, fontFamily: 'inherit', background: 'transparent',
            color: 'var(--color-error)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', opacity: 0.8,
          }}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

function Field({ label, hint, children, style }: { label: string; hint?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ marginBottom: 16, ...style }}>
      {/* The shared token, not a local 11/600 restatement — a second field-label style is the
          exact drift PageShell exists to end, and it lived one layer below the page chrome. */}
      <label style={{ display: 'block', ...fieldLabel, marginBottom: 2 }}>{label}</label>
      {/* No opacity over --fg-muted: at 0.6 this hint measured 2.16–3.46:1, under even the
          3:1 meta floor on five of six palettes. */}
      {hint && <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: '0 0 6px', lineHeight: 1.4 }}>{hint}</p>}
      {children}
    </div>
  )
}

const textInput: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: "var(--font-body)",
  background: 'var(--bg-terminal)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  outline: 'none',
  boxSizing: 'border-box',
}

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
  padding: '6px 6px 0',
  opacity: 0.7,
}
