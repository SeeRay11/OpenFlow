/**
 * Agent Substrate shared memory as a host module: cards read the project's memory
 * before they start and write a redacted outcome when they finish. See
 * `shared/memory.ts` for the scope policy and `memory.ts` for the behaviour.
 */
import type {
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryReadRequest,
  MemoryReadResult,
  MemoryStatus,
  MemoryWriteRequest,
  MemoryWriteResult,
} from "../../shared/memory"
import type { HostHandler } from "../host/respond"
import type { SubstrateDeps } from "./memory"
import { createMemory } from "./memory"
import { createRoutes } from "./routes"
import { createRunGraphs } from "./run-graph"

export type { SubstrateDeps } from "./memory"

export type SubstrateModule = {
  handle: HostHandler
  status(): Promise<MemoryStatus>
  read(request: MemoryReadRequest): Promise<MemoryReadResult>
  write(request: MemoryWriteRequest): Promise<MemoryWriteResult>
  forget(request: MemoryForgetRequest): Promise<MemoryForgetResult>
  /** The run's Graph ID (`ut-<ts36>-<8hex>`), minted on first use; what `MemoryInfo.graphId` shows. */
  graphId(runId: string): string
  dispose(): Promise<void>
}

export function createSubstrate(deps: SubstrateDeps): SubstrateModule {
  const memory = createMemory({ ...deps, runGraphs: createRunGraphs({ now: deps.now ?? Date.now }) })
  return {
    handle: createRoutes(memory),
    status: memory.status,
    read: memory.read,
    write: memory.write,
    forget: memory.forget,
    graphId: memory.graphId,
    dispose: memory.dispose,
  }
}
