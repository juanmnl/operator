import * as pty from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { ManagedTerminal, IPC } from '../../shared/types'
import { WindowManager } from '../window/window-manager'

interface PtyEntry {
  id: string
  process: pty.IPty
  cwd: string
  command: string
  sessionId?: string
}

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()
  private windowManager: WindowManager
  private onExitCallback?: (terminalId: string) => void

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager
  }

  onTerminalExitHook(callback: (terminalId: string) => void): void {
    this.onExitCallback = callback
  }

  spawn(cwd: string, command: string, args: string[] = [], env?: Record<string, string>): string {
    const id = uuidv4()
    const shell = command || process.env.SHELL || '/bin/zsh'

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        ...env,
        OPERATOR_TERMINAL_ID: id,
        TERM: 'xterm-256color',
      } as Record<string, string>,
    })

    const entry: PtyEntry = { id, process: ptyProcess, cwd, command: shell }
    this.ptys.set(id, entry)

    ptyProcess.onData((data) => {
      this.windowManager.sendToMain(IPC.TERMINAL_DATA, id, data)
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.windowManager.sendToMain(IPC.TERMINAL_EXIT, id, exitCode, signal)
      this.onExitCallback?.(id)
      this.ptys.delete(id)
    })

    return id
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.ptys.get(id)?.process.resize(cols, rows)
  }

  kill(id: string): void {
    const entry = this.ptys.get(id)
    if (entry) {
      entry.process.kill()
      this.ptys.delete(id)
    }
  }

  linkSession(terminalId: string, sessionId: string): void {
    const entry = this.ptys.get(terminalId)
    if (entry) entry.sessionId = sessionId
  }

  list(): ManagedTerminal[] {
    return Array.from(this.ptys.values()).map((e) => ({
      id: e.id,
      pid: e.process.pid,
      cwd: e.cwd,
      command: e.command,
      sessionId: e.sessionId,
      alive: true,
    }))
  }

  get(id: string): PtyEntry | undefined {
    return this.ptys.get(id)
  }

  killAll(): void {
    this.ptys.forEach((entry) => {
      entry.process.kill()
    })
    this.ptys.clear()
  }
}
