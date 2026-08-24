import { useEffect, useMemo, useState } from 'react'
import type { SettingsFile, SkillCatalogEntry, SkillMode, SkillsCatalog } from '../../../shared/types'
import { sectionHeader, sectionDesc } from '../settings/PageShell'

// S1 of `dev/results/session-settings-design.md` — READ-ONLY.
//
// Nothing on this page writes. That is the step, not a shortcut: a read-only page can be wrong
// safely and a writing one cannot, and this one opens onto pre-existing state on day one — the
// user's own `~/.claude/settings.json` already carries three `skillOverrides: "off"` and six
// `enabledPlugins`. Getting the READ right against real data is the whole of S1.
//
// WHAT SETTLED OPEN QUESTION 1, and it changes this screen. The design left open whether a
// plugin skill's override key is `plugin:skill` or the bare name. Measured against CLI 2.1.235
// with `claude -p --settings <file>`: NEITHER works, nor does the marketplace-qualified
// `plugin@marketplace:skill`. `skillOverrides` reaches global and project skills only.
// `enabledPlugins` — all-or-nothing per plugin — is the only control for plugin skills.
//
// So a per-skill control must NOT be offered on a plugin row when this page grows writes (S4).
// Offering one would write a key that silently does nothing, which is the exact failure the
// denylist's second sentence exists to prevent elsewhere. The rows say so instead.

interface SkillsSectionProps {
  projectPath: string
  /** Read for the inherited overrides. Never written from this page. */
  settingsFiles: SettingsFile[]
  /** The user's `~/.claude/settings.json`, when the caller has it — the global overrides live
   *  there, and they are what this page mostly shows on a first visit. */
  globalSettings?: SettingsFile | null
}

interface Group {
  key: string
  kind: SkillCatalogEntry['source']['kind']
  label: string
  plugin?: string
  entries: SkillCatalogEntry[]
}

/** Groups past this collapse behind `⌄ N more`. The header count is always the TRUE total. */
const COLLAPSE_AT = 8

const MODE_LABEL: Record<SkillMode, string> = {
  'on': 'on',
  'name-only': 'name-only',
  'user-invocable-only': '/command only',
  'off': 'off',
}

/** Claude Code's own words, verbatim from the CLI. The UI must describe the EFFECT without
 *  misrepresenting the mechanism, and paraphrasing these into something shorter loses the
 *  distinction between the middle two. */
const MODE_HINT: Record<SkillMode, string> = {
  'on': 'Listed with its description, and the model can use it.',
  'name-only': 'Listed without its description.',
  'user-invocable-only': 'Hidden from the model, but /name still works.',
  'off': 'Hidden from both.',
}

export function SkillsSection({ projectPath, settingsFiles, globalSettings }: SkillsSectionProps) {
  const [catalog, setCatalog] = useState<SkillsCatalog | null>(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    window.operator.skillsCatalog(projectPath)
      .then((c) => { if (!cancelled) setCatalog(c) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [projectPath, reloadKey])

  const overrides = useMemo(() => readOverrides(globalSettings, settingsFiles), [globalSettings, settingsFiles])
  const pluginsEnabled = useMemo(() => readPlugins(globalSettings, settingsFiles), [globalSettings, settingsFiles])

  const groups = useMemo(() => groupEntries(catalog?.entries ?? [], projectPath), [catalog, projectPath])

  const query = filter.trim().toLowerCase()
  const matches = (e: SkillCatalogEntry) =>
    !query || e.name.toLowerCase().includes(query) || e.description.toLowerCase().includes(query)

  const offCount = Object.values(overrides).filter((m) => m === 'off').length

  return (
    <div>
      <h3 style={sectionHeader}>Skills</h3>
      <p style={sectionDesc}>
        Every skill Claude Code would load in this project, read from disk. This page is
        read-only for now — it shows the state your own settings files already carry.
      </p>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name or description"
        spellCheck={false}
        style={{
          width: '100%', boxSizing: 'border-box', marginBottom: 12,
          fontSize: 11, fontFamily: 'inherit', color: 'var(--fg)',
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '6px 9px', outline: 'none',
        }}
      />

      {failed && (
        <ReadError label="the skills catalog" onRetry={() => setReloadKey((k) => k + 1)} />
      )}

      {/* An unreadable root says so. Never an empty group pretending there are no skills. */}
      {catalog?.errors.map((e) => (
        <ReadError key={e.path} label={e.label} detail={e.message} onRetry={() => setReloadKey((k) => k + 1)} />
      ))}

      {!catalog && !failed && (
        // The page's IDENTITY is known before its contents are, so no spinner over the whole
        // page — just rows that have not arrived yet.
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ height: 28, borderBottom: i < 2 ? '1px solid var(--border)' : 'none', background: 'var(--overlay-subtle)' }} />
          ))}
        </div>
      )}

      {catalog && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {groups.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--fg-muted)' }}>
              No skills found in any of the three roots.
            </div>
          )}
          {groups.map((g) => {
            const shown = g.entries.filter(matches)
            const isOpen = expanded[g.key] || !!query
            const visible = isOpen ? shown : shown.slice(0, COLLAPSE_AT)
            const pluginOff = g.plugin != null && pluginsEnabled[g.plugin] === false
            return (
              <div key={g.key}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderBottom: '1px solid var(--border)', background: 'var(--overlay-subtle)',
                }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
                    textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--fg)',
                  }}>{g.kind}</span>
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.label}>
                    {g.label}
                  </span>
                  {g.plugin != null && (
                    <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
                      {pluginOff ? 'Off' : 'On'}
                    </span>
                  )}
                  {/* The true total, never the visible one. */}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}>
                    {query ? `${shown.length} of ${g.entries.length}` : g.entries.length}
                  </span>
                </div>

                {/* A disabled plugin's rows are NOT rendered greyed — a greyed checkbox implies
                    it could be ticked. One sentence in their place, which does not read as a
                    bug the way a vanished control does. */}
                {pluginOff ? (
                  <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--fg-muted)', borderBottom: '1px solid var(--border)' }}>
                    Disabled in your settings — its {g.entries.length} skill{g.entries.length === 1 ? '' : 's'} won't load.
                  </div>
                ) : shown.length === 0 ? (
                  <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--fg-muted)', borderBottom: '1px solid var(--border)' }}>
                    {query
                      ? 'Nothing matches the filter here.'
                      : g.kind === 'project'
                        ? 'No skills here yet. Add one at .claude/skills/<name>/SKILL.md.'
                        : 'No skills here.'}
                  </div>
                ) : (
                  visible.map((e) => {
                    const mode = overrides[e.name]
                    return (
                      <div key={`${g.key}:${e.name}`} style={{
                        display: 'flex', alignItems: 'baseline', gap: 10,
                        padding: '6px 12px', borderBottom: '1px solid var(--border)',
                      }}>
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)', fontSize: 11,
                            color: mode === 'off' ? 'var(--fg-muted)' : 'var(--fg)',
                            flex: '0 0 190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                          title={e.name}
                        >{e.name}</span>
                        <span style={{
                          fontSize: 11, color: 'var(--fg-muted)', flex: 1, minWidth: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={e.description}>{e.description}</span>
                        {/* Fixed width, ink only when non-default, so nothing reflows. */}
                        <span
                          style={{ flex: '0 0 92px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-muted)' }}
                          title={mode ? MODE_HINT[mode] : undefined}
                        >
                          {mode && mode !== 'on' ? MODE_LABEL[mode] : ''}
                        </span>
                      </div>
                    )
                  })
                )}

                {!isOpen && shown.length > COLLAPSE_AT && (
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [g.key]: true }))}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px',
                      background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                      outline: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 11, fontFamily: 'inherit',
                    }}
                  >⌄ {shown.length - COLLAPSE_AT} more</button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {offCount > 0 && (
        <p style={{ ...sectionDesc, margin: '12px 0 0' }}>
          {offCount === 1 ? 'One skill is' : `${offCount} skills are`} off in your global{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>~/.claude/settings.json</code>. They show
          as off here and stay off until you change them there.
        </p>
      )}

      <p style={{ ...sectionDesc, margin: '12px 0 0' }}>
        Plugin skills can only be turned off a whole plugin at a time — measured against the CLI,
        a per-skill override has no effect on them.
      </p>
    </div>
  )
}

function ReadError({ label, detail, onRetry }: { label: string; detail?: string; onRetry: () => void }) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', marginBottom: 12,
      fontSize: 11, color: 'var(--fg)',
    }}>
      Couldn't read {label}.{detail ? ` ${detail}` : ''}{' '}
      <button onClick={onRetry} style={{ background: 'none', border: 'none', outline: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 11, fontFamily: 'inherit', padding: 0 }}>
        retry
      </button>
    </div>
  )
}

/** Group by root, in the order the design lists them: global, project, then one group per
 *  plugin. Exported-shape logic kept here rather than in the walk so the backend stays a
 *  catalog and the page owns its own presentation. */
function groupEntries(entries: SkillCatalogEntry[], projectPath: string): Group[] {
  const global: SkillCatalogEntry[] = []
  const project: SkillCatalogEntry[] = []
  const byPlugin = new Map<string, SkillCatalogEntry[]>()
  for (const e of entries) {
    if (e.source.kind === 'global') global.push(e)
    else if (e.source.kind === 'project') project.push(e)
    else {
      const key = e.source.plugin ?? e.source.label
      const list = byPlugin.get(key)
      if (list) list.push(e)
      else byPlugin.set(key, [e])
    }
  }
  const groups: Group[] = [
    { key: 'global', kind: 'global', label: '~/.claude/skills', entries: global },
  ]
  // The project group renders even when empty — "no skills here yet, add one at …" is the
  // useful sentence, and it only makes sense when there IS a project.
  if (projectPath) groups.push({ key: 'project', kind: 'project', label: `${projectPath}/.claude/skills`, entries: project })
  for (const [plugin, list] of [...byPlugin.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({ key: `plugin:${plugin}`, kind: 'plugin', label: plugin, plugin, entries: list })
  }
  return groups
}

/** Global first, then the repo's own file on top — the same low-to-high order the resolver
 *  uses, so the page and a launch cannot disagree about what is in force. */
function readOverrides(globalFile: SettingsFile | null | undefined, files: SettingsFile[]): Record<string, SkillMode> {
  const out: Record<string, SkillMode> = {}
  for (const f of [globalFile, ...files.filter((f) => f.scope !== 'global')]) {
    const raw = f?.settings?.skillOverrides
    if (!raw || typeof raw !== 'object') continue
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === 'on' || v === 'off' || v === 'name-only' || v === 'user-invocable-only') out[k] = v
    }
  }
  return out
}

function readPlugins(globalFile: SettingsFile | null | undefined, files: SettingsFile[]): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const f of [globalFile, ...files.filter((f) => f.scope !== 'global')]) {
    const raw = f?.settings?.enabledPlugins
    if (!raw || typeof raw !== 'object') continue
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
  }
  return out
}
