import type { PermissionReply } from "../../../shared/engine"

/**
 * The scripting vocabulary the engine contract (`src/server/engine-contract.ts`)
 * speaks, shared by everything that has to act it out: the in-memory
 * `createFakeEngine` plays a script directly, the Omp host test turns it into
 * frames for the stub omp. No runtime dependencies, so either side may import it.
 */

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** What a step reports when its script names no usage. */
export const DEFAULT_USAGE: Usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 }

export type ToolScript = { id: string; name: string; input: Record<string, unknown>; output: string }

export type PermissionAsk = { kind: "permission"; id: string; action: string; resource: string }

export type QuestionAsk = { kind: "question"; id: string; question: string; header: string; options: string[] }

/** What the model does in one assistant message. */
export type StepScript = {
  text?: string
  /** Tokens omp reports for the step. Default `DEFAULT_USAGE`. */
  usage?: Usage
  /** Tool calls the message makes; they run once the message has ended. */
  tools?: ToolScript[]
  notice?: { level: "info" | "error"; message: string }
  /** Asked while the message is open; the turn waits for the answer, a rejection or an interrupt. */
  ask?: PermissionAsk | QuestionAsk
  /** The message takes this long to finish. */
  delayMs?: number
  /** The message never finishes by itself: only an interrupt ends the turn. */
  hang?: boolean
}

/** One turn: its messages in order, then a clean finish, or a provider error. */
export type TurnScript = { steps: StepScript[]; error?: { message: string; status?: number } }

/** What the agent was told in answer to an ask, as the implementation under test saw it. */
export type Decision =
  | { kind: "permission"; reply: PermissionReply }
  | { kind: "question"; answers: string[][] }
  | { kind: "cancelled" }

/**
 * Makes an implementation do what a scenario describes. A small adapter, not a
 * second API: `script` decides what every prompt sent from now on does, and
 * `decision` reports what reached the agent.
 */
export interface ContractDriver {
  script(turn: TurnScript): void | Promise<void>
  /** The answer the agent received for request `id`; `undefined` while none has arrived. */
  decision(requestID: string): Promise<Decision | undefined>
  /**
   * Holds every `createSession` that reaches the implementation from now on at its startup, before a session exists,
   * until the returned hold is released. Optional: a leg that cannot hold a start leaves it out and the scenarios that
   * need it are registered as skipped by name (`ContractOptions.holdsStartup`).
   */
  holdStartup?(): StartupHold
}

/** A held startup: `reached` resolves once a create is waiting at the hold, `release` lets held and later creates go on. */
export interface StartupHold {
  reached(): Promise<void>
  release(): void
}
