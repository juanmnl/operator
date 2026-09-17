import { useState } from 'react'
import type { EnvEntry, Project, SettingsFile } from '../../../shared/types'
import type { FolderPrefsTab } from './FolderPreferencesView'
import { sectionHeader, sectionDesc } from '../settings/PageShell'
import { denyReason, validateEnvName } from '../../lib/env-policy'
import { tildePath } from '../../lib/format'

// S2 of `dev/results/session-settings-design.md` — the project's environment block.
//
// WHICH FILE THIS WRITES, and why it matters: `projects.json`, Operator's own store — NOT the
// repo's `.claude/settings.json`, which already has a writer one tab to the left. One writer per
// file. The repo's own `env` (if it has one) is shown here as an inherited layer and is never
// edited from this page.
//
// Config tier only. No secrets — that is S7, deliberately last, because it is the only step that
// can leak and it should land on machinery that is already proven.

interface EnvironmentSectionProps {
  project: Project | null
  onPatch: (patch: Partial<Project>) => void
  /** The repo's own settings files, read for the inherited block. Never written here. */
  settingsFiles: SettingsFile[]
  /** Every project in the store, for the global view's doorway. Optional, and absent on a
   *  project's own page — where `project` is set and this list is never read. */
  projects?: Project[]
  /** Opens a project's settings on a tab. The doorway's rows pass `Environment`. */
  onOpenFolderPrefs?: (projectPath: string, projectName: string, tab?: FolderPrefsTab) => void
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '7px 10px', borderBottom: '1px solid var(--border)',
}

/** Fixed width, and it never shrinks: a `file://`-length value must not push the ✕ off the row. */
const ACTIONS_W = 26

const nameStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)',
  flex: '0 0 180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

/** The value column. `--fg` at a step down rather than `--fg-muted`: the placeholders below
 *  (`(empty)`) carry meaning, and the muted token is where a meta-weight sentence disappears on
 *  the light palettes. Never opacity — the token IS the recede. */
const valueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)',
  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

const iconBtn: React.CSSProperties = {
  flex: `0 0 ${ACTIONS_W}px`, display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: 20, padding: 0, background: 'none', border: 'none', outline: 'none',
  color: 'var(--fg-muted)', fontSize: 12, cursor: 'pointer', lineHeight: 1,
}

const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)',
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 5,
  padding: '4px 7px', outline: 'none', minWidth: 0,
}

export function EnvironmentSection({ project, onPatch, settingsFiles, projects = [], onOpenFolderPrefs }: EnvironmentSectionProps) {
  const entries = project?.env ?? []
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftValue, setDraftValue] = useState('')
  /** The clear-value prompt: never guess which of the two a blank field meant. */
  const [clearing, setClearing] = useState<string | null>(null)

  const nameError = adding ? validateEnvName(draftName, entries.map((e) => e.name)) : null

  const write = (next: EnvEntry[]) => onPatch({ env: next })

  const commitAdd = () => {
    if (nameError || !draftName.trim()) return
    write([...entries, { name: draftName.trim(), value: draftValue }])
    setDraftName('')
    setDraftValue('')
    setAdding(false)
  }

  const setValue = (name: string, value: string) => {
    write(entries.map((e) => (e.name === name ? { name, value } : e)))
  }

  const remove = (name: string) => write(entries.filter((e) => e.name !== name))

  // The repo's own env, read-only. Rendered ONLY when it actually has one — a permanently
  // empty box teaches nothing.
  const repoEnv = repoEnvEntries(settingsFiles)

  if (!project) return <EnvironmentDoorway projects={projects} onOpen={onOpenFolderPrefs} />

  return (
    <div>
      <h3 style={sectionHeader}>Environment</h3>
      <p style={sectionDesc}>
        Set on every lane Operator launches in this project. Stored in{' '}
        <code style={{ fontFamily: 'var(--font-mono)' }}>~/.operator/projects.json</code> on this
        Mac — not in the repo, not shared with your team.
      </p>

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {entries.length === 0 && !adding && (
          // Says what IS true, rather than "None configured" — the more useful sentence, and the
          // one that stops someone adding a variable they already export.
          <div style={{ ...rowStyle, color: 'var(--fg-muted)', fontSize: 11, borderBottom: 'none' }}>
            No variables. Every lane launches with your shell's environment as it is.
          </div>
        )}

        {entries.map((entry) => (
          <div key={entry.name} style={rowStyle}>
            <span style={nameStyle} title={entry.name}>{entry.name}</span>
            {'unset' in entry ? (
              <span style={{ ...valueStyle, color: 'var(--fg-muted)' }}>removed for this project</span>
            ) : 'secret' in entry ? (
              <span style={valueStyle}>from Operator secrets</span>
            ) : (
              <input
                value={entry.value}
                onChange={(e) => {
                  // Clearing a value is ambiguous — `""` and "unset" are different things, and
                  // `[ -z ]` / `[ -v ]` disagree exactly there. Ask; never pick one silently.
                  if (e.target.value === '' && entry.value !== '') setClearing(entry.name)
                  else setValue(entry.name, e.target.value)
                }}
                placeholder="(empty)"
                spellCheck={false}
                style={{ ...inputStyle, ...valueStyle, flex: 1 }}
              />
            )}
            <button
              onClick={() => remove(entry.name)}
              title="Remove this variable"
              aria-label={`Remove ${entry.name}`}
              style={iconBtn}
            >✕</button>
          </div>
        ))}

        {clearing && (
          <div style={{ ...rowStyle, flexWrap: 'wrap', gap: 8, background: 'var(--overlay-subtle)' }}>
            <span style={{ fontSize: 11, color: 'var(--fg)', flex: '1 1 100%' }}>
              Remove <code style={{ fontFamily: 'var(--font-mono)' }}>{clearing}</code>, or set it
              to an empty value? A shell can tell those apart.
            </span>
            <button onClick={() => { remove(clearing); setClearing(null) }} style={textBtn}>Remove it</button>
            <button onClick={() => { setValue(clearing, ''); setClearing(null) }} style={textBtn}>Set it to empty</button>
            <button onClick={() => setClearing(null)} style={{ ...textBtn, color: 'var(--fg-muted)' }}>Cancel</button>
          </div>
        )}

        {adding ? (
          <div style={{ ...rowStyle, flexWrap: 'wrap', borderBottom: 'none' }}>
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitAdd(); if (e.key === 'Escape') setAdding(false) }}
              placeholder="NAME"
              spellCheck={false}
              style={{ ...inputStyle, flex: '0 0 180px' }}
            />
            <input
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitAdd(); if (e.key === 'Escape') setAdding(false) }}
              placeholder="value"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={commitAdd} disabled={!!nameError || !draftName.trim()} style={iconBtn} title="Add">↵</button>
            {nameError && (
              // The denial sentence, whole. Which of the two reasons it is IS the information —
              // "Operator will replace this" and "Claude Code ignores this" send you to
              // different next actions, and a shared "not allowed" collapses them into a shrug.
              <span style={{ flex: '1 1 100%', fontSize: 11, color: 'var(--yellow)', lineHeight: 1.5, paddingTop: 4 }}>
                {nameError}
              </span>
            )}
          </div>
        ) : (
          <button onClick={() => setAdding(true)} style={{ ...textBtn, display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px' }}>
            + variable
          </button>
        )}
      </div>

      {repoEnv.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={sectionHeader}>Inherited</h3>
          <p style={sectionDesc}>
            From this repo's <code style={{ fontFamily: 'var(--font-mono)' }}>.claude/settings.json</code> —
            edit it on the General tab. This page never writes that file.
          </p>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {repoEnv.map(([name, value]) => (
              <div key={name} style={{ ...rowStyle, borderBottom: 'none' }}>
                <span style={nameStyle} title={name}>{name}</span>
                <span style={valueStyle} title={value}>{value}</span>
                <span style={{ flex: `0 0 ${ACTIONS_W * 2}px`, fontSize: 10, color: 'var(--fg-muted)', textAlign: 'right' }}>read-only</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** The doorway, shown where the global page has no project to edit. The tab stays on the global
 *  page on purpose: someone looking for env variables looks here first, and the useful answer is
 *  not "wrong place" but the list of places that are right.
 *
 *  Read-only. Nothing here writes anything — each row is a link to the page that does. */
function EnvironmentDoorway({ projects, onOpen }: {
  projects: Project[]
  onOpen?: (projectPath: string, projectName: string, tab?: FolderPrefsTab) => void
}) {
  const rows = envDoorwayRows(projects)

  return (
    <div>
      <h3 style={sectionHeader}>Environment</h3>
      <p style={sectionDesc}>
        Variables are set per project, and this page is not a project. Open one to edit what its
        lanes launch with.
      </p>

      {rows.length === 0 ? (
        // One honest line, no empty box: there is nothing to frame yet.
        <p style={sectionDesc}>
          No projects yet. Open a folder in Operator and it gets an Environment tab of its own.
        </p>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {rows.map(({ project, count }, i) => (
            <button
              key={project.id}
              data-env-doorway-row={project.path}
              onClick={() => onOpen?.(project.path, project.name, 'Environment')}
              title={`${project.name}: its own Environment tab`}
              style={{
                ...rowStyle, width: '100%', boxSizing: 'border-box', textAlign: 'left',
                background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer',
                fontFamily: 'inherit',
                borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--overlay-subtle)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ ...nameStyle, fontFamily: 'inherit', fontSize: 12 }} title={project.name}>{project.name}</span>
              <span style={{ ...valueStyle, color: 'var(--fg-muted)' }} title={project.path}>{tildePath(project.path)}</span>
              <span style={{
                fontSize: 11, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap', color: count === 0 ? 'var(--fg-muted)' : 'var(--fg)',
              }}>
                {count === 0 ? 'none set' : `${count} ${count === 1 ? 'variable' : 'variables'}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The doorway's order: the projects that actually set something first, most first, and the rest
 *  after them in store order — `sort` is stable, so equal counts keep the order they came in.
 *  A project with none is still listed and still opens: it is where you go to add the first one.
 *
 *  Tombstones (`unset`) count. Removing a variable for a project IS something set here. */
export function envDoorwayRows(projects: Project[]): Array<{ project: Project; count: number }> {
  return projects
    .map((project) => ({ project, count: project.env?.length ?? 0 }))
    .sort((a, b) => b.count - a.count)
}

const textBtn: React.CSSProperties = {
  background: 'none', border: 'none', outline: 'none', cursor: 'pointer',
  color: 'var(--accent)', fontSize: 11, fontFamily: 'inherit', padding: 0,
}

/** The repo's own `env` block, if it has one. `ClaudeSettings` is deliberately open-ended
 *  (`[key: string]: unknown`), so this narrows rather than trusting the shape. */
function repoEnvEntries(files: SettingsFile[]): Array<[string, string]> {
  // `project-local` last so it wins: it is the higher-precedence of the repo's two files, and
  // this block claims to show what the repo actually sets.
  const out: Record<string, string> = {}
  for (const scope of ['project', 'project-local'] as const) {
    const env = files.find((f) => f.scope === scope)?.settings?.env
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
  }
  return Object.entries(out)
}

/** Exported for the page above and, later, the lane altitude — the denial sentence must be the
 *  same one everywhere it is shown. */
export { denyReason }
