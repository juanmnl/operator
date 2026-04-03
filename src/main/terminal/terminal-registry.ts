export class TerminalRegistry {
  private terminalToSession = new Map<string, string>()
  private sessionToTerminal = new Map<string, string>()

  link(terminalId: string, sessionId: string): void {
    this.terminalToSession.set(terminalId, sessionId)
    this.sessionToTerminal.set(sessionId, terminalId)
  }

  getSessionId(terminalId: string): string | undefined {
    return this.terminalToSession.get(terminalId)
  }

  getTerminalId(sessionId: string): string | undefined {
    return this.sessionToTerminal.get(sessionId)
  }

  unlink(terminalId: string): void {
    const sessionId = this.terminalToSession.get(terminalId)
    if (sessionId) this.sessionToTerminal.delete(sessionId)
    this.terminalToSession.delete(terminalId)
  }
}
