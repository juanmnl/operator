// THE NAME A LANE'S SESSION CARRIES ON CLAUDE CODE'S SESSION BUS.
//
// The bus is machine-wide: every `claude` on this Mac publishes a descriptor in ~/.claude/sessions,
// and `ListAgents`/`SendMessage` reach any of them. Launched with no name, a session is called
// `<cwd basename>-<2 hex>` (`mantel-2b`, `uwazi-app-ab`), which says neither project nor role, so a
// lane looking for "Design" could only guess by prefix — and a guess can land in another project
// (dev/results/lane-instances-and-message-mixing-2026-09-25.md, X1).
//
// So every lane is launched with `--name <project-slug>-<role id>` (verified on the installed CLI,
// 2.1.283: `-n, --name <name>  Set a display name for this session`):
//   - the ROLE ID, not the display name, so renaming a lane does not rename its session;
//   - the project NAME as a slug, readable in `ListAgents`, with a short hash of the project id
//     added only when another project's name would give the same slug, so the prefix stays unique;
//   - an instance suffix `-2`, `-3`… for a second session of the same lane (a fan-out today; the
//     lane-as-profile work later), the first having none.
import type { Project } from '../../shared/types'

const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'

/** 4 hex of a stable string hash (FNV-1a). Only used to tell apart two projects with one slug. */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return ((h >>> 0) & 0xffff).toString(16).padStart(4, '0')
}

/** The project's part of every lane name: its name as a slug, plus a short hash of its id when
 *  another project in `all` has a name that slugs the same. Pure and stable. */
export function projectSlug(project: Pick<Project, 'id' | 'name'>, all: readonly Pick<Project, 'id' | 'name'>[]): string {
  const base = slugify(project.name)
  const clash = all.some((p) => p.id !== project.id && slugify(p.name) === base)
  return clash ? `${base}-${shortHash(project.id)}` : base
}

/** `<project-slug>-<role id>`, and `-<n>` from the second instance on. */
export function laneBusName(project: Pick<Project, 'id' | 'name'>, roleId: string, all: readonly Pick<Project, 'id' | 'name'>[], instance = 1): string {
  const role = slugify(roleId)
  return `${projectSlug(project, all)}-${role}${instance > 1 ? `-${instance}` : ''}`
}
