// Recompute fan-out badge membership from the terminals still open, rather than
// the count baked in at launch: closing siblings shrinks the total, and a lone
// survivor drops the badge entirely (a "1 of 1" fan-out isn't one). Extracted
// from DashboardView's render so the membership math has a unit test.

export interface FanTerminal {
  id: string
  effortLevel?: string
  fanGroup?: string
  fanIndex?: number
}

export interface FanMembership {
  effortLevels: Record<string, string>
  fanInfo: Record<string, { index: number; total: number }>
}

export function computeFanMembership(terminals: FanTerminal[]): FanMembership {
  const effortLevels: Record<string, string> = {}
  const fanInfo: Record<string, { index: number; total: number }> = {}
  const fanGroups: Record<string, FanTerminal[]> = {}
  for (const t of terminals) {
    if (t.effortLevel) effortLevels[t.id] = t.effortLevel
    if (t.fanGroup) (fanGroups[t.fanGroup] ??= []).push(t)
  }
  for (const members of Object.values(fanGroups)) {
    if (members.length < 2) continue // lone survivor → no fan-out badge
    members.sort((a, b) => (a.fanIndex ?? 0) - (b.fanIndex ?? 0))
    members.forEach((t, i) => { fanInfo[t.id] = { index: i + 1, total: members.length } })
  }
  return { effortLevels, fanInfo }
}
