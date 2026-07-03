// Stable project id from a canonical path. The FNV-1a hash keeps two folders with the same
// basename distinct (the old sidebar-grouping collision bug), while the basename slug keeps
// the id — and its asset dir under ~/.operator/projects/<id>/ — human-readable.

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project'
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** e.g. `/Users/x/Developer/operator` → `operator-1a2b3c4d`. Same path → same id, always. */
export function deriveProjectId(canonicalPath: string): string {
  const base = canonicalPath.split('/').filter(Boolean).pop() || 'project'
  return `${slug(base)}-${fnv1a(canonicalPath)}`
}
