import { useState } from 'react'
import type { Project, Role } from '../../../shared/types'
import { ROSTER_MODELS, rolePresets } from '../../lib/roster'
import { laneTextColor } from '../../lib/lane-color'
import {
  pinnedFieldCounts, type GlobalRoleDefaults,
} from '../../lib/model-config'
import { fieldLabel, sectionDesc } from '../settings/PageShell'

// AGENTS → DEFAULTS. The global roster template, made editable.
//
// The user story, verbatim: "I want from now on, Operator to use Opus instead of Fable. I should be
// able to config once." So the single most obvious action on this tab is changing one lane's model,
// and it applies to every project — present and future.
//
// It lives HERE, not in Preferences, because of the second half of the framing: "when I open
// Operator, even before choosing a project, I could set up the agents config, so they launch
// accordingly with each project." The rail persists at the gallery, the rail opens Agents, so this
// is reachable before any project is scoped. It is not a preference you hunt for; it is a thing you
// go and do.
//
// IT IS NOT A COST DISPLAY. No $/Mtok, no projected spend, not even in a tooltip. Economy here is
// controlled AS CONFIG — a number that can only ever be an estimate invites arguing with it instead
// of choosing. Capability language only: what each tier is FOR.

/** What each model is for, in the vocabulary the presets already use. Ordered by capability so the
 *  tier reads off the control itself, matching ROSTER_MODELS' own order. */
const MODEL_FOR: Record<string, string> = {
  fable: 'fast coordination',
  opus: 'hardest work',
  sonnet: 'breadth, volume',
  haiku: 'quick, cheap turns',
}

const EFFORTS = [
  { id: 'low' as const, label: 'Low', for: 'shallow, quick' },
  { id: 'normal' as const, label: 'Normal', for: 'everyday' },
  { id: 'high' as const, label: 'High', for: 'think it through' },
]

const CONTROL_OFF = 'var(--fg-muted)'

export function AgentDefaultsView({ defaults, onPatch, projects, onResetPinned }: {
  defaults: GlobalRoleDefaults
  onPatch: (roleId: string, patch: GlobalRoleDefaults[string]) => void
  /** Only for the counts in the reset action's copy — this tab never edits a project. */
  projects: Project[]
  /** Clear every per-lane pin across every project, so these defaults win. Confirmed, counted,
   *  and undoable from the backup it takes first. */
  onResetPinned: () => void
}) {
  const presets = rolePresets()
  const [confirming, setConfirming] = useState(false)
  const pinned = pinnedFieldCounts(projects)

  return (
    <>
      <p style={{ ...sectionDesc, marginTop: 0, marginBottom: 18 }}>
        Every project's lanes launch with these. Match the model to what the lane actually does —
        a lane that only reads doesn't need the model that writes.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {presets.map((preset) => (
          <RoleDefaultRow
            key={preset.id}
            preset={preset}
            value={defaults[preset.id] ?? {}}
            onPatch={(patch) => onPatch(preset.id, patch)}
          />
        ))}
      </div>

      {/* The harder case: lanes that were PINNED per project, which beat everything above. Without
          this there is no way to make these defaults win short of editing 19 rosters by hand. */}
      <div style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <h3 style={{ ...fieldLabel, margin: '0 0 6px' }}>Lanes that ignore these defaults</h3>
        {pinned.fields === 0 ? (
          <p style={{ ...sectionDesc, margin: 0 }}>
            None — every lane in every project inherits from this tab.
          </p>
        ) : (
          <>
            <p style={{ ...sectionDesc, margin: '0 0 10px' }}>
              {pinned.fields} setting{pinned.fields === 1 ? '' : 's'} {pinned.fields === 1 ? 'is' : 'are'} pinned
              on {pinned.lanes} lane{pinned.lanes === 1 ? '' : 's'} across {pinned.projects} project
              {pinned.projects === 1 ? '' : 's'}. A pinned lane keeps its own model and effort whatever
              you set here. You can clear one at a time from its card on a project's roster, or all of
              them at once.
            </p>
            {confirming ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--fg)' }}>
                  Clear {pinned.fields} pinned setting{pinned.fields === 1 ? '' : 's'} on {pinned.lanes} lane
                  {pinned.lanes === 1 ? '' : 's'} across {pinned.projects} project{pinned.projects === 1 ? '' : 's'}?
                </span>
                <button
                  data-defaults-reset-confirm
                  onClick={() => { onResetPinned(); setConfirming(false) }}
                  className="actions-footer-btn"
                  style={{ fontSize: 11, padding: '3px 12px' }}
                >Clear them</button>
                <button
                  onClick={() => setConfirming(false)}
                  style={{
                    background: 'transparent', border: 'none', color: 'var(--fg-muted)',
                    cursor: 'pointer', outline: 'none', fontSize: 11, padding: '3px 8px',
                  }}
                >Cancel</button>
              </div>
            ) : (
              <button
                data-defaults-reset
                onClick={() => setConfirming(true)}
                className="actions-footer-btn"
                style={{ fontSize: 11, padding: '3px 12px' }}
                title="Clears the per-lane model and effort pins in every project so these defaults apply. projects.json is backed up first."
              >Reset all lanes to inherit</button>
            )}
          </>
        )}
      </div>
    </>
  )
}

/** One role's row: name, model, effort, worktree. Model and effort carry EQUAL weight — effort is
 *  the other spend dial and the one users forget, so it is never tucked behind a disclosure. */
function RoleDefaultRow({ preset, value, onPatch }: {
  preset: Role
  value: GlobalRoleDefaults[string]
  onPatch: (patch: GlobalRoleDefaults[string]) => void
}) {
  const accent = preset.accent
  // Presets always define both; the fallbacks are for a custom lane added later.
  const model = value.model ?? preset.model ?? 'sonnet'
  const effort = value.effort ?? preset.effort ?? 'high'
  const worktree = value.useWorktree ?? false

  return (
    <div
      data-default-row={preset.id}
      style={{
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        padding: '10px 12px', borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)', background: 'var(--overlay-subtle)',
      }}
    >
      {/* Identity: a dot and the lane name in its accent, exactly as the roster board draws it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: 108, flexShrink: 0 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: accent ?? 'var(--fg-muted)',
        }} />
        <span data-default-name style={{
          fontSize: 12, fontWeight: 600,
          color: accent ? laneTextColor(accent) : 'var(--fg)',
        }}>
          {preset.name}
        </span>
      </div>

      <Picker
        label="model"
        options={ROSTER_MODELS.map((m) => ({ id: m.id, label: m.label, hint: MODEL_FOR[m.id] }))}
        value={model}
        preset={preset.model ?? 'sonnet'}
        accent={accent}
        onChange={(id) => onPatch({ model: id })}
        onClear={() => onPatch({ model: undefined })}
      />
      <Picker
        label="effort"
        options={EFFORTS.map((e) => ({ id: e.id as string, label: e.label, hint: e.for }))}
        value={effort}
        preset={preset.effort ?? 'high'}
        accent={accent}
        onChange={(id) => onPatch({ effort: id as Role['effort'] })}
        onClear={() => onPatch({ effort: undefined })}
      />

      {/* Worktree is a plain boolean HERE — a global either isolates this lane or doesn't. The
          tri-state lives on the lane itself, where "off" has to be able to beat this. */}
      <button
        data-default-worktree={preset.id}
        onClick={() => onPatch({ useWorktree: !worktree })}
        aria-pressed={worktree}
        title={worktree
          ? `Every ${preset.name} lane launches in its own git worktree — an attributable diff, mergeable back.`
          : `${preset.name} lanes launch in the project root, sharing it with the other lanes.`}
        style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '2px 7px', borderRadius: 5, border: 'none',
          background: worktree && accent ? `color-mix(in srgb, ${accent} 12%, transparent)` : 'transparent',
          color: worktree && accent ? laneTextColor(accent) : CONTROL_OFF,
          cursor: 'pointer', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 9.5,
        }}
      >
        <span style={{
          width: 9, height: 9, borderRadius: 2, flexShrink: 0,
          border: `1px solid ${worktree ? 'transparent' : 'var(--fg-muted)'}`,
          background: worktree ? (accent ?? 'var(--fg-muted)') : 'transparent',
        }} />
        worktree
      </button>
    </div>
  )
}

/** A labelled option row. The lit value is the answer; muted ink means it is still the built-in
 *  preset, accent means you chose it. Clicking your own choice again clears it back to the preset —
 *  the same route home the roster cards use, so the gesture is learned once. */
function Picker({ label, options, value, preset, accent, onChange, onClear }: {
  label: string
  options: Array<{ id: string; label: string; hint?: string }>
  value: string
  preset: string
  accent?: string
  onChange: (id: string) => void
  onClear: () => void
}) {
  const tint = accent ? laneTextColor(accent) : 'var(--accent)'
  const chosen = value !== preset || options.every((o) => o.id !== preset)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: 'var(--fg-muted)',
      }}>{label}</span>
      <div style={{ display: 'inline-flex', gap: 1, flexWrap: 'wrap' }}>
        {options.map((o) => {
          const active = o.id === value
          return (
            <button
              key={o.id}
              data-default-option={`${label}:${o.id}`}
              data-default-state={active ? (chosen ? 'chosen' : 'preset') : 'off'}
              onClick={() => { if (!active) onChange(o.id); else if (chosen) onClear() }}
              title={!active
                ? `${o.label} — ${o.hint ?? ''}`.trim()
                : chosen
                  ? `${o.label} — your default. Click to go back to the built-in (${preset}).`
                  : `${o.label} — the built-in default${o.hint ? ` (${o.hint})` : ''}.`}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.03em',
                padding: '2px 7px', borderRadius: 5, cursor: 'pointer', outline: 'none', border: 'none',
                color: active && chosen ? tint : active ? 'var(--fg)' : CONTROL_OFF,
                background: active && chosen ? `color-mix(in srgb, ${accent ?? 'var(--accent)'} 12%, transparent)` : 'transparent',
              }}
            >{o.label}</button>
          )
        })}
      </div>
    </div>
  )
}
