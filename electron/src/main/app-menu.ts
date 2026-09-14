// The application menu. Until now the app set none, so Electron installed its default one. This
// rebuilds that default role by role, so ⌘C/⌘V/⌘A, ⌘W, ⌘Q, reload and zoom behave exactly as
// they did, and adds View items for the Preview.
//
// WHY A MENU AND NOT A KEYDOWN LISTENER: keys go to the focused frame. Once the user clicks into
// the previewed page (a cross-origin iframe, or the native inspect view) the window's `keydown`
// handler never sees them, so a Preview shortcut would work only until it was needed. A menu
// accelerator reaches the app whichever frame has focus, as long as nothing calls
// `preventDefault` on the key first. The renderer therefore never handles these chords itself:
// it declines them in the terminal (`isAppChord`) and waits for `onMenuCommand`.
import type { MenuItemConstructorOptions } from 'electron'

/** What a View-menu item asks the renderer to do. Mirrors `onMenuCommand` in env.d.ts. */
export type MenuCommand = 'toggle-grid'

export function appMenuTemplate(send: (command: MenuCommand) => void, isMac = process.platform === 'darwin'): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Show or Hide Layout Grid', accelerator: "CmdOrCtrl+'", click: () => send('toggle-grid') },
        { type: 'separator' },
        // The rest of Electron's default View menu, unchanged.
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
}
