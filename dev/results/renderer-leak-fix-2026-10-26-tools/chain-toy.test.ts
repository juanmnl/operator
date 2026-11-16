// Toy model of the DashboardView render chain. Not part of the suite: copy it to
// src/renderer/lib/zz-chain-toy.test.ts, run `npx vitest run src/renderer/lib/zz-chain-toy.test.ts`,
// then delete the copy. Prints how many of 200 data arrays (one per "session event") are still
// reachable after forced GC. Measured 2026-10-26 on Node 26.12.1 / React 19:
//   old, one rare class: 40   fixed, one rare class: 2   old, two rare classes: 80   fixed, two rare classes: 80
import { it, expect } from 'vitest'
import { act, createElement as h, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import v8 from 'node:v8'
import vm from 'node:vm'

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void

let setData: (x: number[]) => void = () => {}
let setOther: (x: number) => void = () => {}
let setThird: (x: number) => void = () => {}
let sink: unknown
let g: unknown

// f: recreated on every data change (focusTerminal). r: recreated on a "lane switch" (setPanelOpen) and held
// by the fiber (the togglePanel prop). p: a second rare set (the roleOf family, on projects changes). `g` is
// any closure in the body that names them, which puts them in the render's shared context.
function Old() {
  const [data, sd] = useState<number[]>(() => []); const [other, so] = useState(0); const [third, st] = useState(0)
  setData = sd; setOther = so; setThird = st
  const f = useCallback(() => data.length, [data])
  const r = useCallback(() => other, [other])
  const p = useCallback(() => third, [third])
  g = () => f() + r() + p()
  sink = r
  return null
}
function Fixed() {
  const [data, sd] = useState<number[]>(() => []); const [other, so] = useState(0); const [third, st] = useState(0)
  setData = sd; setOther = so; setThird = st
  const dataRef = useRef(data); dataRef.current = data
  const f = useCallback(() => dataRef.current.length, [])
  const r = useCallback(() => other, [other])
  const p = useCallback(() => third, [third])
  g = () => f() + r() + p() + data.length
  sink = r
  return null
}

async function run(C: () => null, thirdEvery: boolean) {
  const refs: WeakRef<number[]>[] = []
  const root = createRoot(document.createElement('div'))
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  act(() => root.render(h(C)))
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 5; j++) {
      const arr = new Array(1000).fill(i * 10 + j); refs.push(new WeakRef(arr))
      act(() => setData(arr))
      if (thirdEvery && j === 2) act(() => setThird(i + 1))
    }
    act(() => setOther(i + 1))
  }
  for (let k = 0; k < 5; k++) { gc(); await new Promise((res) => setTimeout(res, 5)) }
  const alive = refs.filter((r) => r.deref()).length
  act(() => root.unmount())
  return alive
}

it('chain', async () => {
  console.log('old, one rare class:', await run(Old, false))
  console.log('fixed, one rare class:', await run(Fixed, false))
  console.log('old, two rare classes:', await run(Old, true))
  console.log('fixed, two rare classes:', await run(Fixed, true))
  expect(sink && g).toBeDefined()
})
