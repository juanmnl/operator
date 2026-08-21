// The menu-bar tray icon. Ported from `build_tray` (src-tauri/src/lib.rs:1983-2019) and
// `refresh_tray_menu` (src-tauri/src/transcript.rs:1159-1177) — the Electron port shipped
// without one at all, so 0.17.0 lost the menu bar entirely.
//
// TWO THINGS ARE LOAD-BEARING HERE, and both are the reason this is a module rather than ten
// lines in `index.ts`:
//
//  1. Quit goes through `app.quit()`, never `role: 'quit'`. The role is the same predefined
//     `terminate:` item that bypassed the quit guard under Tauri (see quit.rs / quit.ts) — it
//     ends the process without `before-quit`, which is exactly where `QuitGuard` asks whether
//     the working lanes may be killed. Every lane's pty is a child of this process.
//  2. The icon is a TEMPLATE image: black + alpha, tinted by macOS for the active menu bar and
//     inverted with the appearance. A coloured icon looks wrong in a light menu bar and
//     invisible in a dark one.
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** What the menu needs to know about a lane — the shape `Transcript.liveLanes()` already
 *  returns, narrowed so the label builder can be tested without a tailer. */
export interface TrayLane { terminalId: string; project: string; phase: string }

export interface TrayItem { id: string; label: string; enabled: boolean }

/** The session rows of the menu, as data.
 *
 *  Byte-for-byte the Rust's label: `format!("{}  ·  {}", proj, t.last_phase)` — two spaces
 *  around a middle dot, and the RAW phase word, not a prettified one. The rows are sorted by id
 *  so a lane cannot swap places in the menu between two refreshes for no reason; the Rust sorts
 *  the same tuples for the same reason.
 *
 *  "No active sessions" is disabled rather than clickable. Under Tauri it was a normal item
 *  whose id matched no handler, so it already did nothing — this just says so. */
export function trayLaneItems(lanes: TrayLane[]): TrayItem[] {
  if (!lanes.length) return [{ id: 'none', label: 'No active sessions', enabled: false }]
  return lanes
    .map((l) => ({ id: `session:${l.terminalId}`, label: `${l.project}  ·  ${l.phase}`, enabled: true }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export interface TrayDeps {
  /** Show and focus the main window, recreating it if it is gone — the same answer `activate`
   *  gives, because the window CAN be gone: closing it is not quitting on macOS. */
  showWindow: () => void
  /** `app.quit()`, which fires `before-quit` where the guard vetoes. Injected so the test can
   *  see that the tray asks to quit rather than terminating. */
  quit: () => void
}

export interface OperatorTray {
  refresh: (lanes: TrayLane[]) => void
  setImage: (image: Electron.NativeImage) => void
  destroy: () => void
}

/** The tray icon's source PNG.
 *
 *  `src-tauri/icons/tray.png` (44×44 @2x, black + alpha) is the ONE copy in the repo; the Rust
 *  `include_bytes!`s it and `scripts/build-main.mjs` copies it beside the bundles, exactly as it
 *  already does for `preview-inspector.js`. Read as BYTES, not `createFromPath`: in the packaged
 *  app this path is inside `app.asar`, which Electron's patched `fs` can read and native file
 *  loaders cannot be relied on to. */
function trayImage(): Electron.NativeImage {
  // `__dirname` is `out/main` in both dev and the packaged bundle (the main bundle is CJS).
  const buf = readFileSync(join(__dirname, '..', 'tray.png'))
  const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 })
  img.setTemplateImage(true)
  return img
}

/** Build the tray and return the handle the tailer refreshes.
 *
 *  Not called on the `--mcp-serve` path: that process never opens a window and must not put an
 *  icon in the menu bar. */
export function createTray(deps: TrayDeps): OperatorTray {
  const tray = new Tray(trayImage())
  tray.setToolTip('Operator')

  const build = (lanes: TrayLane[]): Menu => {
    const template: MenuItemConstructorOptions[] = [
      { label: 'Show Operator', click: () => deps.showWindow() },
      { type: 'separator' },
      ...trayLaneItems(lanes).map((i): MenuItemConstructorOptions => ({
        label: i.label,
        enabled: i.enabled,
        // A session row focuses the app — the same answer `show` gives. Under Tauri it could not
        // do more (the tray has no way to select a lane in the renderer) and neither can this.
        click: i.enabled ? () => deps.showWindow() : undefined,
      })),
      { type: 'separator' },
      // NOT `role: 'quit'`. See the header.
      { label: 'Quit Operator', click: () => deps.quit() },
    ]
    return Menu.buildFromTemplate(template)
  }

  // On macOS a tray with a context menu opens it on left click too, which is what
  // `show_menu_on_left_click(true)` bought under Tauri.
  tray.setContextMenu(build([]))

  return {
    refresh: (lanes) => { if (!tray.isDestroyed()) tray.setContextMenu(build(lanes)) },
    setImage: (image) => { if (!tray.isDestroyed()) tray.setImage(image) },
    destroy: () => { if (!tray.isDestroyed()) tray.destroy() },
  }
}
