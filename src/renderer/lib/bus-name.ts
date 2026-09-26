// THE NAME A LANE'S SESSION CARRIES ON CLAUDE CODE'S SESSION BUS.
//
// The bus is machine-wide: every `claude` on this Mac publishes a descriptor in ~/.claude/sessions,
// and `ListAgents`/`SendMessage` reach any of them. Launched with no name, a session is called
// `<cwd basename>-<2 hex>` (`mantel-2b`, `uwazi-app-ab`), which says neither project nor role, so a
// lane looking for "Design" could only guess — and a guess can land in another project
// (dev/results/lane-instances-and-message-mixing-2026-09-25.md, X1).
//
// So every lane is launched with `--name <project slug>--<role id>` (verified on the installed CLI,
// 2.1.283: `-n, --name <name>  Set a display name for this session`), and `--<n>` from its second
// instance on:
//
//     mantel-3f1a--design        mantel-landing-9c02--design        mantel-3f1a--code--2
//
// THE SEPARATOR IS `--`, AND NO SLUG CAN CONTAIN IT. `slugify` turns every run of other characters
// into ONE `-`, so a name splits on `--` into exactly slug, role and instance. The first version used
// a single `-`, and a prefix rule then read `mantel-landing-code` as a mantel lane: three project
// pairs on this machine were open to exactly the cross-project send this exists to stop
// (dev/results/review-xproject-devports-2026-09-25.md, A1). Matching is therefore by EQUALITY of the
// parsed slug (`sameProject`), never by prefix.
//
// THE SLUG ALWAYS CARRIES A SHORT HASH OF THE PROJECT ID, so it never changes when another project
// with a similar name is added or removed (review A2): a slug that depended on other projects renamed
// a project's next lanes while its running lanes kept the old name and the old rule.
//
// The ROLE ID, not the display name, so renaming a lane does not rename its session.
import type { Project } from '../../shared/types'

/** Lowercase `[a-z0-9]` runs joined by single dashes. Never contains `--`. */
export const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

/** 4 hex of a stable string hash (FNV-1a) of the project id. */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return ((h >>> 0) & 0xffff).toString(16).padStart(4, '0')
}

/** The project's part of every lane name: `<name slug>-<4 hex of its id>`. Depends on this project
 *  alone, so it is stable for the project's whole life. Pure. */
export function projectSlug(project: Pick<Project, 'id' | 'name'>): string {
  return `${slugify(project.name)}-${shortHash(project.id)}`
}

/** `<project slug>--<role id>`, and `--<n>` from the second instance on. */
export function laneBusName(project: Pick<Project, 'id' | 'name'>, roleId: string, instance = 1): string {
  return `${projectSlug(project)}--${slugify(roleId)}${instance > 1 ? `--${instance}` : ''}`
}

/** Split a bus name built by `laneBusName`. `null` for any other name (a derived `<cwd>-<hex>` name,
 *  a user's own). A suffix the bus may add to resolve a name collision stays on the last part. */
export function parseBusName(name: string): { slug: string; role: string; instance: number } | null {
  const parts = name.split('--')
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) return null
  const instance = parts[2] === undefined ? 1 : Number(parts[2])
  if (!Number.isInteger(instance) || instance < 1) return null
  return { slug: parts[0], role: parts[1], instance }
}

/** Is `name` a lane of the project whose slug is `slug`? EQUALITY of the parsed slug, never a prefix. */
export function sameProject(name: string, slug: string): boolean {
  return parseBusName(name)?.slug === slug
}
