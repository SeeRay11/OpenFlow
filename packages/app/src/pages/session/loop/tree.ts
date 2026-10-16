import type { Session } from "@opencode-ai/sdk/v2"

export type SessionTreeNode = {
  session: Session
  depth: number
  children: SessionTreeNode[]
}

export type SessionTree = {
  root?: SessionTreeNode
  nodes: SessionTreeNode[]
  total: number
  truncated: boolean
}

export const SESSION_TREE_MAX_NODES = 50

const newestFirst = (a: Session, b: Session) => b.time.created - a.time.created

/**
 * Builds the subagent hierarchy below `rootID` as a DFS-flattened node list.
 *
 * - Root sits at depth 0; every direct or transitive child below it follows.
 * - Orphans (parentID set but parent absent from `sessions`) attach to the
 *   root cluster at depth 1, since their parent chain is unresolvable here.
 * - Siblings are sorted newest-first (`time.created` descending).
 * - `max` caps the flattened node list; `total` still counts every session in
 *   the cluster and `truncated` reports whether the cap hit.
 * - A cycle guard breaks parent loops defensively; cycle members are skipped.
 */
export function buildSessionTree(input: { rootID: string; sessions: Session[]; max?: number }): SessionTree {
  const max = input.max ?? SESSION_TREE_MAX_NODES
  const byID = new Map(input.sessions.map((session) => [session.id, session]))
  const rootSession = byID.get(input.rootID)
  const empty: SessionTree = { nodes: [], total: 0, truncated: false }
  if (!rootSession) return empty

  const childrenOf = new Map<string, Session[]>()
  const orphans: Session[] = []
  for (const session of input.sessions) {
    if (session.id === input.rootID) continue
    if (session.parentID && byID.has(session.parentID)) {
      const siblings = childrenOf.get(session.parentID) ?? []
      siblings.push(session)
      childrenOf.set(session.parentID, siblings)
    } else if (session.parentID) {
      orphans.push(session)
    }
  }
  childrenOf.set(input.rootID, [...(childrenOf.get(input.rootID) ?? []), ...orphans])

  // `total` counts the whole reachable cluster up front — independent of the
  // node cap. The walk below stops early once `max` nodes are collected, so a
  // cap hitting an inner node must not undercount its descendants.
  const counted = new Set<string>([input.rootID])
  const queue = [input.rootID]
  while (queue.length > 0) {
    const id = queue.pop()!
    for (const child of childrenOf.get(id) ?? []) {
      if (!counted.has(child.id)) {
        counted.add(child.id)
        queue.push(child.id)
      }
    }
  }
  const total = counted.size

  const nodes: SessionTreeNode[] = []
  const visited = new Set<string>()
  let truncated = false

  const walk = (session: Session, depth: number): SessionTreeNode | undefined => {
    if (visited.has(session.id)) return undefined
    visited.add(session.id)
    if (nodes.length >= max) {
      truncated = true
      return undefined
    }
    const node: SessionTreeNode = { session, depth, children: [] }
    nodes.push(node)
    const siblings = [...(childrenOf.get(session.id) ?? [])].sort(newestFirst)
    for (const child of siblings) {
      const childNode = walk(child, depth + 1)
      if (childNode) node.children.push(childNode)
    }
    return node
  }

  const root = walk(rootSession, 0)
  return { root, nodes, total, truncated }
}
