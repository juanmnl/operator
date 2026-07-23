import type { Terminal } from '@xterm/xterm'

// A minimal lookup from terminalId → the live xterm.js Terminal instance.
//
// TerminalPane owns each Terminal in a local ref and never exposed it, so there
// was no way for app-level code (e.g. the ⌘K "Dump terminal buffer" diagnostic)
// to reach the SAME instance that's rendering — and reading the buffer requires
// the live object, not a second Terminal. TerminalPane registers on create and
// unregisters on dispose; consumers do a read-only walk of buffer.active. This
// is purely a handle registry: it changes nothing about how the terminal renders.
const registry = new Map<string, Terminal>()

export function registerTerminal(id: string, term: Terminal): void {
  registry.set(id, term)
}

export function unregisterTerminal(id: string): void {
  registry.delete(id)
}

export function getTerminal(id: string): Terminal | undefined {
  return registry.get(id)
}
