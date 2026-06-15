import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import { queue } from './queue'
import { sessions } from './sessions'
import { WindowManager } from './window/window-manager'

let tray: Tray | null = null
let windowMgr: WindowManager | null = null

export function createTray(wm: WindowManager): void {
  windowMgr = wm
  const iconPath = join(__dirname, '../../assets/logos/trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Operator')
  tray.setContextMenu(buildMenu())
}

export function updateTrayBadge(): void {
  const count = queue.size
  if (tray) {
    tray.setTitle(count > 0 ? ` ${count}` : '')
    tray.setContextMenu(buildMenu())
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'running': return 'running'
    case 'compacting': return 'compacting'
    case 'idle': return 'idle'
    default: return phase
  }
}

function buildMenu(): Menu {
  const count = queue.size
  const active = sessions.getActive()

  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Show Operator',
      click: () => windowMgr?.showMainWindow(),
    },
    { type: 'separator' },
    {
      label: count > 0 ? `${count} pending request${count > 1 ? 's' : ''}` : 'No pending requests',
      enabled: false,
    },
    { type: 'separator' },
  ]

  if (active.length > 0) {
    items.push({ label: `${active.length} active session${active.length > 1 ? 's' : ''}`, enabled: false })
    for (const s of active) {
      const pending = s.entries.filter((e) => !e.response).length
      const badge = pending > 0 ? ` · ${pending} pending` : ''
      const subs = s.activeSubagents > 0 ? ` · ${s.activeSubagents} subagent${s.activeSubagents > 1 ? 's' : ''}` : ''
      items.push({
        label: `  ${s.projectName} — ${phaseLabel(s.phase)}${subs}${badge}`,
        enabled: false,
      })
    }
    items.push({ type: 'separator' })
  }

  items.push(
    { label: 'Server: localhost:47821', enabled: false },
    { type: 'separator' },
    { label: 'Quit Operator', click: () => app.quit() }
  )

  return Menu.buildFromTemplate(items)
}
