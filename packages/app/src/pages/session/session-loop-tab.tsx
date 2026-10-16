import { For, Show, createMemo, createSignal } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { listAllSessions } from "@/utils/session"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { getRelativeTime } from "@/utils/time"
import type { SessionTreeNode } from "@/pages/session/loop/tree"
import {
  createSessionLoopController,
  pickLastAssistantText,
  type NextMoveCard,
  type NextMoveMessageLike,
  type SessionLoopDeps,
} from "@/pages/session/loop/controller"
import { nextMoveHref } from "@/pages/session/loop/href"
import type { LoopEventLike, LoopStatus } from "@/pages/session/loop/status"

// Spec surface: the controller is part of this module's public API.
export { createSessionLoopController }
export type { SessionLoopDeps }

/**
 * Event names this tab folds into session statuses. Only names present in the
 * v2 event union are subscribed; execution-lifecycle states arrive through
 * `session.status` events and the sync-store fallback instead.
 * `session.next.text.ended` feeds the NEXT-MOVE queue (Stufe 2).
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
  "session.next.text.ended",
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
    case "compacting":
      return language.t("session.loop.status.compacting")
    case "completed":
      return language.t("session.loop.status.completed")
    case "unknown":
      return language.t("session.loop.status.unknown")
  }
}

/** A step long enough to overflow the 3-line clamp gets an expand toggle. */
const isLongStep = (schritt: string) => schritt.length > 180 || schritt.split("\n").length > 3

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
    lastAssistantText: async (sessionID) => {
      // `api` (CompatibleApi) does not type `messages`; the raw v2 client does
      // (same call pattern as server-session.ts fetchMessages).
      const response = await sdk().client.session.messages({ sessionID, limit: 20 })
      return pickLastAssistantText((response.data ?? []) as unknown as NextMoveMessageLike[])
    },
  })

  const open = (sessionID: string) => {
    navigate(
      params.serverKey
        ? sessionHref(requireServerKey(params.serverKey), sessionID)
        : legacySessionHref(sdk().directory, sessionID),
    )
  }

  // [Übernehmen] consumes the card and pre-fills the prompt of a NEW session
  // in the same directory (spec §2: no auto-send — the user reviews and sends
  // themselves). The href targets the session root route: only there does the
  // composer actually consume ?prompt= (the session page skips it for
  // existing sessions, the new layout creates a prefilled draft instead).
  const applyNextMove = (card: NextMoveCard) => {
    controller.consumeNextMove(card.sessionID)
    navigate(nextMoveHref({ schritt: card.schritt, directory: sdk().directory }))
  }

  const copySchritt = (card: NextMoveCard) => {
    const fail = () =>
      setCopyFailed((prev) => new Set(prev).add(card.textKey))
    const clip = navigator.clipboard
    if (!clip) {
      fail()
      return
    }
    clip
      .writeText(card.schritt)
      .then(() => {
        setCopyFailed((prev) => {
          const next = new Set(prev)
          next.delete(card.textKey)
          return next
        })
        setCopied((prev) => new Set(prev).add(card.textKey))
        setTimeout(() => {
          setCopied((prev) => {
            const next = new Set(prev)
            next.delete(card.textKey)
            return next
          })
        }, 1_500)
      })
      .catch(fail)
  }

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = createSignal<ReadonlySet<string>>(new Set())
  const [copyFailed, setCopyFailed] = createSignal<ReadonlySet<string>>(new Set())
  const toggleExpanded = (textKey: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(textKey)) next.delete(textKey)
      else next.add(textKey)
      return next
    })

  const sections = createMemo(() => {
    const groups = controller.groups()
    return [
      { key: "needsInput", label: language.t("session.loop.group.needsInput"), nodes: groups.needsInput },
      { key: "working", label: language.t("session.loop.group.working"), nodes: groups.working },
      { key: "completed", label: language.t("session.loop.group.completed"), nodes: groups.completed },
    ].filter((section) => section.nodes.length > 0)
  })

  const titleOf = (sessionID: string) => {
    const node = controller.tree().nodes.find((n) => n.session.id === sessionID)
    return node?.session.title || sessionID
  }

  const sectionView = (section: { key: string; label: string; nodes: SessionTreeNode[] }) => (
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
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto">
      <Show
        when={controller.ready()}
        fallback={
          <div class="p-4 text-14-regular text-text-weak">{language.t("session.loop.loading")}</div>
        }
      >
        <Show
          when={controller.tree().nodes.length > 1}
          fallback={
            <Show
              when={controller.fetchError()}
              fallback={
                <div class="p-4 text-14-regular text-text-weak">{language.t("session.loop.empty")}</div>
              }
            >
              <div class="p-4 text-14-regular text-text-weak">{language.t("session.loop.error")}</div>
            </Show>
          }
        >
        <For each={sections().filter((section) => section.key === "needsInput")}>
          {(section) => sectionView(section)}
        </For>
        <Show when={controller.nextMoves().length > 0}>
          <div class="pb-2">
            <div class="px-4 py-1.5 text-12-medium text-text-weak">
              {language.t("session.loop.nextmoves")}
            </div>
            <For each={controller.nextMoves()}>
              {(card) => {
                const isExpanded = () => expanded().has(card.textKey)
                const wasCopied = () => copied().has(card.textKey)
                const copyErrored = () => copyFailed().has(card.textKey)
                return (
                  <div class="px-4 py-2 border-b border-border-weak">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-12-regular text-text-weak truncate">{titleOf(card.sessionID)}</span>
                      <span class="text-12-regular text-text-weak shrink-0">
                        {getRelativeTime(new Date(card.at).toISOString(), language.t)}
                      </span>
                    </div>
                    <p
                      title={card.schritt}
                      classList={{
                        "text-14-regular whitespace-pre-wrap": true,
                        "line-clamp-3": !isExpanded(),
                      }}
                    >
                      {card.schritt}
                    </p>
                    <div class="flex items-center gap-1 mt-1.5">
                      <button
                        type="button"
                        class="text-12-medium text-text-strong rounded px-1.5 py-0.5 hover:bg-background-stronger"
                        onClick={() => applyNextMove(card)}
                      >
                        {language.t("session.loop.nextmoves.consume")}
                      </button>
                      <button
                        type="button"
                        class="text-12-regular text-text-weak rounded px-1.5 py-0.5 hover:bg-background-stronger"
                        onClick={() => open(card.sessionID)}
                      >
                        {language.t("session.loop.nextmoves.open")}
                      </button>
                      <button
                        type="button"
                        class="text-12-regular text-text-weak rounded px-1.5 py-0.5 hover:bg-background-stronger"
                        title={copyErrored() ? language.t("session.loop.nextmoves.copyError") : undefined}
                        onClick={() => copySchritt(card)}
                      >
                        {wasCopied()
                          ? language.t("session.loop.nextmoves.copied")
                          : language.t("session.loop.nextmoves.copy")}
                      </button>
                      <Show when={isLongStep(card.schritt)}>
                        <button
                          type="button"
                          class="text-12-regular text-text-weak rounded px-1.5 py-0.5 hover:bg-background-stronger"
                          onClick={() => toggleExpanded(card.textKey)}
                        >
                          {isExpanded()
                            ? language.t("session.loop.nextmoves.collapse")
                            : language.t("session.loop.nextmoves.expand")}
                        </button>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
        <For each={sections().filter((section) => section.key !== "needsInput")}>
          {(section) => sectionView(section)}
        </For>
        <Show when={controller.tree().truncated}>
          <div class="px-4 py-1.5 text-12-regular text-text-weak">
            {language.t("session.loop.truncated", { count: controller.tree().total })}
          </div>
        </Show>
        </Show>
      </Show>
    </div>
  )
}
