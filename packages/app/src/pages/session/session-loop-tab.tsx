import { For, Show, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { listAllSessions } from "@/utils/session"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import type { SessionTreeNode } from "@/pages/session/loop/tree"
import {
  createSessionLoopController,
  type SessionLoopDeps,
} from "@/pages/session/loop/controller"
import type { LoopEventLike, LoopStatus } from "@/pages/session/loop/status"

// Spec surface: the controller is part of this module's public API.
export { createSessionLoopController }
export type { SessionLoopDeps }

/**
 * Event names this tab folds into session statuses. Only names present in the
 * v2 event union are subscribed; execution-lifecycle states arrive through
 * `session.status` events and the sync-store fallback instead.
 */
const EVENT_TYPES = [
  "session.status",
  "session.idle",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.retried",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
] as const

const statusLabel = (language: ReturnType<typeof useLanguage>, status: LoopStatus) => {
  switch (status.state) {
    case "needs_input":
      return language.t("session.loop.status.needsInput")
    case "working":
      return language.t("session.loop.status.working")
    case "retry":
      return status.attempt
        ? language.t("session.loop.status.retry.attempt", { attempt: status.attempt })
        : language.t("session.loop.status.retry")
    case "completed":
      return language.t("session.loop.status.completed")
    case "unknown":
      return language.t("session.loop.status.unknown")
  }
}

export function SessionLoopTab() {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()
  const navigate = useNavigate()

  const controller = createSessionLoopController({
    rootID: () => params.id,
    sessions: () => sync().data.session,
    statusOf: (id) => sync().data.session_status[id],
    permissionCount: (id) => sync().data.permission[id]?.length ?? 0,
    questionCount: (id) => sync().data.question[id]?.length ?? 0,
    subscribe: (handler) => {
      const unsubs = EVENT_TYPES.map((type) =>
        sdk().event.on(type, (event: LoopEventLike) => handler(event)),
      )
      return () => unsubs.forEach((off) => off())
    },
    fetchSessions: () => listAllSessions(sdk().api.session, { directory: sdk().directory, order: "desc" }),
    remember: (session) => sync().session.remember(session),
  })

  const open = (sessionID: string) => {
    navigate(
      params.serverKey
        ? sessionHref(requireServerKey(params.serverKey), sessionID)
        : legacySessionHref(sdk().directory, sessionID),
    )
  }

  const sections = createMemo(() => {
    const groups = controller.groups()
    return [
      { key: "needsInput", label: language.t("session.loop.group.needsInput"), nodes: groups.needsInput },
      { key: "working", label: language.t("session.loop.group.working"), nodes: groups.working },
      { key: "completed", label: language.t("session.loop.group.completed"), nodes: groups.completed },
    ].filter((section) => section.nodes.length > 0)
  })

  return (
    <div class="flex flex-col h-full overflow-y-auto">
      <Show
        when={controller.tree().nodes.length > 1}
        fallback={
          <div class="p-4 text-14-regular text-text-weak">{language.t("session.loop.empty")}</div>
        }
      >
        <For each={sections()}>
          {(section) => (
            <div class="pb-2">
              <div class="px-4 py-1.5 text-12-medium text-text-weak">
                {section.label}
              </div>
              <For each={section.nodes}>
                {(node) => {
                  const status = () => controller.statuses()[node.session.id] ?? { state: "unknown" as const }
                  return (
                    <button
                      type="button"
                      class="w-full flex items-center justify-between gap-2 px-4 py-1.5 text-left hover:bg-background-stronger"
                      style={{ "padding-left": `${16 + node.depth * 16}px` }}
                      onClick={() => open(node.session.id)}
                    >
                      <span class="text-14-regular truncate">{node.session.title || node.session.id}</span>
                      <span class="text-12-regular text-text-weak shrink-0">
                        {statusLabel(language, status())}
                      </span>
                    </button>
                  )
                }}
              </For>
            </div>
          )}
        </For>
        <Show when={controller.tree().truncated}>
          <div class="px-4 py-1.5 text-12-regular text-text-weak">
            {language.t("session.loop.truncated", { count: controller.tree().total })}
          </div>
        </Show>
      </Show>
    </div>
  )
}
