# The eval corpus

Six fixed canvases, run the same way each release, so "it got worse" is a number instead of an
impression.

Three of this project's goals — it runs for hours, it does not degrade as the loop continues,
it has no bugs that cost quality — are claims about behaviour over time, and nothing measured
any of them. Every failure this fork has fixed was found by running a mode once and reading the
result afterwards. That finds the failure that happened; it says nothing about the ones that
stopped happening.

## The two halves

**The free half runs in CI.** `src/graph/corpus.ts` holds the canvases and
`src/graph/evals.test.ts` asserts that each one still passes preflight raising exactly the
warnings it declares. That catches the regression class where a change to `validate.ts` quietly
makes a legal shape illegal, or an illegal one legal. It costs nothing and needs no engine.

**The paid half is run by hand.** Open each canvas, give it the task below, press Run, and keep
the run id. There is deliberately no script that drives the models: an eval harness that
re-implemented the run would be measuring itself, and the run log already carries every number
this needs — status, verdict, wall clock, spend, rounds, and every card's line counts.

## The cases

| id                       | what it is there to catch                                             |
| ------------------------ | --------------------------------------------------------------------- |
| `pipeline-chain`         | layers in order, each card reading the one before it                  |
| `pipeline-verified`      | a reviewer runs again at the end and the run reports its verdict      |
| `swarm-debate`           | peers in rounds behind a barrier, then one synthesizer                |
| `orchestration-tree`     | the dispatch protocol, and cards nobody dispatched settling `skipped` |
| `orchestration-isolated` | a working copy per card, and the merge back                           |
| `gauntlet-loop`          | builder and critic to a bar, with spend, clock and stall all live     |

Every card runs on `EVAL_MODEL`, pinned in `corpus.ts`. It is one model on purpose: a corpus
whose cards drifted onto whatever they defaulted to would be measuring the models, which is
somebody else's benchmark.

## Running one

Set `OPENFLOW_PROJECT` to a **scratch git repository**, not to anything you care about — these
canvases write files, and the gauntlet case will keep writing them for up to thirty minutes.

The task text is part of the measurement, so it does not change between releases:

> Add a `--json` flag to the CLI in this repository so every command can print machine-readable
> output. Keep the existing human output as the default. Add tests for the new flag and make
> them pass.

Run each case, note its run id from the Runs menu, then:

```bash
bun evals/score.ts record evals/results/2026-09-07.json \
  pipeline-chain=run-... \
  pipeline-verified=run-... \
  swarm-debate=run-... \
  orchestration-tree=run-... \
  orchestration-isolated=run-... \
  gauntlet-loop=run-...
```

## Comparing releases

```bash
bun evals/score.ts compare evals/results/2026-08-01.json evals/results/2026-09-07.json
```

Regressions are listed first and exit non-zero. What counts as a regression is deliberately
narrow:

- **Status and verdict** — a run that stopped passing is worse; one that started passing is
  better. Not judgement calls.
- **Cost, wall clock and rounds** — only past a tenth, or one whole unit, whichever is larger. A
  gauntlet costing 3% more is a provider's tokeniser, and flagging that every release trains
  whoever reads the report to skip the column.
- **Lines changed** — reported with **no direction claimed**. More lines is not better work and
  fewer is not tighter work. The moment this starts saying otherwise it has invented a bar of
  its own, and the bar belongs to the canvas.

## Known holes in the corpus

- **`orchestration-isolated` does not currently test isolation.** Worktrees open only for a
  batch of more than one writer, and on the first full run the orchestrator dispatched a single
  card in each of its three rounds — so no tree was created and the merge path never ran. The
  row still says something useful (orchestration works), but not the thing its name claims. It
  needs a task that genuinely splits across two files before it measures what it is for.

## What this does not do

It does not judge the deliverable. Whether the `--json` flag was implemented _well_ is what the
gauntlet's own critic is for, and its verdict is in the scorecard. This measures whether
OpenFlow still gets a run to that verdict for the same money in the same time.
