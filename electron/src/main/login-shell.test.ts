import { describe, it, expect, afterEach } from 'vitest'
import { loginShell } from './login-shell'

const SHELL = process.env.SHELL

describe('loginShell', () => {
  afterEach(() => { if (SHELL === undefined) delete process.env.SHELL; else process.env.SHELL = SHELL })

  it('is the USER\'S shell — the one that reads their rc file and knows their PATH', () => {
    process.env.SHELL = '/opt/homebrew/bin/fish'
    expect(loginShell()).toBe('/opt/homebrew/bin/fish')
  })

  it('falls back to zsh, macOS\'s default — never /bin/sh, which reads ~/.profile and not ~/.zshrc', () => {
    delete process.env.SHELL
    expect(loginShell()).toBe('/bin/zsh')
    expect(loginShell()).not.toBe('/bin/sh')
  })

  it('is read at call time, so a changed SHELL is answered rather than remembered', () => {
    process.env.SHELL = '/bin/bash'
    expect(loginShell()).toBe('/bin/bash')
    process.env.SHELL = '/bin/zsh'
    expect(loginShell()).toBe('/bin/zsh')
  })

  it('an empty SHELL is not a shell', () => {
    process.env.SHELL = ''
    expect(loginShell()).toBe('/bin/zsh')
  })
})
