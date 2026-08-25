// The filesystem seam for the read-only code navigator — Electron MAIN.
//
// `dev/results/code-navigator-design.md` writes this against `src-tauri`; it lives here instead,
// because the Rust backend is gone. The design's §9 lists three bridge calls and one sentence
// that matters more than the rest of the file:
//
//   > Every one of them MUST reject paths that escape `root` after canonicalisation. This is the
//   > only new attack surface the feature opens, it is a two-line check, and it is the kind of
//   > check that gets added after the first bug report rather than before if it isn't written
//   > down here.
//
// So the guard is the first thing in this file, it is a pure function, and it is tested against
// every escape shape rather than the one that came to mind.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO:
//   - no recursive walk on open (the tree is lazy, one directory per expand — the whole point is
//     never touching `node_modules`'s tens of thousands of entries in the first place);
//   - no following symlinked directories (that is how a walk escapes its root, and a tree UI has
//     no way to render the cycle it would find);
//   - no writing, ever. There is no write path in this module and there is not meant to be one.
import { readdir, readFile, stat, open as openFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, relative, resolve as resolvePath, sep, extname, basename } from 'node:path'
import { realpathSync } from 'node:fs'

/** Directories never descended into, checked BEFORE recursing rather than filtered after.
 *
 *  Straight from the research doc, plus the two the worktree audit measured as the actual disk
 *  hogs on this machine (`target/` at 3.8 GB in one worktree, `node_modules` at ~486 MB in
 *  another). A tree that lists them is not slow, it is unusable. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', '.next',
  '__pycache__', '.turbo', '.cache', '.vite', 'out', '.svelte-kit',
])

/** IPC payload ceiling, not an editor ceiling.
 *
 *  The research is explicit that this is about "how big an IPC message is reasonable", not "how
 *  big a file CodeMirror can show" — CM6 handles a million lines. So it is generous, and going
 *  over it TRUNCATES with an honest count rather than refusing: the design's rule is that a file
 *  is never a refusal, and a truncated view that says how much it is missing beats an error. */
const MAX_BYTES = 4 * 1024 * 1024

/** The window git, `file` and ripgrep all use to decide "binary". Matching it avoids the
 *  "Operator says binary, git says text" disagreement. */
const BINARY_SNIFF_BYTES = 8000

/** Coalesce a burst of filesystem events into one refresh. `fs.watch` does no batching of its
 *  own, and a `git checkout` or a formatter pass fires hundreds in a few milliseconds. */
const WATCH_DEBOUNCE_MS = 150

// ── the path guard ───────────────────────────────────────────────────────────────────────────

/** Is `candidate` inside `root`, after canonicalisation?
 *
 *  THE TRAP THIS AVOIDS is the same one `worktree.ts:realOf` documents: on macOS `/tmp` really is
 *  `/private/tmp`, so comparing a resolved root against a lexical candidate finds no relationship
 *  and answers "no". Here the lie would run the other way — a "no" is a refusal, which is safe —
 *  but the mirror case is real: a root given as `/tmp/x` and a candidate resolved to
 *  `/private/tmp/x/y` would be refused even though it is legitimately inside. Both sides are
 *  canonicalised so the comparison happens in one namespace.
 *
 *  `..` is handled by `resolve` before any comparison, so `root/../../etc/passwd` collapses to
 *  `/etc/passwd` and fails the prefix test. A symlink INSIDE the root that points outside it is
 *  caught too, because the candidate is resolved through `realpath` before comparing.
 *
 *  Separator-terminated prefix, not `startsWith` on the bare string: without it `/a/rootkit`
 *  passes as "inside `/a/root`".
 *
 *  Pure enough to test: it touches the filesystem only through `realpathSync`, which falls back
 *  to the lexical form for paths that do not exist yet. */
export function isInsideRoot(root: string, candidate: string): boolean {
  if (!root.trim() || !candidate.trim()) return false
  const r = canonical(root)
  const c = canonical(candidate)
  if (c === r) return true
  return c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** The canonical form of a root, for producing repo-relative paths against it.
 *
 *  `relative(root, abs)` is only correct when BOTH are in the same namespace. `resolveInRoot`
 *  canonicalises what it returns, so a root handed in lexically (`/tmp/x`, whose real form on
 *  macOS is `/private/tmp/x`) produced relative paths that climbed out with `../../`. Caught by a
 *  test, because the temp directory a test runs in is exactly such a path — which is the same
 *  macOS firmlink trap `worktree.ts:realOf` documents, met from the other side. */
export function canonicalRoot(root: string): string {
  return canonical(root)
}

function canonical(p: string): string {
  const abs = resolvePath(p)
  try { return realpathSync(abs) } catch { return abs }
}

/** Resolve a repo-relative (or absolute) path against `root`, or throw.
 *
 *  Throwing rather than returning null is deliberate: every caller is an IPC handler whose only
 *  correct response to an escape is to fail loudly, and an ignored null is how a guard stops
 *  guarding. */
export function resolveInRoot(root: string, path: string): string {
  const abs = isAbsolute(path) ? path : join(root, path)
  if (!isInsideRoot(root, abs)) throw new Error(`Refusing to read outside the root: ${path}`)
  return canonical(abs)
}

/** Is any segment of this repo-relative path one we never descend into?
 *
 *  Used by the WATCHER, where the path arrives already deep (`node_modules/.bin/foo`) and the
 *  name check that guards the tree walk has no chance to run. `npm install` churn is the loudest
 *  thing on this filesystem and none of it should refresh anything. Pure. */
export function isIgnoredPath(relPath: string): boolean {
  return relPath.split(/[/\\]/).some((seg) => SKIP_DIRS.has(seg))
}

// ── the tree ─────────────────────────────────────────────────────────────────────────────────

export interface TreeEntry {
  /** Repo-relative, `/`-separated. */
  path: string
  name: string
  dir: boolean
  /** Bytes, for files only. */
  size?: number
}

/** Sort: directories first, then case-insensitive by name.
 *
 *  Dotfiles sort with everything else rather than to the top — a `.claude` directory is content
 *  here, not chrome, and hoisting it puts the least-browsed thing first. Pure. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** One directory's immediate children. Lazy by construction — the caller asks again per expand.
 *
 *  `showIgnored` surfaces the skipped directories as entries (the design's `⌥` toggle) but still
 *  never descends into them; listing a `node_modules` row is cheap, walking it is not. */
export async function fileTree(root: string, dir: string, showIgnored = false): Promise<TreeEntry[]> {
  const abs = resolveInRoot(root, dir || '.')
  const dirents = await readdir(abs, { withFileTypes: true })
  const out: TreeEntry[] = []
  for (const d of dirents) {
    // `isDirectory()` is false for a symlinked directory, which is exactly the behaviour wanted:
    // a symlink is neither descended into nor presented as one.
    if (d.isSymbolicLink()) continue
    const isDir = d.isDirectory()
    if (isDir && SKIP_DIRS.has(d.name) && !showIgnored) continue
    const childAbs = join(abs, d.name)
    const rel = relative(canonicalRoot(root), childAbs).split(sep).join('/')
    let size: number | undefined
    if (!isDir) {
      try { size = (await stat(childAbs)).size } catch { size = undefined }
    }
    out.push({ path: rel, name: d.name, dir: isDir, size })
  }
  return sortEntries(out)
}

// ── reading a file ───────────────────────────────────────────────────────────────────────────

export interface FileContent {
  path: string
  text: string
  /** True line count of the file, even when `text` is truncated. */
  lines: number
  bytes: number
  truncated: boolean
  binary: boolean
  /** A `@codemirror/language-data` language NAME, or null for "render as plain text". */
  language: string | null
}

/** A NUL byte in the first 8 KB. The same heuristic git, `file` and ripgrep use. Pure. */
export function looksBinary(head: Uint8Array): boolean {
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return true
  return false
}

/** Extension → `@codemirror/language-data` language name.
 *
 *  Only names that `languages.find(l => l.name === …)` actually resolves — a name it cannot find
 *  silently renders as plain text, which looks like the highlighter is broken rather than like
 *  the language is unsupported. `null` is the honest answer and the footer says `plain text`.
 *
 *  Pure, and a table rather than a chain of `endsWith` so a wrong entry is visible as data. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.tsx': 'TSX',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.jsx': 'JSX',
  '.json': 'JSON', '.jsonc': 'JSON',
  '.rs': 'Rust',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.html': 'HTML', '.htm': 'HTML',
  '.md': 'Markdown', '.markdown': 'Markdown',
  '.toml': 'TOML',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
  '.py': 'Python',
  '.go': 'Go',
  '.sql': 'SQL',
  '.xml': 'XML', '.svg': 'XML',
  '.swift': 'Swift',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
  '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP',
}

/** Files with no extension whose NAME identifies the language. */
const LANGUAGE_BY_NAME: Record<string, string> = {
  'Dockerfile': 'Dockerfile',
  'Makefile': 'CMake',
  '.zshrc': 'Shell', '.bashrc': 'Shell', '.profile': 'Shell',
  '.gitignore': 'Shell',
}

export function languageFor(path: string): string | null {
  const name = basename(path)
  if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name]
  return LANGUAGE_BY_EXT[extname(name).toLowerCase()] ?? null
}

/** Count lines the way an editor does: a trailing newline does not add a line. Pure. */
export function countLines(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  // A file ending in "\n" has its last line empty; editors do not count that as a line of code,
  // and neither does `wc -l`. Matching them keeps a deep link's L-number meaningful.
  return text.endsWith('\n') ? n - 1 : n
}

/** Read a file for display. Never a refusal — a file too big is truncated with a true count, a
 *  binary file reports itself, an empty file reports zero. */
export async function fileRead(root: string, path: string, maxBytes = MAX_BYTES): Promise<FileContent> {
  const abs = resolveInRoot(root, path)
  const info = await stat(abs)
  if (info.isDirectory()) throw new Error(`Not a file: ${path}`)

  // Sniff BEFORE reading the whole thing: a 200 MB binary must not be read into a Buffer just to
  // discover it is a binary.
  const fh = await openFile(abs, 'r')
  let binary = false
  try {
    const head = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, info.size))
    if (head.length) await fh.read(head, 0, head.length, 0)
    binary = looksBinary(head)
  } finally {
    await fh.close()
  }

  const base = { path, bytes: info.size, language: languageFor(path) }
  if (binary) return { ...base, text: '', lines: 0, truncated: false, binary: true }

  if (info.size > maxBytes) {
    const fh2 = await openFile(abs, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      await fh2.read(buf, 0, maxBytes, 0)
      // Cut at the last complete line so the viewer never shows a half-line as if it were whole,
      // and never splits a multi-byte character across the boundary.
      const text = buf.toString('utf8')
      const cut = text.lastIndexOf('\n')
      const kept = cut > 0 ? text.slice(0, cut) : text
      return { ...base, text: kept, lines: countLines(kept), truncated: true, binary: false }
    } finally {
      await fh2.close()
    }
  }

  const text = await readFile(abs, 'utf8')
  return { ...base, text, lines: countLines(text), truncated: false, binary: false }
}

// ── watching ─────────────────────────────────────────────────────────────────────────────────

/** Coalesce a burst of changed paths into the set worth telling the renderer about.
 *
 *  Ignored paths are dropped HERE rather than at the watcher, because `fs.watch(recursive)` fires
 *  for everything under the root including `node_modules` churn — and an `npm install` inside a
 *  lane would otherwise refresh the tree several thousand times. Pure. */
export function coalesceChanges(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (!p) continue
    const rel = p.split(sep).join('/')
    if (isIgnoredPath(rel)) continue
    out.add(rel)
  }
  return [...out].sort()
}

/** Watch a root recursively and report coalesced, filtered changes.
 *
 *  `fs.watch(dir, {recursive: true})` is FSEvents-backed on macOS — the same mechanism chokidar
 *  would use — so on a macOS-only app it is the same watching with no dependency. Its two known
 *  rough edges are handled rather than ignored: it fires inside ignored directories (filtered in
 *  `coalesceChanges`) and it does no batching (the debounce below).
 *
 *  Returns a stop function. Failure to watch is not fatal: the viewer simply does not offer to
 *  re-read, which is a smaller loss than a launch that fails because a directory went away. */
export function watchRoot(root: string, onChange: (paths: string[]) => void): () => void {
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let burst: string[] = []
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      burst.push(String(filename))
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const paths = coalesceChanges(burst)
        burst = []
        if (paths.length) onChange(paths)
      }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', (e) => console.error('[files] watch error:', e))
  } catch (e) {
    console.error(`[files] could not watch ${root}:`, e)
  }
  return () => {
    if (timer) { clearTimeout(timer); timer = null }
    try { watcher?.close() } catch { /* already closed */ }
    watcher = null
  }
}

/** One watcher per root, refcounted — both placements (main view and right panel) read the same
 *  worktree and must not open two FSEvents streams over the same tree. */
const watchers = new Map<string, { stop: () => void; refs: number }>()

export function beginWatching(root: string, onChange: (root: string, paths: string[]) => void): void {
  const existing = watchers.get(root)
  if (existing) { existing.refs++; return }
  watchers.set(root, { stop: watchRoot(root, (paths) => onChange(root, paths)), refs: 1 })
}

export function endWatching(root: string): void {
  const existing = watchers.get(root)
  if (!existing) return
  if (--existing.refs > 0) return
  existing.stop()
  watchers.delete(root)
}

/** Stop every watcher. Called from `teardown()` — an FSEvents stream is a real OS resource. */
export function stopAllWatching(): void {
  for (const w of watchers.values()) w.stop()
  watchers.clear()
}
