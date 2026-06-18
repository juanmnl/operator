import type { ITheme } from '@xterm/xterm'
import { mrPinkXterm, mrPinkVars } from './mr-pink'
import { mrPinkLightXterm, mrPinkLightVars } from './mr-pink-light'
import { nineteen84Xterm, nineteen84Vars } from './1984'
import { nineteen84LightXterm, nineteen84LightVars } from './1984-light'
import { missionControlXterm, missionControlVars } from './mission-control'
import { missionControlLightXterm, missionControlLightVars } from './mission-control-light'

export type ThemeMode = 'light' | 'dark'

export interface OperatorTheme {
  /** Identity display name, e.g. 'Mission Control'. */
  name: string
  /** Identity id, stable across modes, e.g. 'mission-control'. */
  identity: string
  mode: ThemeMode
  xterm: ITheme
  vars: Record<string, string>
  isDark: boolean
}

type Palette = { xterm: ITheme; vars: Record<string, string> }
interface Identity {
  id: string
  name: string
  dark: Palette
  light: Palette
}

// Each theme is an identity (accent/hue) with a light AND a dark palette. The
// picker selects the identity; the light/dark toggle swaps the mode within it.
const IDENTITIES: Identity[] = [
  {
    id: 'mission-control', name: 'Mission Control',
    dark: { xterm: missionControlXterm, vars: missionControlVars },
    light: { xterm: missionControlLightXterm, vars: missionControlLightVars },
  },
  {
    id: 'mr-pink', name: 'Mr Pink',
    dark: { xterm: mrPinkXterm, vars: mrPinkVars },
    light: { xterm: mrPinkLightXterm, vars: mrPinkLightVars },
  },
  {
    id: '1984', name: '1984',
    dark: { xterm: nineteen84Xterm, vars: nineteen84Vars },
    light: { xterm: nineteen84LightXterm, vars: nineteen84LightVars },
  },
  // The standalone 'Light' identity was removed — every identity has a light/dark
  // toggle, so it was redundant. Saved 'light-*' keys migrate below.
]

export interface ThemeIdentity { id: string; name: string }
export const identities: ThemeIdentity[] = IDENTITIES.map(({ id, name }) => ({ id, name }))

export function themeKey(identity: string, mode: ThemeMode): string {
  return `${identity}-${mode}`
}

function buildThemes(): Record<string, OperatorTheme> {
  const out: Record<string, OperatorTheme> = {}
  for (const idn of IDENTITIES) {
    out[themeKey(idn.id, 'dark')] = { name: idn.name, identity: idn.id, mode: 'dark', isDark: true, ...idn.dark }
    out[themeKey(idn.id, 'light')] = { name: idn.name, identity: idn.id, mode: 'light', isDark: false, ...idn.light }
  }
  return out
}

export const themes: Record<string, OperatorTheme> = buildThemes()

export const defaultTheme = themes['mission-control-dark']

// Pre-light/dark-split, localStorage held identity-only keys. Map them forward so
// existing installs don't reset to the default on upgrade.
const LEGACY_KEYS: Record<string, string> = {
  'mission-control': 'mission-control-dark',
  'mr-pink': 'mr-pink-dark',
  '1984': '1984-dark',
  // Removed 'Light' identity → migrate to Mission Control, preserving mode.
  'light': 'mission-control-light',
  'light-light': 'mission-control-light',
  'light-dark': 'mission-control-dark',
}

export function resolveThemeKey(saved: string | null | undefined): string {
  if (saved && themes[saved]) return saved
  if (saved && LEGACY_KEYS[saved]) return LEGACY_KEYS[saved]
  return 'mission-control-dark'
}

export function applyTheme(theme: OperatorTheme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value)
  }
}
