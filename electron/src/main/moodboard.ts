// Project-scoped asset storage: `~/.operator/projects/<id>/` — moodboard images and context
// assets. Mirrors the `project_asset_dir` / `moodboard_*` commands in `lib.rs`.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join, basename } from 'node:path'
import { operatorDir } from './store'

/** Lazily create and return the project's asset dir. */
export async function projectAssetDir(id: string): Promise<string> {
  const dir = join(operatorDir(), 'projects', safeId(id))
  await mkdir(dir, { recursive: true })
  return dir
}

/** Ids come from the frontend's canonical-repo-root scheme, but they still become a PATH
 *  SEGMENT here — so anything that could climb out of the assets dir is stripped rather than
 *  trusted. A project id is not user input today; this is what keeps that from mattering. */
const safeId = (id: string) => basename(id).replace(/[^A-Za-z0-9._-]/g, '_') || 'project'
const safeName = (name: string) => basename(name).replace(/[^A-Za-z0-9._-]/g, '_')

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

export async function moodboardAdd(id: string, dataB64: string, ext: string): Promise<string> {
  const dir = await projectAssetDir(id)
  const name = `${Date.now().toString(36)}-${Math.abs(hash(dataB64)).toString(36)}.${ext.replace(/^\./, '')}`
  await writeFile(join(dir, name), Buffer.from(dataB64, 'base64'))
  return name
}

export async function moodboardList(id: string): Promise<string[]> {
  const dir = await projectAssetDir(id)
  const entries = await readdir(dir).catch(() => [] as string[])
  return entries.filter((n) => extname(n).toLowerCase() in IMAGE_MIME).sort()
}

/** Returned as a data: URL because the renderer puts it straight into an <img>, and a
 *  `file://` src is refused by the app's own navigation guard. */
export async function moodboardImage(id: string, name: string): Promise<string> {
  const dir = await projectAssetDir(id)
  const mime = IMAGE_MIME[extname(name).toLowerCase()]
  if (!mime) return ''
  try { return `data:${mime};base64,${(await readFile(join(dir, safeName(name)))).toString('base64')}` } catch { return '' }
}

export async function moodboardRemove(id: string, name: string): Promise<void> {
  const dir = await projectAssetDir(id)
  await rm(join(dir, safeName(name)), { force: true })
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return h
}
