// WHAT A PROJECT IS, WHEN NOBODY HAS TYPED IT.
//
// Project Home's centrepiece is a description of the project. `contextNotes` — a written one —
// is specced and unbuilt, so it is empty for all 20 projects and would be empty for every
// project on the day it ships. A landing that only becomes good after someone hand-writes 20
// descriptions is a form with a nice header.
//
// But an empty STORE is not an empty PROJECT. Measured across the real set: 8 projects carry an
// Obsidian hub note (found via the path inside their own CLAUDE.md), 2 have a README that
// describes them, 1 has CLAUDE.md prose, 1 a package.json description — 12 of 20 describe
// themselves correctly with nothing typed. The rest need a human, and say so rather than
// pretending.
//
// So: derive it, show where it came from, and let `contextNotes` be a CORRECTION of the derived
// text rather than a blank that must be filled. There is no state where the user faces an empty
// box and a blinking cursor.
//
// Pure. The file reads happen in Rust (`project_identity`); this is the part with judgement in
// it, which is the part that needs tests.

export interface DescriptionSources {
  /** A written override. Wins over everything — this is what `contextNotes` becomes. */
  contextNotes?: string | null
  hubNote?: string | null
  readme?: string | null
  claudeMd?: string | null
  packageJson?: string | null
}

export type DescriptionSource = 'written' | 'hub note' | 'README' | 'CLAUDE.md' | 'package.json' | 'none'

export interface ProjectDescription {
  text: string
  from: DescriptionSource
  /** True when the derived text came from a file that names a DIFFERENT project — the three
   *  `-landing` repos all point at their parent product's hub note. The UI marks this. */
  suspect?: boolean
}

/** THE SHAPE GATE, and it is load-bearing.
 *
 *  Precedence alone is not enough: the highest-ranked source often opens with something that is
 *  not prose. Measured without this gate, `website-2025` described itself as
 *  `- [x] Home - [x] About - [x] Project archive`, `uwazi_app` as `**Why:** Tracking remaining
 *  work…` (a memory-note fragment), and `operator` as an `<img>` tag. With it, all three fall
 *  through to something true. This is what moves the feature from "usually works" to shippable.
 */
function isProse(line: string): boolean {
  const s = line.trim()
  if (s.length < 25) return false                    // too short to be a description
  if (/^#{1,6}\s/.test(s)) return false              // a heading names, it does not describe
  if (/^[-*+]\s|^\d+\.\s/.test(s)) return false      // list item
  if (/^\[[ x]\]|^[-*+]\s*\[[ x]\]/i.test(s)) return false // checklist
  if (/^[|>`]/.test(s) && !/^>\s*\w/.test(s)) return false // table, code fence, bare quote marker
  if (/^<[a-z!/]/i.test(s)) return false             // markup — the `<img>` badge row
  if (/^!?\[[^\]]*\]\(/.test(s)) return false        // an image or link IS the whole line
  if (/^\*\*(Why|How to apply|Note|Status)\b/i.test(s)) return false // memory-note fragment
  if (/^(TODO|WIP|Draft)\b/i.test(s)) return false
  // THE HUB POINTER IS NOT A DESCRIPTION. Every CLAUDE.md here opens with a paragraph about
  // where the project's Obsidian note lives — real prose, correctly punctuated, and about the
  // VAULT rather than the project. Measured, it made `umbra` and `walter` describe themselves as
  // "This project has a knowledge-hub note in the Obsidian vault, at…". The pointer is still
  // useful (it is how the hub note is FOUND, see the Rust side); it is just not the answer to
  // "what is this project".
  if (/knowledge-hub note|Obsidian (project hub|vault)|hub note/i.test(s)) return false
  // A line that is mostly link/badge markup says nothing, whatever its first character.
  const markup = (s.match(/\[[^\]]*\]\([^)]*\)|<[^>]+>|`[^`]+`/g) || []).join('').length
  if (markup > s.length * 0.4) return false
  return /[a-z]{3}/i.test(s)
}

/** First prose line of a markdown-ish document.
 *
 *  A leading `>` blockquote is KEPT (with its marker stripped) — that is exactly how the hub
 *  notes carry their mission line: `> Mission control for working agents…`. Frontmatter and
 *  headings are skipped. */
function firstProse(doc: string | null | undefined): string | null {
  if (!doc) return null
  let body = doc
  // YAML frontmatter, if present.
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end !== -1) body = body.slice(end + 4)
  }
  let inFence = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence || !line) continue
    const stripped = line.replace(/^>\s*/, '').trim()
    if (isProse(stripped)) return stripped
  }
  return null
}

/** `package.json`'s `description`, if it has one worth showing. */
function fromPackageJson(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const d = JSON.parse(raw)?.description
    return typeof d === 'string' && isProse(d) ? d.trim() : null
  } catch {
    // A truncated read (we only take the first 4KB) is not an error worth surfacing.
    return null
  }
}

/** Does this text look like it is about a DIFFERENT project?
 *
 *  The three `-landing` repos point their CLAUDE.md at the parent product's hub note, so they
 *  derive a description of the product rather than of the site. Not wrong enough to discard —
 *  it is real context — but the UI must be able to say so, because a description the user cannot
 *  trace is one they can neither trust nor correct. */
function looksForeign(text: string, projectName: string): boolean {
  const base = projectName.toLowerCase().replace(/[-_](landing|site|web|www)$/i, '')
  if (!base || base.length < 3) return false
  const suffixed = /[-_](landing|site|web|www)$/i.test(projectName)
  return suffixed && text.toLowerCase().includes(base) && !text.toLowerCase().includes(projectName.toLowerCase())
}

/** Derive what this project IS.
 *
 *  Precedence — hub note → README → CLAUDE.md → package.json → nothing — ranked by WHO THE TEXT
 *  WAS WRITTEN FOR: the hub note for a human coming back later, the README for someone arriving
 *  at the project, CLAUDE.md for an agent working inside it, package.json for a registry.
 *
 *  CLAUDE.md ranks FOURTH despite being present in every repo, and that is the correction that
 *  made this work: in all but one of them its opening prose is the hub-note pointer, so ranking
 *  it by file-count would have returned boilerplate for eight projects.
 *
 *  A written `contextNotes` wins over all of it — the derived text is a default, never a lock. */
export function describeProject(
  sources: DescriptionSources,
  projectName = '',
): ProjectDescription {
  const written = sources.contextNotes?.trim()
  if (written) return { text: written, from: 'written' }

  const ordered: [DescriptionSource, string | null][] = [
    ['hub note', firstProse(sources.hubNote)],
    ['README', firstProse(sources.readme)],
    ['CLAUDE.md', firstProse(sources.claudeMd)],
    ['package.json', fromPackageJson(sources.packageJson)],
  ]
  for (const [from, text] of ordered) {
    if (!text) continue
    return { text, from, suspect: looksForeign(text, projectName) || undefined }
  }
  return { text: '', from: 'none' }
}
