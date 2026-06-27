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
