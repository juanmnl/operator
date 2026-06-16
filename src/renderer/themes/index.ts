import type { ITheme } from '@xterm/xterm'
import { mrPinkXterm, mrPinkVars } from './mr-pink'
import { nineteen84Xterm, nineteen84Vars } from './1984'
import { lightXterm, lightVars } from './light'
import { missionControlXterm, missionControlVars } from './mission-control'

export interface OperatorTheme {
  name: string
  xterm: ITheme
  vars: Record<string, string>
  isDark: boolean
}

const mrPink: OperatorTheme = { name: 'Mr Pink', xterm: mrPinkXterm, vars: mrPinkVars, isDark: true }
const og1984: OperatorTheme = { name: '1984', xterm: nineteen84Xterm, vars: nineteen84Vars, isDark: true }
const light: OperatorTheme = { name: 'Light', xterm: lightXterm, vars: lightVars, isDark: false }
const missionControl: OperatorTheme = { name: 'Mission Control', xterm: missionControlXterm, vars: missionControlVars, isDark: true }

export const themes: Record<string, OperatorTheme> = {
  'mr-pink': mrPink,
  '1984': og1984,
  'light': light,
  'mission-control': missionControl,
}

export const defaultTheme = missionControl

export function applyTheme(theme: OperatorTheme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value)
  }
}
