import { describe, it, expect } from 'vitest'
import { themeKey, resolveThemeKey, themes } from './index'

describe('themeKey', () => {
  it('joins identity and mode', () => {
    expect(themeKey('mr-pink', 'dark')).toBe('mr-pink-dark')
    expect(themeKey('mission-control', 'light')).toBe('mission-control-light')
  })
})

describe('resolveThemeKey', () => {
  it('passes through a currently-valid key', () => {
    expect(resolveThemeKey('1984-dark')).toBe('1984-dark')
    expect(themes['1984-dark']).toBeDefined()
  })

  it('migrates pre-split identity-only keys', () => {
    expect(resolveThemeKey('mission-control')).toBe('mission-control-dark')
    expect(resolveThemeKey('1984')).toBe('1984-dark')
  })

  it('migrates the removed Light identity to Mission Control, preserving mode', () => {
    expect(resolveThemeKey('light')).toBe('mission-control-light')
    expect(resolveThemeKey('light-dark')).toBe('mission-control-dark')
    expect(resolveThemeKey('light-light')).toBe('mission-control-light')
  })

  it('falls back to the default for null/unknown', () => {
    expect(resolveThemeKey(null)).toBe('mission-control-dark')
    expect(resolveThemeKey(undefined)).toBe('mission-control-dark')
    expect(resolveThemeKey('nope')).toBe('mission-control-dark')
    expect(resolveThemeKey('')).toBe('mission-control-dark')
  })
})
