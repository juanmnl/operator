import { useEffect, useState, useCallback } from 'react'
import type { Rule, RuleAction } from '../../../shared/types'

export function RulesView() {
  const [rules, setRules] = useState<Rule[]>([])
  const [newTool, setNewTool] = useState('Bash')
  const [newPattern, setNewPattern] = useState('')
  const [newAction, setNewAction] = useState<RuleAction>('approve')
  const [newScope, setNewScope] = useState('')

  const load = useCallback(async () => {
    const list = await window.operator.rulesList()
    setRules(list)
  }, [])

  useEffect(() => { load() }, [load])

  const handleAdd = async () => {
    if (!newTool.trim()) return
    await window.operator.rulesAdd({
      tool: newTool.trim(),
      pattern: newPattern.trim() || undefined,
      scope: newScope.trim() || undefined,
      action: newAction,
    })
    setNewTool('Bash')
    setNewPattern('')
    setNewAction('approve')
    setNewScope('')
    load()
  }

  const pickScope = async () => {
    const folder = await window.operator.pickFolder()
    if (folder) setNewScope(folder)
  }

  const scopeLabel = (path?: string) =>
    path ? path.split('/').filter(Boolean).pop() || path : 'All projects'

  const handleRemove = async (id: string) => {
    await window.operator.rulesRemove(id)
    load()
  }

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', margin: 0 }}>
          Auto-approve rules
        </h2>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '4px 0 0', opacity: 0.7, lineHeight: 1.6 }}>
          Match incoming tool requests and skip the permission prompt.
          Use <code style={{ background: 'var(--bg-surface)', padding: '0 4px', borderRadius: 3 }}>*</code> as a wildcard. Rules are evaluated in order.
        </p>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        {/* Add form */}
        <div style={{
          display: 'flex', gap: 6, marginBottom: 20,
          padding: '10px', background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <input
            type="text"
            value={newTool}
            onChange={(e) => setNewTool(e.target.value)}
            placeholder="Tool"
            style={inputStyle(110)}
          />
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="Pattern (optional, e.g. git *)"
            style={{ ...inputStyle(), flex: 1 }}
          />
          <select
            value={newAction}
            onChange={(e) => setNewAction(e.target.value as RuleAction)}
            style={{
              ...inputStyle(100),
              cursor: 'pointer',
            }}
          >
            <option value="approve">Allow</option>
            <option value="deny">Deny</option>
          </select>
          <button
            onClick={pickScope}
            title={newScope ? `Scoped to ${newScope} — click to change` : 'Applies to all projects — click to scope to one'}
            style={{
              padding: '4px 10px', fontSize: 11, fontFamily: 'inherit',
              maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              background: newScope ? 'var(--btn-bg)' : 'transparent',
              color: newScope ? 'var(--fg)' : 'var(--fg-muted)',
              border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer',
            }}
          >
            {newScope ? scopeLabel(newScope) : 'All projects'}
          </button>
          {newScope && (
            <button
              onClick={() => setNewScope('')}
              title="Clear scope (apply globally)"
              style={{
                background: 'none', border: 'none', color: 'var(--fg-muted)',
                cursor: 'pointer', fontSize: 14, padding: '0 2px', opacity: 0.6, fontFamily: 'inherit',
              }}
            >
              ×
            </button>
          )}
          <button
            onClick={handleAdd}
            style={{
              padding: '4px 14px', fontSize: 11, fontWeight: 500,
              background: 'var(--btn-bg)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 5,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Add
          </button>
        </div>

        {/* List */}
        {rules.length === 0 && (
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', opacity: 0.6, textAlign: 'center', padding: '40px 0' }}>
            No rules yet. Approve a request and click <em>Always</em> to add one automatically.
          </p>
        )}
        <div style={{
          background: 'var(--bg-surface)',
          border: rules.length > 0 ? '1px solid var(--border)' : 'none',
          borderRadius: 6,
          overflow: 'hidden',
        }}>
          {rules.map((rule, i) => (
            <div
              key={rule.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px',
                borderBottom: i < rules.length - 1 ? '1px solid var(--border)' : 'none',
                fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
                fontSize: 12,
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: rule.action === 'approve' ? 'var(--color-success)' : 'var(--color-error)',
                flexShrink: 0,
              }} />
              <span style={{ color: 'var(--fg)', fontWeight: 500, minWidth: 80 }}>
                {rule.tool}
              </span>
              <span style={{ color: 'var(--fg-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {rule.pattern || <em style={{ opacity: 0.5 }}>(any)</em>}
              </span>
              <span
                title={rule.scope || 'Applies to all projects'}
                style={{
                  fontSize: 10, color: 'var(--fg-muted)',
                  background: 'var(--overlay-subtle)', padding: '1px 6px', borderRadius: 4,
                  maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  opacity: rule.scope ? 0.9 : 0.45, flexShrink: 0,
                }}
              >
                {scopeLabel(rule.scope)}
              </span>
              <span style={{ fontSize: 10, color: 'var(--fg-muted)', opacity: 0.5 }}>
                {rule.action}
              </span>
              <button
                onClick={() => handleRemove(rule.id)}
                style={{
                  background: 'none', border: 'none', color: 'var(--fg-muted)',
                  cursor: 'pointer', fontSize: 14, padding: '0 4px',
                  opacity: 0.5, fontFamily: 'inherit',
                }}
                title="Remove rule"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function inputStyle(width?: number): React.CSSProperties {
  return {
    width,
    padding: '4px 10px',
    fontSize: 11,
    fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
    background: 'var(--bg-terminal)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    outline: 'none',
    boxSizing: 'border-box',
  }
}
