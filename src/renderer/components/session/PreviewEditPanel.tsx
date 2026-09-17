import { useEffect, useRef, useState } from 'react'
import {
  diffChanges, composeEditMessage, matchToken, colorInputValue, stepValue, EDIT_PROPS,
  type EditState,
} from '../../../shared/preview-edit'
import type { EditCommand } from '../../lib/use-preview-edit'
import { CONTROL_OFF_INK } from '../../lib/preview-toolbar'

// CSS CONTROLS (v1) for the element picked in Inspect. Under the stage, never over it: nothing
// Operator draws may overlap the page. Every change goes to the page as a command and comes back as
// state, so the fields always show what the page has.

type Active = NonNullable<EditState['active']>

const SIDES = [['top', 'T'], ['right', 'R'], ['bottom', 'B'], ['left', 'L']] as const
const COLOURS = [['background-color', 'Background'], ['color', 'Text'], ['border-color', 'Border']] as const

export function PreviewEditPanel({ state, send, onCapture, onDispatch, onSendToTasks }: {
  state: EditState
  send: (cmd: EditCommand, extra?: Record<string, unknown>) => void
  /** Capture a crop of the element's current box; resolves to the stored path. */
  onCapture: (active: Active, id: string) => Promise<string | null>
  onDispatch?: (text: string, images?: string[]) => void
  onSendToTasks?: (text: string) => void
}) {
  const a = state.active!
  const shown = (prop: string) => a.values[prop] ?? a.current?.[prop] ?? ''
  const set = (prop: string, value: string) => send('set', { uid: a.uid, prop, value })
  const changes = diffChanges(a.before, a.values, a.current ?? {}, state.tokens)
  const [sending, setSending] = useState(false)

  // THE BEFORE SHOT, once per element, the first time it is selected with nothing changed yet.
  const beforeShots = useRef(new Map<string, Promise<string | null>>())
  useEffect(() => {
    if (beforeShots.current.has(a.uid) || Object.keys(a.values).length) return
    beforeShots.current.set(a.uid, onCapture(a, `pick-edit-${a.uid}-before`))
  }, [a.uid]) // eslint-disable-line react-hooks/exhaustive-deps

  const sendTo = async (target: 'console' | 'tasks') => {
    if (!changes.length || sending) return
    setSending(true)
    try {
      const before = await (beforeShots.current.get(a.uid) ?? Promise.resolve(null))
      const after = await onCapture(a, `pick-edit-${a.uid}-after`)
      const text = composeEditMessage({
        label: a.label, component: a.component, source: a.source, selector: a.selector, route: a.route,
        scope: 'element', changes,
      }, { before, after })
      const images = [before, after].filter((p): p is string => !!p)
      if (target === 'console') onDispatch?.(text, images); else onSendToTasks?.(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <div data-no-drag data-edit-panel style={{
      flexShrink: 0, maxHeight: '45%', overflowY: 'auto', boxSizing: 'border-box',
      borderTop: '1px solid var(--border)', background: 'var(--bg-surface)', padding: '8px 12px 10px',
      fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--fg)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8, rowGap: 4, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{a.component || a.label}</span>
        <span title={a.selector} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
          {a.source ?? a.selector}
        </span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
          {changes.length === 1 ? '1 change' : `${changes.length} changes`}
          {state.count > 1 ? ` · ${state.count} elements edited` : ''}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <Btn label="Undo" title="Undo the last change to this element" disabled={!a.history} onClick={() => send('undo', { uid: a.uid })} />
          <Btn label="Reset" title="Remove every change to this element" disabled={!Object.keys(a.values).length} onClick={() => send('reset', { uid: a.uid })} />
          <Btn label="Reset all" title="Remove every change on this page" disabled={!state.count} onClick={() => send('resetAll')} />
          {onDispatch && <Btn label={sending ? 'Sending…' : '→ Console'} title="Send the changes to the lane now" accent disabled={!changes.length || sending} onClick={() => { void sendTo('console') }} />}
          {onSendToTasks && <Btn label="→ Tasks" title="Add the changes as a task" accent disabled={!changes.length || sending} onClick={() => { void sendTo('tasks') }} />}
          <Btn label="Close" title="Stop editing this element (changes stay on the page)" onClick={() => send('deselect')} />
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 18, rowGap: 8 }}>
        {(['margin', 'padding'] as const).map((box) => (
          <Group key={box} title={box === 'margin' ? 'Margin' : 'Padding'}>
            {SIDES.map(([side, short]) => {
              const prop = `${box}-${side}`
              return <Field key={prop} label={short} title={prop} value={shown(prop)} changed={a.values[prop] != null} min={box === 'padding' ? 0 : undefined} onCommit={(v) => set(prop, v)} />
            })}
          </Group>
        ))}
        <Group title="Size">
          <Field label="W" title="width" value={shown('width')} changed={a.values.width != null} min={0} wide onCommit={(v) => set('width', v)} />
          <Field label="H" title="height" value={shown('height')} changed={a.values.height != null} min={0} wide onCommit={(v) => set('height', v)} />
        </Group>
        <Group title="Shape">
          <Field label="Radius" title="border-radius" value={shown('border-radius')} changed={a.values['border-radius'] != null} min={0} wide onCommit={(v) => set('border-radius', v)} />
          <label title="opacity" style={{ display: 'flex', alignItems: 'center', gap: 5, color: a.values.opacity != null ? 'var(--accent)' : CONTROL_OFF_INK }}>
            Opacity
            <input
              type="range" min={0} max={1} step={0.01}
              value={Number(shown('opacity')) || 0}
              onChange={(e) => set('opacity', e.currentTarget.value)}
              style={{ width: 80, accentColor: 'var(--accent)' }}
            />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg)', width: 28 }}>{Number(shown('opacity') || 0).toFixed(2)}</span>
          </label>
        </Group>
        <Group title="Colour">
          {COLOURS.map(([prop, name]) => (
            <ColourField
              key={prop} prop={prop} name={name}
              value={shown(prop)} changed={a.values[prop] != null}
              token={matchToken(shown(prop), state.tokens)}
              tokens={state.tokens}
              onCommit={(v) => set(prop, v)}
            />
          ))}
        </Group>
      </div>
      {!a.source && (
        <p style={{ margin: '8px 0 0', fontSize: 10, color: 'var(--fg-muted)' }}>
          No source location for this element (not a React dev build, or React 19 with no file in its debug stack). The note will name its selector.
        </p>
      )}
    </div>
  )
}

/** Exported for the panel's own test of which props are editable. */
export const PANEL_PROPS = EDIT_PROPS

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      <span style={{ fontSize: 10, color: 'var(--fg-muted)', width: 48, flexShrink: 0 }}>{title}</span>
      {children}
    </div>
  )
}

/** A CSS value: type it, or ↑/↓ to step by 1 (⇧ by 10). Enter or blur commits, Esc reverts. */
function Field({ label, title, value, changed, onCommit, min, wide }: {
  label: string; title: string; value: string; changed: boolean; onCommit: (v: string) => void; min?: number; wide?: boolean
}) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(value) }, [value, focused])
  return (
    <label title={title} style={{ display: 'flex', alignItems: 'center', gap: 3, color: changed ? 'var(--accent)' : CONTROL_OFF_INK, fontSize: 10.5 }}>
      {label}
      <input
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { setFocused(false); if (e.currentTarget.value.trim() !== value) onCommit(e.currentTarget.value.trim()) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const next = stepValue(text, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1), min)
            setText(next); onCommit(next)
          } else if (e.key === 'Enter') { onCommit(e.currentTarget.value.trim()) }
          else if (e.key === 'Escape') { setText(value); e.currentTarget.blur() }
        }}
        style={{
          width: wide ? 64 : 44, boxSizing: 'border-box', padding: '2px 5px',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
          color: 'var(--fg)', background: 'var(--overlay-subtle)', border: '1px solid transparent', borderRadius: 4, outline: 'none',
        }}
      />
    </label>
  )
}

/** A colour: the native picker, the value, and the page's tokens. A value that matches a token is
 *  shown by the token's name. */
function ColourField({ prop, name, value, changed, token, tokens, onCommit }: {
  prop: string; name: string; value: string; changed: boolean; token: string | null
  tokens: ReadonlyArray<{ name: string; value: string }>; onCommit: (v: string) => void
}) {
  return (
    <span title={prop} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: changed ? 'var(--accent)' : CONTROL_OFF_INK }}>
      {name}
      <input
        type="color"
        value={colorInputValue(value)}
        onChange={(e) => onCommit(e.currentTarget.value)}
        style={{ width: 20, height: 18, padding: 0, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent' }}
      />
      <select
        value={token ?? ''}
        onChange={(e) => { if (e.currentTarget.value) onCommit(`var(${e.currentTarget.value})`) }}
        title={token ? `${token} · ${value}` : value}
        style={{
          maxWidth: 130, fontFamily: 'var(--font-mono)', fontSize: 10, color: token ? 'var(--fg)' : 'var(--fg-muted)',
          background: 'var(--overlay-subtle)', border: '1px solid transparent', borderRadius: 4, outline: 'none', padding: '1px 3px',
        }}
      >
        <option value="">{token ? token : value || 'token…'}</option>
        {tokens.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
      </select>
    </span>
  )
}

function Btn({ label, title, onClick, disabled, accent }: { label: string; title: string; onClick: () => void; disabled?: boolean; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        border: 'none', background: 'transparent', outline: 'none', borderRadius: 5, padding: '3px 7px',
        fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'color-mix(in srgb, var(--fg-muted) 65%, var(--bg-surface))' : accent ? 'var(--accent)' : CONTROL_OFF_INK,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--overlay-subtle)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >{label}</button>
  )
}
