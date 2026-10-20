/**
 * Card-scoped Rivet AgentOS volumes.
 * Create options match the embedded example fetched 2026-10-20:
 * https://github.com/rivet-dev/agentos/blob/main/examples/embedded/persistence.ts
 * Docs: https://rivet.dev/agentos/docs/persistence/
 * WASM is the guest command ABI (wasm32-wasip1), not a second host VM.
 */

export const AGENTOS_DOCS = {
  fetched: "2026-10-20",
  package: "@rivet-dev/agentos-core",
  packageVersion: "0.4.1",
  urls: [
    "https://rivet.dev/agentos/docs/persistence/",
    "https://rivet.dev/agentos/docs/filesystem/",
    "https://rivet.dev/agentos/docs/embedded/",
    "https://rivet.dev/agentos/docs/quickstart-embedded/",
    "https://rivet.dev/agentos/docs/architecture/compiler-toolchain/",
  ],
} as const

export const AGENTOS_ROUTES = {
  list: "/flow/api/agentos",
  cards: "/flow/api/agentos/cards",
} as const

export type AgentOsPhase = "stopped" | "mounted" | "failed"

export type AgentOsCardView = {
  cardId: string
  phase: AgentOsPhase
  volume: string
  mounted: boolean
  error?: string
  persistence: "sqlite_file+chunked_sqlite"
}

export type AgentOsCreateOptions = {
  database: { type: "sqlite_file"; path: string }
  rootFilesystem: { type: "native"; plugin: { id: "chunked_sqlite"; config: Record<string, never> } }
}

export function durableCreateOptions(sqlitePath: string): AgentOsCreateOptions {
  return {
    database: { type: "sqlite_file", path: sqlitePath },
    rootFilesystem: { type: "native", plugin: { id: "chunked_sqlite", config: {} } },
  }
}
