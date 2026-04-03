import type { ITheme } from '@xterm/xterm'
import { mrPinkXterm, mrPinkVars } from './mr-pink'
import { nineteen84Xterm, nineteen84Vars } from './1984'

export interface OperatorTheme {
  name: string
  xterm: ITheme
  vars: Record<string, string>
}

const mrPink: OperatorTheme = { name: 'Mr Pink', xterm: mrPinkXterm, vars: mrPinkVars }
const og1984: OperatorTheme = { name: '1984', xterm: nineteen84Xterm, vars: nineteen84Vars }

export const themes: Record<string, OperatorTheme> = {
  'mr-pink': mrPink,
  '1984': og1984,
}

export const defaultTheme = mrPink

export function applyTheme(theme: OperatorTheme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value)
  }
}
