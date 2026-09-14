import { useEffect, useState } from 'react'
import type { PreviewOverlayTokens } from '../../shared/types'

// Operator's palette, resolved for the page inside the Preview's native inspect view. That page is
// another document and cannot read Operator's CSS variables, so the values are read here and passed
// in. `getComputedStyle` substitutes `var()` references, so `--measure: var(--magenta)` arrives as a
// colour and `--measure-ink` as a `color-mix()` of colours, which the page's Chromium understands.

function readTokens(): PreviewOverlayTokens {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(name).trim()
  return {
    measure: v('--measure'), measureInk: v('--measure-ink'), grid: v('--grid'),
    surface: v('--bg-surface'), fg: v('--fg'), border: v('--border'),
  }
}

/** The tokens, read again whenever the theme changes. `applyTheme` writes the palette onto the root
 *  element's inline style, so a change to that attribute is a change of theme; nothing has to pass
 *  the theme down. Keeps the same object while nothing changed, so a dependent effect does not
 *  re-run. */
export function useOverlayTokens(): PreviewOverlayTokens {
  const [tokens, setTokens] = useState(readTokens)
  useEffect(() => {
    const mo = new MutationObserver(() => {
      const next = readTokens()
      setTokens((prev) => ((Object.keys(next) as (keyof PreviewOverlayTokens)[]).every((k) => prev[k] === next[k]) ? prev : next))
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    return () => mo.disconnect()
  }, [])
  return tokens
}
