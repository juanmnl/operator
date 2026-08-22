// Persist dropped/pasted file bytes to a temp file and return the path(s), so we
// hand Claude Code a path it can Read instead of raw bytes. This is what makes a
// dragged-or-pasted macOS screenshot (which carries bytes but no File.path) work
// like iTerm. Shared by the drop handler and the clipboard-paste handler in
// TerminalPane; `save` is injected so the logic is unit-testable without Tauri.

export type SaveImage = (dataB64: string, ext: string) => Promise<string>

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

function extFor(f: File): string {
  // Use the name's extension only if it actually has one (a dot past position 0);
  // a clipboard image is often named "clipboard"/"image" with no extension, so
  // fall back to the mime subtype, then png.
  const dot = f.name.lastIndexOf('.')
  const fromName = dot > 0 ? f.name.slice(dot + 1) : ''
  return (fromName || f.type.split('/')[1] || 'png').toLowerCase()
}

/** Persist each File to a temp file, returning their paths in order. A File that
 *  already exposes a real on-disk path (Electron leftover / rare webview) is used
 *  as-is; an unreadable file is skipped rather than aborting the whole batch. */
export async function persistFiles(files: File[], save: SaveImage): Promise<string[]> {
  const paths: string[] = []
  for (const f of files) {
    const p = (f as File & { path?: string }).path
    if (p) {
      paths.push(p)
      continue
    }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      paths.push(await save(bytesToBase64(bytes), extFor(f)))
    } catch {
      /* skip one unreadable file */
    }
  }
  return paths
}

/** Image File objects from a clipboard/drag DataTransfer (empty if none). */
export function imageFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  return Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
}

/** Wrap text in a BRACKETED PASTE (ESC[200~ … ESC[201~).
 *
 *  Not decoration: Claude Code only turns a path into a native `[Image #N]` attachment when it
 *  arrives as a PASTE. The same bytes written plainly stay a literal path in the composer — the
 *  "didn't get shortened" bug. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

/** The extensions Claude Code will attach when it reads the path. Anything else is a file, not
 *  an image, and belongs in the prompt as a path the person can act on. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  return dot > slash + 1 && IMAGE_EXT.has(path.slice(dot + 1).toLowerCase())
}

/** What to write to the pty for a set of dropped REAL PATHS — the drop-anywhere route, which
 *  has no bytes to persist because the files already exist on disk.
 *
 *  Two payloads at most, because the two kinds want opposite treatment:
 *   - images go through a bracketed paste, RAW and unquoted, so Claude Code attaches them as
 *     `[Image #N]` exactly like a drop onto the terminal itself. Quoting here would defeat that;
 *     the path never reaches a shell.
 *   - everything else keeps the plain, shell-quoted write it has always had (the person is
 *     usually about to type a command around it), with the trailing space that separates it
 *     from whatever they type next. */
export function writesForDroppedPaths(paths: string[]): string[] {
  const images = paths.filter(isImagePath)
  const rest = paths.filter((p) => !isImagePath(p))
  const out: string[] = []
  if (images.length) out.push(bracketedPaste(images.join(' ')))
  if (rest.length) out.push(rest.map(shellQuote).join(' ') + ' ')
  return out
}

/** Single-quote a path that carries whitespace, the way a shell needs it. */
function shellQuote(p: string): string {
  return /\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p
}
