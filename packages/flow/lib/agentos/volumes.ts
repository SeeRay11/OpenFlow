import fs from "node:fs/promises"
import path from "node:path"
import { durableCreateOptions, type AgentOsCardView, type AgentOsCreateOptions } from "../../shared/agentos"
import { cardVolumePath, safeCardId } from "./paths"

export type AgentOsFilesystem = {
  writeFile(file: string, data: string | Uint8Array): Promise<void>
  readFile(file: string): Promise<Uint8Array>
}

export type AgentOsVm = {
  filesystem: AgentOsFilesystem
  dispose(): Promise<void>
}

export type AgentOsFactory = {
  create(options: AgentOsCreateOptions): Promise<AgentOsVm>
}

type Live = { vm: AgentOsVm; volume: string; error?: string; phase: AgentOsCardView["phase"] }

/** Lifecycle over the card volumes the routes expose. One instance per host. */
export type VolumeManager = {
  view(cardId: string): AgentOsCardView
  list(): AgentOsCardView[]
  start(cardId: string): Promise<AgentOsCardView>
  stop(cardId: string): Promise<AgentOsCardView>
  restart(cardId: string): Promise<AgentOsCardView>
  destroy(cardId: string, confirm: boolean): Promise<AgentOsCardView>
  writeFile(cardId: string, file: string, data: string): Promise<void>
  readFile(cardId: string, file: string): Promise<string>
  dispose(): Promise<void>
}

export function createVolumes(options: { env?: NodeJS.ProcessEnv; factory: AgentOsFactory }): VolumeManager {
  const env = options.env ?? process.env
  const live = new Map<string, Live>()

  function view(cardId: string): AgentOsCardView {
    const id = safeCardId(cardId)
    const row = live.get(id)
    return {
      cardId: id,
      phase: row?.phase ?? "stopped",
      volume: cardVolumePath(id, env),
      mounted: row?.phase === "mounted",
      error: row?.error,
      persistence: "sqlite_file+chunked_sqlite",
    }
  }

  async function start(cardId: string): Promise<AgentOsCardView> {
    const id = safeCardId(cardId)
    const volume = cardVolumePath(id, env)
    await fs.mkdir(path.dirname(volume), { recursive: true })
    if (live.get(id)?.phase === "mounted") return view(id)
    try {
      const vm = await options.factory.create(durableCreateOptions(volume))
      live.set(id, { vm, volume, phase: "mounted" })
    } catch (error) {
      live.set(id, {
        vm: { filesystem: { async writeFile() {}, async readFile() { return new Uint8Array() } }, async dispose() {} },
        volume,
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return view(id)
  }

  async function stop(cardId: string): Promise<AgentOsCardView> {
    const id = safeCardId(cardId)
    const row = live.get(id)
    if (row) {
      await row.vm.dispose().catch(() => undefined)
      live.set(id, { ...row, phase: "stopped" })
    }
    return view(id)
  }

  async function restart(cardId: string) {
    await stop(cardId)
    return start(cardId)
  }

  async function destroy(cardId: string, confirm: boolean) {
    const id = safeCardId(cardId)
    if (!confirm) throw new Error("deleting a card volume requires confirm: true")
    const row = live.get(id)
    if (row) await row.vm.dispose().catch(() => undefined)
    live.delete(id)
    await fs.rm(cardVolumePath(id, env), { force: true })
    return view(id)
  }

  async function writeFile(cardId: string, file: string, data: string) {
    const id = safeCardId(cardId)
    const row = live.get(id)
    if (!row || row.phase !== "mounted") throw new Error(`card ${id} has no mounted AgentOS`)
    await row.vm.filesystem.writeFile(file, data)
  }

  async function readFile(cardId: string, file: string) {
    const id = safeCardId(cardId)
    const row = live.get(id)
    if (!row || row.phase !== "mounted") throw new Error(`card ${id} has no mounted AgentOS`)
    return new TextDecoder().decode(await row.vm.filesystem.readFile(file))
  }

  return {
    view, start, stop, restart, destroy, writeFile, readFile,
    list: () => [...live.keys()].map((id) => view(id)),
    dispose: async () => {
      await Promise.all([...live.values()].map((row) => row.vm.dispose().catch(() => undefined)))
      live.clear()
    },
  }
}

// Dynamic import on purpose: @rivet-dev/agentos-core is an optional runtime
// dependency (native sidecar, absent in most environments). A static import
// would crash every host startup where it is not installed. Types come from
// the ambient declaration in ./agentos-core.d.ts.
export async function loadAgentOsFactory(): Promise<AgentOsFactory> {
  try {
    const { AgentOs } = await import("@rivet-dev/agentos-core")
    if (!AgentOs) throw new Error("AgentOs.create is not exported")
    return { create: (options) => AgentOs.create(options) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Rivet AgentOS is not available (${reason}). Install @rivet-dev/agentos-core@0.4.1 and retry this card. The canvas stays editable.`,
    )
  }
}
