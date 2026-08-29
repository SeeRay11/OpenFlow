import { swarmShape } from "./swarm"
import { roundsOf, type Attachment, type FlowNode, type Pipeline } from "./types"
import { downstream, layer, upstream } from "./validate"

/** `role (id)` — the one label every prompt in every mode uses for a card. */
function label(pipeline: Pipeline, id: string) {
  const entry = pipeline.nodes.find((candidate) => candidate.id === id)
  return entry ? `${entry.role} (${entry.id})` : id
}

/**
 * Files the run carries that this card's model has no input modality for.
 *
 * Silence would be worse: the card would answer as if the run had no
 * attachments at all, and another card that *can* read them would be handed a
 * confidently wrong summary.
 */
function withheld(skipped: Attachment[]) {
  if (!skipped.length) return undefined
  const list = skipped.map((file) => `- ${file.name} (${file.mime})`).join("\n")
  return `# Attachments you cannot read\n\nThe run carries files this model has no input modality for, so they were withheld:\n\n${list}\n\nContinue with the task; do not claim to have seen them.`
}

/** Node prompt = pipeline briefing + role instructions + run task + serialized upstream outputs. */
export function buildPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  sources: string[],
  outputs: Map<string, string>,
  input: string,
  /** Files this node's model cannot read, named so it knows they exist. */
  skipped: Attachment[] = [],
) {
  const nodes = new Map(pipeline.nodes.map((entry) => [entry.id, entry] as const))
  const sections: string[] = [pipelineBriefing(pipeline, node)]
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (input.trim()) sections.push(`# Task\n\n${input.trim()}`)
  const unreadable = withheld(skipped)
  if (unreadable) sections.push(unreadable)
  const upstreamText = sources
    .map((id) => {
      const source = nodes.get(id)
      const output = outputs.get(id)
      if (!source || !output) return undefined
      return `## ${source.role} (${source.id})\n\n${output}`
    })
    .filter(Boolean)
  if (upstreamText.length) sections.push(`# Upstream output\n\n${upstreamText.join("\n\n")}`)
  return sections.join("\n\n")
}

/**
 * What the card is, where it sits, and who reads it next.
 *
 * A card is a plain `opencode` session with no idea it is part of anything, so
 * without this a planner asked to "hand this to the architect" does not know an
 * architect exists — it has never seen the graph. Every card gets the same map,
 * named by the same `role (id)` label the `# Upstream output` headers use, so
 * one card can refer to another and be understood.
 *
 * Kept to the graph and the handoff rules: the map is a few words per card, and
 * the strategy paragraph exists so a card plays only its own part instead of
 * pre-empting the ones after it.
 */
export function pipelineBriefing(pipeline: Pipeline, node: FlowNode) {
  const name = (id: string) => label(pipeline, id)
  const validation = layer(pipeline)
  // A cyclic or malformed graph still gets a map — just an unordered one. The
  // run itself is blocked elsewhere; a prompt that silently drops the map here
  // would be the confusing half of the failure.
  const order = validation.ok ? validation.layers : [pipeline.nodes.map((entry) => entry.id)]
  const next = downstream(pipeline, node.id)
  const rows = order.flatMap((ids, index) =>
    ids.map((id) => {
      const feeds = downstream(pipeline, id)
      const receives = upstream(pipeline, id)
      const from = receives.length ? receives.map(name).join(", ") : "the run task only"
      const to = feeds.length ? feeds.map(name).join(", ") : "nothing — its output ends the run"
      const here = id === node.id ? "  <-- YOU ARE HERE" : ""
      return `- layer ${index + 1} · ${name(id)} · receives: ${from} · feeds: ${to}${here}`
    }),
  )

  return [
    "# OpenFlow",
    "",
    "You are one card in an OpenFlow pipeline: a graph of separate agent sessions run in",
    "dependency order. Each card is its own session with its own role, model and tools.",
    "Cards share no memory and cannot talk to each other. Every card receives the same run",
    "task; the only thing that crosses a card boundary is a card's final message, which is",
    "pasted verbatim into the prompt of every card wired downstream of it.",
    "",
    `## Pipeline "${pipeline.name}" — ${pipeline.nodes.length} card(s)${validation.ok ? `, ${validation.layers.length} layer(s)` : ""}`,
    "",
    ...rows,
    "",
    "## Your part",
    "",
    upstream(pipeline, node.id).length
      ? `You are ${name(node.id)}. Every card above you has already run; the output you were given is quoted at the end of this prompt — which may be less than the whole chain produced.`
      : `You are ${name(node.id)}. Nothing runs before you: the run task below is all you get.`,
    next.length
      ? `Your final message is read next by: ${next.map(name).join(", ")}.`
      : "No card runs after you: your final message is the result of the whole run.",
    "",
    "- Do your role's part and stop. Work a downstream card owns is that card's job — name",
    "  what it needs and hand it over instead of doing it yourself, unless the task asks",
    "  you specifically to do it.",
    "- Do not redo work an upstream card already did. Build on its output; do not restate it.",
    "- No card can ask you a question and nothing is interactive. Where the task is",
    "  ambiguous, state the assumption you took and continue.",
    next.length
      ? "- Write for the card that reads you next, not for a human: what it needs to act, in\n  the shortest form that carries it. No preamble, no summary of what it already has."
      : "- Write for the person who started the run: this is the run's final answer.",
  ].join("\n")
}

/**
 * What one agent sends in round `round`.
 *
 * Round 1 carries the whole setup: the briefing, the card's role, the task.
 * Later rounds carry only what changed — the peers' last answers and where the
 * swarm is up to — because the agent is re-prompted into the same session and
 * already holds the rest. Repeating it would pay for the briefing R times and
 * teach the agent that its own earlier answer is old news.
 */
export function swarmPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  round: number,
  peers: Map<string, string>,
  input: string,
  skipped: Attachment[] = [],
) {
  const rounds = roundsOf(pipeline)
  if (round <= 1) {
    const sections = [swarmBriefing(pipeline, node)]
    if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
    if (input.trim()) sections.push(`# Task\n\n${input.trim()}`)
    const unreadable = withheld(skipped)
    if (unreadable) sections.push(unreadable)
    return sections.join("\n\n")
  }

  const said = [...peers]
    .filter(([id]) => id !== node.id)
    .map(([id, text]) => `## ${label(pipeline, id)}\n\n${text}`)
  return [
    `# Round ${round} of ${rounds}`,
    "",
    said.length
      ? `Every other agent's round ${round - 1} answer follows. Read them, then give your position for this round — revised where they changed your mind, held where they did not, and say which.`
      : `No other agent produced an answer in round ${round - 1}. Continue on your own reasoning and say that you had nothing to weigh against.`,
    ...(round === rounds
      ? ["", "This is the final round. What you say now is what the synthesizer weighs; nothing you leave out gets another chance."]
      : []),
    ...(said.length ? ["", said.join("\n\n")] : []),
  ].join("\n")
}

/**
 * Who else is in the swarm, how the rounds work, and what the disagreement is
 * for.
 *
 * An agent is a plain `opencode` session that has never heard of the others, so
 * without this it reads a wall of quoted answers with no idea why. The
 * anti-convergence lines carry the weight: the failure mode of round 2 is every
 * agent restating whichever peer sounded most certain, which costs a full round
 * of sessions to produce one opinion.
 */
export function swarmBriefing(pipeline: Pipeline, node: FlowNode) {
  const shape = swarmShape(pipeline)
  const rounds = roundsOf(pipeline)
  const row = (entry: FlowNode) =>
    `- ${label(pipeline, entry.id)} · ${entry.agent.model ?? "its agent's own model"}${entry.id === node.id ? "  <-- YOU ARE HERE" : ""}`
  const verdict = shape.synthesizers[0]

  return [
    "# OpenFlow",
    "",
    "You are one agent in an OpenFlow swarm: several separate sessions, each with its own",
    "role, model and tools, all answering the same task at once. You are peers — nobody is in",
    "charge, and no agent's answer is the default. You share no memory; the only thing that",
    "crosses between you is a final message, quoted into the others' prompts between rounds.",
    "",
    `## Swarm "${pipeline.name}" — ${shape.agents.length} agent(s), ${rounds} round(s)`,
    "",
    ...shape.agents.map(row),
    ...(verdict ? [`- verdict: ${label(pipeline, verdict.id)} · ${verdict.agent.model ?? "its agent's own model"}`] : []),
    "",
    "## How this runs",
    "",
    "- Round 1: every agent answers the task alone. You cannot see the others yet.",
    rounds > 1
      ? `- Rounds 2-${rounds}: you are shown what every other agent said in the round before, and may revise.`
      : "- There are no further rounds: your first answer is your final position.",
    verdict
      ? `- After round ${rounds}: ${label(pipeline, verdict.id)} reads every agent's final position and writes the verdict. It took no part in the debate, and what it writes is the result of the whole run.`
      : `- After round ${rounds} the swarm's positions are collected as the result of the run.`,
    "",
    "## Your part",
    "",
    `You are ${label(pipeline, node.id)}. Your role and your model are why you are in this swarm — what you add is the part only you would have said.`,
    "",
    "- Disagree explicitly. Name the peer, name the part you think is wrong, and say why.",
    "  A swarm that agrees because nobody pushed back has wasted every session in it.",
    "- Do not restate a peer in order to agree with them. Say what you would add, change or",
    "  drop, and leave the rest to them.",
    "- Change your mind when the argument is better than yours, and say what changed it.",
    "  Holding a position you no longer believe is the same waste from the other side.",
    "- No peer can answer a question and nothing is interactive. Where the task is ambiguous,",
    "  state the assumption you took and continue.",
    "- Write for the card that weighs you: your position and the reason for it, short enough",
    "  to be read beside everyone else's. No preamble.",
  ].join("\n")
}

/**
 * What the synthesizer sends: the whole debate, once, at the end.
 *
 * A fresh session rather than a reused one — it took no part in the rounds, and
 * seeing them arrive one at a time is exactly the anchoring on the first answer
 * this card exists to avoid.
 */
export function synthesisPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  finals: Map<string, string>,
  input: string,
  skipped: Attachment[] = [],
) {
  const shape = swarmShape(pipeline)
  const rounds = roundsOf(pipeline)
  const positions = shape.agents
    .map((agent) => {
      const text = finals.get(agent.id)
      return text ? `## ${label(pipeline, agent.id)}\n\n${text}` : undefined
    })
    .filter(Boolean)
  const silent = shape.agents.filter((agent) => !finals.get(agent.id))

  const sections = [
    [
      "# OpenFlow",
      "",
      `You are the synthesizer of an OpenFlow swarm. ${shape.agents.length} agent(s) answered the same task`,
      `independently and then read each other over ${rounds} round(s). You took no part. Their final`,
      "positions are quoted below, and what you write is the result of the whole run.",
      "",
      "## Your part",
      "",
      "- Weigh the positions; do not average them. Where they conflict, decide on the evidence",
      "  they gave, and say which way you went and why.",
      "- Where they agree, say it once. The reader does not need it once per agent.",
      "- Name anything all of them missed, if you can see it.",
      "- Write for the person who started the run: this is the run's final answer, not a report",
      "  on the debate.",
    ].join("\n"),
  ]
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (input.trim()) sections.push(`# Task\n\n${input.trim()}`)
  const unreadable = withheld(skipped)
  if (unreadable) sections.push(unreadable)
  if (silent.length)
    // A dropped agent is a hole in the evidence, and a synthesizer that cannot
    // see the hole writes a confident verdict over it.
    sections.push(
      `# Agents that produced nothing\n\n${silent
        .map((agent) => `- ${label(pipeline, agent.id)}`)
        .join("\n")}\n\nThey failed or were stopped. Decide on what you have, and say the swarm was short of them.`,
    )
  sections.push(
    positions.length
      ? `# Final positions\n\n${positions.join("\n\n")}`
      : "# Final positions\n\nNone. Every agent in the swarm failed, so there is nothing to weigh; say so rather than answering the task yourself.",
  )
  return sections.join("\n\n")
}
