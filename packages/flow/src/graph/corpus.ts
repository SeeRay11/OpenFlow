import type { EvalCase } from "./evals"
import { TEMPLATES } from "./templates"
import type { Pipeline } from "./types"

/**
 * The canvases the corpus runs, and why each one is in it.
 *
 * Built from the shipped templates rather than from hand-written graphs, on
 * purpose: those are what a user actually starts from, so a regression that
 * only shows in a shape nobody builds is worth less than one that shows in the
 * first thing they click. The variants below are the shipped templates with a
 * document property turned on — which is exactly how a user reaches those
 * modes too.
 *
 * A case is a shape, not a task. What the cards are *asked* to do belongs with
 * the run that spends the money (see `evals/README.md`); this file is the part
 * that can be asserted for free.
 */

/**
 * The model every card in the corpus runs on.
 *
 * Pinned, and pinned to **one** model, so that a change in the results is a
 * change in OpenFlow rather than a change in whichever model a card happened to
 * default to. A corpus whose cards drifted onto new models each release would
 * measure the models, which is somebody else's benchmark.
 *
 * It is also why a case is not run on a free router: a routed model makes "which
 * model produced this number" unanswerable, and the orchestrator seat has
 * already been measured failing that way.
 *
 * A cheap model on purpose. The corpus is run every release and its job is to
 * measure OpenFlow, not the frontier — a dearer model would buy better
 * deliverables and worse economics for the thing being measured. Changing this
 * invalidates every recorded scorecard, so change it and re-record a baseline
 * in the same commit.
 */
export const EVAL_MODEL = "openrouter/deepseek/deepseek-v4-flash"

function from(id: string, patch: (pipeline: Pipeline) => Pipeline = (p) => p) {
  const template = TEMPLATES.find((entry) => entry.id === id)
  if (!template) throw new Error(`no template "${id}"`)
  const built = template.build()
  return patch({
    ...built,
    nodes: built.nodes.map((node) => ({ ...node, agent: { ...node.agent, model: EVAL_MODEL } })),
  })
}

export const CORPUS: EvalCase[] = [
  {
    id: "pipeline-chain",
    covers: "the plain path: layers in order, each card reading the one before it",
    pipeline: from("plan-code-review"),
  },
  {
    id: "pipeline-verified",
    covers: "a reviewer runs again at the end and the run reports its verdict",
    pipeline: from("plan-code-review", (pipeline) => ({ ...pipeline, verify: { bar: "the tests pass" } })),
    // The reviewer is the last card, so it is also the result — it verifies its
    // own answer, which preflight is right to warn about. Declared rather than
    // designed away: this is the shape a user reaches by ticking `verify` on
    // the template, so it is the shape worth having in the corpus.
    warns: ["verify-self"],
  },
  {
    id: "swarm-debate",
    covers: "peers in rounds behind a barrier, then one synthesizer",
    pipeline: from("swarm-debate"),
  },
  {
    id: "orchestration-tree",
    covers: "the dispatch protocol, and cards nobody dispatched settling skipped",
    pipeline: from("orchestrated-build"),
  },
  {
    id: "orchestration-isolated",
    covers: "a working copy per card, and the merge back",
    pipeline: from("orchestrated-build", (pipeline) => ({ ...pipeline, isolate: true })),
    // Measured 2026-09-08, first full corpus run: this case exercised nothing.
    // Worktrees open only for a batch of more than one writer, and the
    // orchestrator dispatched one card per round all three rounds, so no tree
    // was ever created and the merge path never ran — a green row that measured
    // nothing at all, which is worse than a red one.
    //
    // The fix is a task that genuinely splits, not a bigger prompt: the run task
    // in `evals/README.md` is one file's worth of work, and an orchestrator that
    // fans it out to two cards would be wrong to. Until the case carries its own
    // two-writer task, read this row as "orchestration still works", not as
    // "isolation works".
    warns: [],
  },
  {
    id: "gauntlet-loop",
    covers: "builder and critic to a bar, with spend, clock and stall all live",
    pipeline: from("orchestrated-build", (pipeline) => ({
      ...pipeline,
      gauntlet: { bar: "the tests pass and the page renders", maxSpend: 5, maxMinutes: 30, stall: 3 },
    })),
    // Every gauntlet raises this: it is the standing statement of what the run
    // will stop at, not a problem with this canvas.
    warns: ["gauntlet-cost"],
  },
]
