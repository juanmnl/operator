import { describe, it, expect } from 'vitest'
import { parseSkillFrontMatter, pluginIdFromCachePath, installedPluginIds, dedupeByName, type SkillCatalogEntry } from './skills'

describe('parseSkillFrontMatter', () => {
  it('reads name and description out of the block', () => {
    expect(parseSkillFrontMatter('---\nname: no-ai-slop\ndescription: Edit drafts\n---\n\n# body')).toEqual({
      name: 'no-ai-slop', description: 'Edit drafts',
    })
  })

  // The real descriptions are one long sentence full of colons and commas. `split(':')` mangles
  // them; `indexOf` does not, which is the whole reason this is hand-rolled.
  it('keeps a description containing colons intact', () => {
    const text = '---\nname: dataviz\ndescription: Use when: charts, plots, or dashboards. Triggers on: "chart", "graph".\n---\n'
    expect(parseSkillFrontMatter(text).description)
      .toBe('Use when: charts, plots, or dashboards. Triggers on: "chart", "graph".')
  })

  it('strips ONE matching quote pair and no more — apostrophes are copy, not syntax', () => {
    expect(parseSkillFrontMatter('---\nname: "x"\ndescription: \'y\'\n---\n')).toEqual({ name: 'x', description: 'y' })
    expect(parseSkillFrontMatter("---\nname: a\ndescription: the user's voice\n---\n").description)
      .toBe("the user's voice")
  })

  it('ignores keys it does not own', () => {
    expect(parseSkillFrontMatter('---\nname: a\nallowed-tools: Read, Bash\nmodel: opus\n---\n')).toEqual({ name: 'a' })
  })

  it('reads only a block at the very TOP — a --- further down is a horizontal rule', () => {
    expect(parseSkillFrontMatter('# Title\n\n---\nname: not-a-skill\n---\n')).toEqual({})
  })

  it('is empty for a file with no front matter at all', () => {
    expect(parseSkillFrontMatter('just prose')).toEqual({})
  })

  it('tolerates CRLF', () => {
    expect(parseSkillFrontMatter('---\r\nname: a\r\ndescription: b\r\n---\r\n')).toEqual({ name: 'a', description: 'b' })
  })
})

describe('pluginIdFromCachePath', () => {
  // The cache path is <marketplace>/<plugin>/<version>, and the id REVERSES that order. Exactly
  // the kind of thing that is wrong-by-default when written from memory.
  it('reverses marketplace/plugin into plugin@marketplace', () => {
    expect(pluginIdFromCachePath(
      '/Users/j/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3/skills/engineering/tdd/SKILL.md',
    )).toBe('mattpocock-skills@claude-plugins-official')
  })

  it('handles a non-semver version segment — the cache really does contain `unknown` and a sha', () => {
    expect(pluginIdFromCachePath('/x/plugins/cache/claude-plugins-official/frontend-design/unknown/skills/a/SKILL.md'))
      .toBe('frontend-design@claude-plugins-official')
    expect(pluginIdFromCachePath('/x/plugins/cache/claude-plugins-official/frontend-design/205b6e0b3036/skills/a/SKILL.md'))
      .toBe('frontend-design@claude-plugins-official')
  })

  it('is undefined for a path that is not under a plugin cache', () => {
    expect(pluginIdFromCachePath('/Users/j/.claude/skills/no-ai-slop/SKILL.md')).toBeUndefined()
  })
})

describe('installedPluginIds', () => {
  it('reads the keys of the plugins map — already in plugin@marketplace form', () => {
    expect(installedPluginIds({ version: 2, plugins: { 'a@m': [], 'b@m': [] } })).toEqual(['a@m', 'b@m'])
  })
  it('is empty for a missing or malformed file rather than throwing', () => {
    expect(installedPluginIds(null)).toEqual([])
    expect(installedPluginIds({})).toEqual([])
    expect(installedPluginIds({ plugins: 'nope' })).toEqual([])
  })
})

describe('dedupeByName', () => {
  const at = (name: string, kind: SkillCatalogEntry['source']['kind']): SkillCatalogEntry =>
    ({ name, description: kind, source: { kind, label: kind, path: `/${kind}` } })

  it('keeps the FIRST root a name appears in — global before project before plugin', () => {
    const out = dedupeByName([at('x', 'global'), at('x', 'project'), at('y', 'plugin')])
    expect(out).toHaveLength(2)
    expect(out[0].source.kind).toBe('global')
  })

  it('leaves distinct names alone, in order', () => {
    expect(dedupeByName([at('a', 'global'), at('b', 'global')]).map((e) => e.name)).toEqual(['a', 'b'])
  })
})
