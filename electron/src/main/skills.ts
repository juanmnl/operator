// The skills catalog — every skill Claude Code would load, read off disk.
//
// S1 of `dev/results/session-settings-design.md`. Three roots:
//
//   ~/.claude/skills/**/SKILL.md                       global
//   <project>/.claude/skills/**/SKILL.md               project
//   ~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills/**/SKILL.md   plugin
//
// A DIRECTORY WALK, not a CLI shell-out: `claude` has no "list my skills" command that returns
// data, and asking the model is not a catalog. No new dependency either — `readdir` is the whole
// mechanism.
//
// THE PLUGIN TREE IS NESTED, which the design's `skills/**` glob is right about and a flat
// `skills/<name>/SKILL.md` reader would have silently missed most of. On this machine:
//
//   …/mattpocock-skills/1.2.3/skills/engineering/tdd/SKILL.md
//   …/mattpocock-skills/1.2.3/skills/in-progress/loop-me/SKILL.md
//
// The directory names in between (`engineering`, `in-progress`) are shelving, not part of the
// skill's identity — the name comes from the front matter, never from the path.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SkillSource {
  kind: 'global' | 'project' | 'plugin'
  /** What the group header shows: a path for global/project, `plugin@marketplace` for a plugin. */
  label: string
  path: string
  /** `<plugin>@<marketplace>` — the key `enabledPlugins` uses. Present only for plugin skills. */
  plugin?: string
}

export interface SkillCatalogEntry {
  name: string
  description: string
  source: SkillSource
}

export interface SkillsCatalog {
  entries: SkillCatalogEntry[]
  /** Roots that could not be read, so the UI can say "couldn't read ~/.claude/skills" rather
   *  than render an empty group that claims there are no skills. */
  errors: Array<{ label: string; path: string; message: string }>
  /** Plugin id → whether `installed_plugins.json` still lists it. A cache directory left behind
   *  by an uninstalled plugin contributes nothing to a session, and showing its skills as
   *  available would be a lie. */
  installedPlugins: string[]
}

/** How deep to walk under a `skills/` root. The observed nesting is one shelving level
 *  (`skills/engineering/tdd/SKILL.md`); this allows a little more without ever turning a
 *  misconfigured symlink into an unbounded walk of the disk. */
const MAX_DEPTH = 4

/** Parse the `name:` and `description:` out of a SKILL.md front-matter block.
 *
 *  Deliberately a small hand-rolled reader rather than a YAML dependency: the block is two
 *  scalar keys in practice, and the failure mode that matters is a description containing a
 *  colon — which a naive `split(':')` mangles and `indexOf` does not.
 *
 *  Values are NOT unquoted beyond a single matching pair, because a skill description routinely
 *  contains apostrophes and stripping them by pattern corrupts the copy the UI shows.
 *
 *  Pure, so the parse is testable without a filesystem. */
export function parseSkillFrontMatter(text: string): { name?: string; description?: string } {
  // The block must be the FIRST thing in the file: a `---` line further down is a horizontal
  // rule in the prose, and reading keys out of it would invent skills from body text.
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 1) continue
    const key = line.slice(0, at).trim()
    if (key !== 'name' && key !== 'description') continue
    let value = line.slice(at + 1).trim()
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (value) out[key] = value
  }
  return out
}

/** `<plugin>@<marketplace>` from a plugin cache path — the key `enabledPlugins` is written with.
 *
 *  The layout is `…/plugins/cache/<marketplace>/<plugin>/<version>/skills/…`, and the id
 *  REVERSES that order (`mattpocock-skills@claude-plugins-official`), which is the kind of
 *  detail that is wrong-by-default when written from memory.
 *
 *  Pure, so the mapping is testable without the real cache. */
export function pluginIdFromCachePath(path: string): string | undefined {
  const m = /\/plugins\/cache\/([^/]+)\/([^/]+)\/([^/]+)\/skills(?:\/|$)/.exec(path)
  return m ? `${m[2]}@${m[1]}` : undefined
}

/** Which plugin ids `installed_plugins.json` still lists. Its `plugins` map is keyed by exactly
 *  the `<plugin>@<marketplace>` id, which is what makes the cross-check a set lookup. */
export function installedPluginIds(raw: unknown): string[] {
  const plugins = (raw as { plugins?: unknown } | null)?.plugins
  if (!plugins || typeof plugins !== 'object') return []
  return Object.keys(plugins as Record<string, unknown>)
}

/** Deduplicate by name, first writer wins, in root order.
 *
 *  Order is global → project → plugin, and the reason it is not the reverse is that a name
 *  collision between two roots is a real possibility (the same skill installed globally and
 *  vendored into a repo) and the catalog should show it once, at the root the user is most
 *  likely to be looking for it in. Pure. */
export function dedupeByName(entries: SkillCatalogEntry[]): SkillCatalogEntry[] {
  const seen = new Set<string>()
  const out: SkillCatalogEntry[] = []
  for (const e of entries) {
    if (seen.has(e.name)) continue
    seen.add(e.name)
    out.push(e)
  }
  return out
}

/** Every `SKILL.md` under `root`, depth-capped. Missing root = no skills, not an error: most
 *  projects have no `.claude/skills` and that is the ordinary case, not a failure to report. */
async function findSkillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  let dirents
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  const nested: Array<Promise<string[]>> = []
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue
    const full = join(root, d.name)
    if (d.isFile() && d.name === 'SKILL.md') out.push(full)
    // `isDirectory()` is false for a symlinked directory, and following those is how a walk
    // escapes its root. Not following them is the conservative answer.
    else if (d.isDirectory()) nested.push(findSkillFiles(full, depth + 1))
  }
  for (const found of await Promise.all(nested)) out.push(...found)
  return out
}

async function readRoot(root: string, source: (path: string) => SkillSource): Promise<SkillCatalogEntry[]> {
  const files = await findSkillFiles(root)
  const read = await Promise.all(files.map(async (path) => {
    try {
      const { name, description } = parseSkillFrontMatter(await readFile(path, 'utf8'))
      // A SKILL.md with no `name:` is not a skill Claude Code can invoke, so it is not one we
      // list. Falling back to the directory name would put a phantom in the catalog.
      if (!name) return null
      return { name, description: description ?? '', source: source(path) }
    } catch {
      return null
    }
  }))
  return read.filter((e): e is SkillCatalogEntry => e != null)
}

/** Does this root exist and can we read it? Only used to distinguish "no skills here" from
 *  "could not look", which is the difference between an honest empty group and a lie. */
async function rootReadable(root: string): Promise<string | null> {
  try {
    await readdir(root)
    return null
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? null : (e as Error).message
  }
}

/** The catalog for one project. `projectPath` may be empty (the global preferences view), in
 *  which case the project root is simply skipped. */
export async function skillsCatalog(projectPath: string): Promise<SkillsCatalog> {
  const home = homedir()
  const globalRoot = join(home, '.claude', 'skills')
  const projectRoot = projectPath ? join(projectPath, '.claude', 'skills') : ''
  const pluginRoot = join(home, '.claude', 'plugins', 'cache')

  const installedRaw = await readFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null)
  const installed = installedPluginIds(installedRaw)
  const installedSet = new Set(installed)

  const [globals, projects, plugins, gErr, pErr] = await Promise.all([
    readRoot(globalRoot, () => ({ kind: 'global' as const, label: '~/.claude/skills', path: globalRoot })),
    projectRoot
      ? readRoot(projectRoot, () => ({ kind: 'project' as const, label: '.claude/skills', path: projectRoot }))
      : Promise.resolve([]),
    readRoot(pluginRoot, (path) => {
      const plugin = pluginIdFromCachePath(path)
      return { kind: 'plugin' as const, label: plugin ?? 'plugin', path, plugin }
    }),
    rootReadable(globalRoot),
    projectRoot ? rootReadable(projectRoot) : Promise.resolve(null),
  ])

  const errors: SkillsCatalog['errors'] = []
  if (gErr) errors.push({ label: '~/.claude/skills', path: globalRoot, message: gErr })
  if (pErr) errors.push({ label: '.claude/skills', path: projectRoot, message: pErr })

  // A cache directory whose plugin is no longer installed contributes nothing to a session.
  // `installed_plugins.json` is the authority; the cache is just what was left on disk.
  // If the file itself could not be read we keep everything rather than hide the lot — an
  // over-full catalog is recoverable, an empty one looks like the feature is broken.
  const livePlugins = installed.length
    ? plugins.filter((e) => e.source.plugin != null && installedSet.has(e.source.plugin))
    : plugins

  return {
    entries: dedupeByName([...globals, ...projects, ...livePlugins]),
    errors,
    installedPlugins: installed,
  }
}
