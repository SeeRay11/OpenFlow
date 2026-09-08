# Changelog

All notable changes to OpenFlow are recorded here. OpenFlow lives in `packages/flow`;
the rest of the repo is a vendored OpenCode fork and is not covered by this file.

## [1.2.2] - 2026-09-07

- Add the eval corpus: six fixed canvases run the same way each release, a scorer
  that reads run logs into a scorecard, and the first recorded baseline.
- Gauntlet and every long run: commit the working tree after each round under a
  ref, record what each round produced, and measure stalling off that record
  rather than off the task text.
- Survive a provider blip mid-run, and announce when a run ends on a channel the
  user turned on.
- Count the lines each card changed, measured off git rather than asked of the
  card.
- A card is done when it did the work, not when it stopped talking.
- Give every card in a batch its own working copy when the canvas asks for it.
- Warn when a dispatching card runs on a routed model.
- Make the Runs menu usable: legible rows, delete, prune, search.
- Select many cards at once on the canvas; the plain canvas drag pans again.
- Stop blaming a stale engine for a project that is not a git repository — offer
  `git init` instead.
- Track only the shipped templates under `.openflow`.

## [1.2.1] - 2026-09-01

- Keep swarm and orchestration cards out of each other's files: a batch is refused
  before it runs when two assignments declare the same path, and a post-batch
  collision report tells the orchestrator when cards wrote over each other.
- Warn about swarm peers with nothing to disagree about, and about peers that can
  write files.
- Pick up a run the browser tab abandoned instead of starting it over.
- Gauntlet: survive rate limits, count what they cost, and refuse to certify
  unjudged work.

## [1.2.0] - 2026-08-29

- Run a canvas as a swarm: parallel peers debate over rounds, and a synthesizer
  card writes the verdict.
- Run a canvas as an orchestration: an orchestrator dispatches work to child cards,
  recursively, bounded by the tree you draw.

## [1.1.2] - 2026-08-29

- Brief every card on the pipeline it runs in.
- Repackage OpenAI-compatible providers from the panel.

## [1.1.1] - 2026-08-24

- Maintenance release.

## [1.1.0] - 2026-08-21

- Run flow's CI checks on GitHub-hosted runners.

## [1.0.0] - 2026-08-17

- First release.

[1.2.2]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.2
[1.2.1]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.1
[1.2.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.0
[1.1.2]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.2
[1.1.1]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.1
[1.1.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.0
[1.0.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.0.0
