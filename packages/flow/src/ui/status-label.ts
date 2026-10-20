import type { NodeStatus } from "../graph/types"

export function statusLabel(status: NodeStatus) {
  switch (status) {
    case "queued":
      return "starting"
    case "done":
      return "succeeded"
    case "error":
      return "failed"
    case "skipped":
      return "blocked"
    default:
      return status
  }
}
