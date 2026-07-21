// Generic drag-reorder over anything with a stable id — shared by the roster board
// (reorderRoles) and the sidebar's session reorder. Returns the input unchanged (same
// reference) when the move is a no-op or either id is unknown.
export function reorderByIds<T extends { id: string }>(items: T[], dragId: string, targetId: string, edge: 'before' | 'after'): T[] {
  if (dragId === targetId) return items
  const from = items.findIndex((it) => it.id === dragId)
  const to = items.findIndex((it) => it.id === targetId)
  if (from < 0 || to < 0) return items
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  // Recompute the target index AFTER the removal, so dragging downward lands where
  // the drop line was drawn rather than one slot short.
  let idx = next.findIndex((it) => it.id === targetId)
  if (edge === 'after') idx += 1
  next.splice(idx, 0, moved)
  return next
}
