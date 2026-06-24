// Build a nesting tree from the flat activity timeline (best-effort, heuristic):
// a delegation owns the subagent it spawns, and a SubagentStart opens a group
// that subsequent tool calls nest into until the matching SubagentStop. With
// parallel subagents this is LIFO and may mis-attribute siblings — it's an
// approximation, since hooks don't tag tool calls with a subagent id. Extracted
// from SessionActivityView so the stack logic is unit-testable.

export interface TreeNode<T> { entry: T; children: TreeNode<T>[] }

export function buildActivityTree<T extends { kind?: string; toolName: string }>(activity: T[]): TreeNode<T>[] {
  const root: TreeNode<T>[] = []
  const stack: TreeNode<T>[][] = [root] // top of stack = current insertion list
  let pendingDelegate: TreeNode<T> | null = null

  for (const entry of activity) {
    const current = stack[stack.length - 1]

    if (entry.kind === 'subagent') {
      if (entry.toolName.includes('finished')) {
        if (stack.length > 1) stack.pop() // close the most recent group
        pendingDelegate = null
        continue
      }
      // SubagentStart — open a group, nested under the delegation that spawned it if any.
      const node: TreeNode<T> = { entry, children: [] }
      if (pendingDelegate) { pendingDelegate.children.push(node); pendingDelegate = null }
      else current.push(node)
      stack.push(node.children)
      continue
    }

    const node: TreeNode<T> = { entry, children: [] }
    current.push(node)
    pendingDelegate = entry.kind === 'delegate' ? node : null
  }
  return root
}
