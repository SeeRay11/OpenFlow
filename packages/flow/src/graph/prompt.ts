import { DISPATCH_TOOL, FENCE, FINISH_TOOL, MCP_REACHES_SESSIONS } from "./dispatch"
import { isCritic, orchestrationShape, subagentsOf } from "./orchestration"
import { swarmShape } from "./swarm"
import { dispatchesOf, gauntletOf, roundsOf, type Attachment, type FlowNode, type Pipeline } from "./types"
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

/**
 * What the orchestrator sends on its first turn.
 *
 * The roster carries each subagent's own role instructions, not just its name:
 * an orchestrator that cannot see what a card is for assigns by guessing at the
 * label, which is how the reviewer gets asked to write code.
 */
export function orchestratorPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  input: string,
  skipped: Attachment[] = [],
) {
  const sections = [orchestratorBriefing(pipeline, node)]
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (input.trim()) sections.push(`# Task\n\n${input.trim()}`)
  const unreadable = withheld(skipped)
  if (unreadable) sections.push(unreadable)
  return sections.join("\n\n")
}

export function orchestratorBriefing(pipeline: Pipeline, node: FlowNode) {
  const children = subagentsOf(pipeline, node)
  const dispatches = dispatchesOf(pipeline)
  const gauntlet = gauntletOf(pipeline)
  const root = orchestrationShape(pipeline).root
  const mine = children.map((child) => {
    const owns = subagentsOf(pipeline, child)
    const role = child.agent.prompt.trim().split("\n")[0] || "no role instructions"
    return [
      `- \`${child.id}\` — ${child.role} · ${child.agent.model ?? "its agent's own model"}`,
      `  what it is for: ${role}`,
      gauntlet && isCritic(child)
        ? "  it judges work against the bar — send it output to grade, never work to do"
        : owns.length
          ? `  it hands work to ${owns.length} card(s) of its own, so give it work worth splitting`
          : "  it does the work itself",
    ].join("\n")
  })

  return [
    "# OpenFlow",
    "",
    node.id === root?.id
      ? "You are the orchestrator of an OpenFlow run. You do not do the work: you decide what has to"
      : "You are a subagent of an OpenFlow run, and you have cards of your own. You do not do the work: you decide what has to",
    "happen, hand it to the cards below you, read what comes back, and answer. Each card is its own",
    "session with its own role, model and tools; they share no memory, cannot talk to each other,",
    "and know only the task you write for them.",
    "",
    `## Cards you can dispatch to — ${children.length}`,
    "",
    ...mine,
    "",
    "## How you say what happens next",
    "",
    // Naming the tools while the channel is parked costs a whole turn: the card
    // calls one, gets `Unknown tool` back, and only then writes the block —
    // measured, every run. So it is told about exactly the channel it has.
    ...(MCP_REACHES_SESSIONS
      ? [
          `Two tools decide it. Call **\`${DISPATCH_TOOL}\`** to hand work out — the cards you name run`,
          `at the same time, so only batch work that does not depend on itself — or **\`${FINISH_TOOL}\`\``,
          "to answer the run. Call exactly one of them, once, and then end your turn: say nothing after",
          "it and call no other tool, because anything you do next is what gets read instead.",
          "",
          "Think out loud as much as you like before the call. Only the call is read as an instruction.",
          "",
          "If neither tool is available to you, say the same thing in a fenced block at the very end of",
          "your message instead:",
        ]
      : [
          "End your message with exactly one fenced block, and let it be the last thing in the",
          "message — nothing after it is read. Think out loud above it as much as you like; only the",
          "block is an instruction. Do not reach for a tool to do this: there is no dispatch tool,",
          "and calling one spends a turn to be told it does not exist.",
          "",
          "To hand work out — the cards you name run at the same time, so only batch work that does",
          "not depend on itself:",
        ]),
    "",
    "```" + FENCE,
    '{ "dispatch": [ { "card": "<id from the list above>", "task": "what it must do, in full" } ] }',
    "```",
    "",
    ...(MCP_REACHES_SESSIONS ? [] : ["To finish, when you can answer:", ""]),
    "```" + FENCE,
    '{ "final": "the answer to the task" }',
    "```",
    "",
    ...(gauntlet ? gauntletBriefing(pipeline, node) : []),
    "## Your part",
    "",
    ...(gauntlet
      ? [
          "- You are not counting dispatches. You stop when the work clears the bar, or when you are",
          "  told the run is out of money, out of time, or making no progress — and you will be told,",
          "  in the message that carries your cards' answers.",
        ]
      : [
          `- You may dispatch ${dispatches} time(s) before you have to answer. Spend them on work that`,
          "  changes the answer, not on confirming what a card already told you.",
        ]),
    "- A card only knows what you write in its task. It has not seen the run task, the other",
    "  cards' answers, or anything you dispatched before — write the task so it can be finished",
    "  by someone who has read nothing else.",
    "- Dispatch a card again when its answer is wrong or thin, and say what was wrong with it.",
    "  It remembers its earlier task; it does not know why you came back.",
    "- Do a card's work yourself only when no card below you can do it.",
    "- Nothing is interactive. No card can ask you anything, and there is nobody behind the run",
    "  to ask either — do not use a question or ask tool, because no answer is coming and the",
    "  run stalls until it times out. Where the task is ambiguous, pick the reading you think is",
    "  meant, say which you picked, and continue.",
    "- The text in `final` is the whole result of the run. Write it for the person who started",
    "  the run, not as a report on what your cards said.",
  ].join("\n")
}

/**
 * The loop an orchestrator runs when the canvas is a gauntlet.
 *
 * Everything here is the method's own hard-won shape rather than good advice:
 * the critic reads the artifact instead of the builder's report because a
 * builder grading itself passes; the bar is concrete because a critic with
 * nothing to compare against invents a standard and the loop chases it; and
 * coupled work stays with one builder because splitting it across cards that
 * cannot see each other made the result worse, not better, in the run this
 * pattern comes from.
 */
function gauntletBriefing(pipeline: Pipeline, node: FlowNode) {
  const gauntlet = gauntletOf(pipeline)!
  const critics = subagentsOf(pipeline, node).filter(isCritic)

  return [
    "## This run is a gauntlet",
    "",
    "You are not producing a first draft. You are running work through builders and critics over",
    "and over until it clears a bar, and the run ends when it clears it or when you are stopped.",
    '"Good enough for now" is not a place to stop.',
    "",
    ...(gauntlet.bar
      ? ["### The bar", "", gauntlet.bar.trim(), ""]
      : [
          "### The bar",
          "",
          "No bar was set for this run. Your first job is to establish one: name something concrete",
          "and inspectable — an existing product, a reference implementation, a test suite, a latency",
          "number, a body of writing — that a critic can hold the work against and say which is",
          "better. Write it into the first task you give every critic, in full, and do not change it",
          "later. A bar you invented and then softened is no bar at all.",
          "",
        ]),
    "### The loop",
    "",
    "1. Split the work into the smallest parts that can be improved and judged on their own.",
    "2. Give a part to a builder.",
    "3. Give the **result** to a critic, with the bar. Not your summary of it, not the builder's —",
    "   tell the critic where the work is so it goes and looks at the real thing.",
    "4. The critic says which is better, ours or the bar, and names the single largest gap.",
    "5. If ours lost, hand that gap back to the builder that owns it and go round again.",
    "6. When every part holds up, send the whole artifact through one last critic before you answer.",
    "",
    ...(critics.length
      ? [
          `Your critics: ${critics.map((critic) => `\`${critic.id}\``).join(", ")}. A critic never builds`,
          "and a builder never grades its own work — that swap is the one thing that makes this loop",
          "different from asking a card to try harder.",
          "",
        ]
      : []),
    "### What goes wrong",
    "",
    "- **Splitting work that is coupled.** Parts that only make sense together — how a thing looks",
    "  and how it moves, a schema and the code that reads it — must go to **one** builder, in",
    "  sequence. Cards cannot see each other's work, so two of them tuning halves of the same",
    "  thing will each make their half worse to fit what they imagine the other did. Fan out only",
    "  where the parts are genuinely independent.",
    "- **A critic that is being kind.** A critic exists to find the gap. If one comes back with",
    "  nothing but praise, dispatch it again and tell it to name the largest gap even if the work",
    "  is good.",
    "- **Passing on the second look.** Two rounds that change nothing are two rounds you have paid",
    "  for. If a part stops improving, say so and move to one that has room.",
    "",
  ]
}

/**
 * A critic's assignment.
 *
 * It is a leaf card and never sees the dispatch protocol, but it is not an
 * ordinary subagent either: it is handed a bar, told to go and look at the real
 * output, and required to come back with a side chosen and one gap named. A
 * critic that returns an essay is a round nobody can act on.
 */
export function criticPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  parent: FlowNode,
  task: string,
  input: string,
  skipped: Attachment[] = [],
) {
  const gauntlet = gauntletOf(pipeline)
  const sections = [
    [
      "# OpenFlow",
      "",
      "You are the critic of an OpenFlow gauntlet: a separate `opencode` session with your own",
      `model and tools. ${label(pipeline, parent.id)} dispatched you and is the only thing that`,
      "reads your answer. You did not build any of this and you have no stake in it.",
      "",
      "## Your part",
      "",
      "- **Go and look at the real output.** Read the files, run the thing, run the tests, open what",
      "  it produces. What you were told about the work is not the work; judge only what you saw",
      "  yourself, and say so if you could not get to it.",
      "- Hold it against the bar and decide **which is better** — the bar or ours. Say which, in one",
      "  line, before anything else.",
      "- Name **the single largest gap**: the one change that would close the most distance to the",
      "  bar. One, not a list. Be specific enough that whoever fixes it does not have to guess.",
      "- Then, if there are others worth knowing about, list them briefly below it.",
      "- Do not be generous. Work that is impressive for its category and short of the bar is short",
      "  of the bar, and saying so is the whole reason you were dispatched. If you genuinely cannot",
      "  find a gap, say that plainly — it is a real answer, and it ends the loop.",
      "- Do not fix anything. You judge; somebody else builds.",
    ].join("\n"),
  ]
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (gauntlet?.bar) sections.push(`# The bar\n\n${gauntlet.bar.trim()}`)
  if (input.trim()) sections.push(`# What the run is for\n\n${input.trim()}`)
  const unreadable = withheld(skipped)
  if (unreadable) sections.push(unreadable)
  sections.push(`# What to judge\n\n${task.trim()}`)
  return sections.join("\n\n")
}

/** One subagent's assignment: the run's context, then the job it was given. */
export function subagentPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  parent: FlowNode,
  task: string,
  input: string,
  skipped: Attachment[] = [],
) {
  const sections = [
    [
      "# OpenFlow",
      "",
      "You are one card in an OpenFlow run: a separate `opencode` session with your own role, model",
      `and tools. ${label(pipeline, parent.id)} dispatched you and is the only thing that reads your`,
      "answer. You share no memory with any other card, none of them can be asked anything, and",
      "nothing you write goes anywhere else.",
      "",
      "## Your part",
      "",
      "- Do the assignment below and stop. If it is impossible or underspecified, say exactly what",
      "  is missing rather than guessing broadly — the card that dispatched you can fix it and",
      "  dispatch you again.",
      "- State any assumption you had to take.",
      "- Write for the card that reads you: what it needs to act, in the shortest form that",
      "  carries it. No preamble.",
    ].join("\n"),
  ]
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (input.trim()) sections.push(`# What the run is for\n\n${input.trim()}`)
  const unreadable = withheld(skipped)
  if (unreadable) sections.push(unreadable)
  sections.push(`# Your assignment\n\n${task.trim()}`)
  return sections.join("\n\n")
}

/**
 * What the orchestrator is prompted with once its cards come back.
 *
 * Short on purpose: it is re-prompted into the session it already holds, so the
 * briefing, the task and its own reasoning are still in front of it. What it
 * does not have is what just happened.
 */
export function dispatchResultPrompt(
  pipeline: Pipeline,
  results: { card: string; text?: string; error?: string }[],
  remaining: number,
  /**
   * What is left, when a countdown is the wrong way to say it. A gauntlet has
   * no dispatch budget to count down — telling it "you may dispatch 493 more
   * times" would read as a target — so it is told what it has spent of the
   * money and time instead.
   */
  status?: string,
) {
  const rows = results.map((result) =>
    result.error
      ? `## ${label(pipeline, result.card)} — failed\n\n${result.error}\n\nIt produced nothing. Dispatch it again with a task it can finish, hand the work to another card, or answer without it.`
      : `## ${label(pipeline, result.card)}\n\n${result.text}`,
  )
  return [
    "# What your cards returned",
    "",
    status
      ? `${status} Same block as before: \`dispatch\` to go round again, \`final\` when it clears the bar.`
      : remaining > 0
        ? `You may dispatch ${remaining} more time(s), or answer now. Same block as before: \`dispatch\` or \`final\`.`
        : "You have no dispatches left. Answer now with a `final` block.",
    "",
    rows.join("\n\n"),
  ].join("\n")
}

/**
 * The last thing an orchestrator is told when it has run out of rope.
 *
 * A cap that simply cut the loop would end a run with a control block as its
 * result. This spends one more turn to get an answer out of what it already has.
 */
export function forceFinalPrompt(reason: string) {
  return [
    "# Answer now",
    "",
    reason,
    "",
    ...(MCP_REACHES_SESSIONS
      ? [
          `Write the answer to the run's task from what you already have and send it with \`${FINISH_TOOL}\`,`,
          "or, if that tool is not available to you, as a fenced block:",
        ]
      : ["Write the answer to the run's task from what you already have, and send it as a fenced block:"]),
    "",
    "```" + FENCE,
    '{ "final": "the answer to the task" }',
    "```",
    "",
    "Do not dispatch. If what you have is not enough, say what is missing and answer with the",
    "best you can support.",
  ].join("\n")
}

/**
 * A card dispatched again.
 *
 * It is prompted into the session it already holds, so it still has its
 * briefing, its role and its earlier task. Only the job is new — and it is told
 * the old one is over, because otherwise a card reads a second assignment as
 * more detail on the first.
 */
export function reassignPrompt(task: string) {
  return `# A new assignment\n\nYou were dispatched again. Your earlier assignment is finished with; this replaces it.\n\n${task.trim()}`
}

/**
 * A subagent that has cards of its own.
 *
 * It is briefed as an orchestrator — it has to speak the protocol, so it has to
 * be shown it — but it is also somebody's subagent, so it gets an assignment
 * rather than the run task. Without this it would be briefed as a leaf and then
 * have its plain answer parsed for a control block it was never told about.
 */
export function subOrchestratorPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  parent: FlowNode,
  task: string,
  input: string,
  skipped: Attachment[] = [],
) {
  const sections = [orchestratorBriefing(pipeline, node)]
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (input.trim()) sections.push(`# What the run is for\n\n${input.trim()}`)
  const unreadable = withheld(skipped)
  if (unreadable) sections.push(unreadable)
  sections.push(`# Your assignment\n\n${label(pipeline, parent.id)} dispatched you with this:\n\n${task.trim()}`)
  return sections.join("\n\n")
}
