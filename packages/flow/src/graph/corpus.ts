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
 */
export const EVAL_MODEL = "anthropic/claude-sonnet-5"

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
