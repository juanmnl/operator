// WHICH PORT WINDOWS THIS OPERATOR HANDS OUT — the one place the numbers live.
//
// A dev instance of Operator (an unpackaged build, or any build pointed at a non-default
// OPERATOR_DIR) keeps its own `dev-leases.json`, so it cannot see the installed app's reservations.
// Allocating from the same windows, it handed a test lane :1422, which a live mantel lane in the
// installed app had been given that week: a reservation whose server was not running at that
// moment passes any bind test, and only the lease file knows about it. Separate, non-overlapping
// windows make the two instances unable to pick the same number at all; the bind test in the
// allocators (port-alloc.ts `scan`, preview-cdp-port.ts `allocateCdpPort`) stays as the second
// guard, for everything that is not an Operator.
//
//                    dev servers (OPERATOR_DEV_PORT)   Electron CDP (OPERATOR_CDP_PORT)
//   installed app    1420–1520                          9340–9440
//   dev instance     1620–1720                          9540–9640
//   `npm run dev`    its own renderer: 1610 by default (OPERATOR_ELECTRON_PORT), outside both
//
// The dev windows are the installed ones moved up by 200 and the same width, so a number says which
// kind of instance handed it out.
import { resolve } from 'node:path'

export interface PortRange { base: number; max: number }
export interface PortRanges { dev: PortRange; cdp: PortRange; isolated: boolean }

export const INSTALLED_RANGES: PortRanges = { dev: { base: 1420, max: 1520 }, cdp: { base: 9340, max: 9440 }, isolated: false }
export const DEV_INSTANCE_RANGES: PortRanges = { dev: { base: 1620, max: 1720 }, cdp: { base: 9540, max: 9640 }, isolated: true }

/** Default for `npm run dev`'s own Vite renderer (scripts/dev.mjs, vite.config.ts): outside both
 *  sets of windows, so a hand-started dev build cannot take a port either instance hands a lane. */
export const DEV_RENDERER_DEFAULT_PORT = 1610

/** Is this an instance that must stay out of the installed app's windows? Unpackaged, or pointed at
 *  an OPERATOR_DIR other than the default. Pure. */
export function isDevInstance(o: { isPackaged: boolean; operatorDir: string; defaultOperatorDir: string }): boolean {
  if (!o.isPackaged) return true
  return resolve(o.operatorDir) !== resolve(o.defaultOperatorDir)
}

export function portRangesFor(o: { isPackaged: boolean; operatorDir: string; defaultOperatorDir: string }): PortRanges {
  return isDevInstance(o) ? DEV_INSTANCE_RANGES : INSTALLED_RANGES
}

export const rangesOverlap = (a: PortRange, b: PortRange): boolean => a.base <= b.max && b.base <= a.max
