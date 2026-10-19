**A. Auth / surface**
- Server maps bearer → surface from `SUBSTRATE_TOKEN_<SURFACE>` env vars (comma list per surface, ≥16 chars; `-`→`_`, upper-cased). packages/mcp-server/src/config.ts:523-579. A var naming a surface outside `SURFACES` throws `ConfigError` at boot (config.ts:561-565).
- `SURFACES` is a closed list (types.ts:30-47): claude-code, cursor, hermes, omp, muse, grok-build, grok-bot, codex, opencode, pi, rivet-agentos, 15× `swarm-aNN-*`, substrate. **There is no `openflow` surface.** Adding one is a code change in agent-substrate types.ts plus a deploy, then a `SUBSTRATE_TOKEN_OPENFLOW` env var. It is not config-only. `event.ts:231` rejects unknown surfaces with "unknown surface: x".
- **Recommendation: present as `omp`.** This host has `/etc/substrate/tokens/omp` and the omp projector already uses it. `omp` is in the default grants, so no server change is needed. Per-card attribution goes in `session_id`, `node_id` and `payload`.
- `SUBSTRATE_TOKEN` (env) works for the omp surface, and `/events/query` on this host returns omp events. That the env token is the omp token is [INFERENCE]; I did not print or compare the token.
- Client resolution order (packages/cli/src/token.ts:66-77; projector/omp/substrate-skills.ts:154-163): `SUBSTRATE_TOKEN`, then the first line of the file at `SUBSTRATE_TOKEN_FILE`, then `<SUBSTRATE_TOKENS_DIR or /etc/substrate/tokens>/omp`. URL is `SUBSTRATE_URL`, default `http://127.0.0.1:7410`. Send `Authorization: Bearer <t>`.
- No token with `allowAnonymous` off → 401 (server.ts:672-680). `/healthz` is open (server.ts:671). Anonymous callers write as `unknown`, which has no grants.
- **The writer comes only from the token.** `POST /memory` ignores body `writer` (server.ts:1083); `memory_write` ignores `surface`. On `POST /events`, a non-swarm token's body `surface` wins as attribution (swarm-correlation.md).
- **Default-deny RBAC** (memory-governance.md:49-62). `omp` is a known surface, so `"*"` grants cover it:

| scope | kinds `omp` may write |
|---|---|
| `graph:<id>` | decision, fact, warning, handoff, todo |
| `repo:<owner/name>` | decision, fact, warning, todo (no handoff) |
| `agent:omp` (own only) | fact, warning, todo, handoff |
| `global` | decision, fact, warning, but only as a *proposal*; it needs a reviewer token (`SUBSTRATE_MEMORY_REVIEW_TOKENS`) |
| `person:*` | never |

- Reads have no per-scope RBAC. Only `agent:` rows are restricted to their own surface.
- Operators widen with `SUBSTRATE_MEMORY_GRANTS`; nothing narrows.

**B. Contracts** (no MCP SDK needed; body cap 1 MB, server.ts:236)
- `GET /healthz` → 200 JSON `{index,greptime,appendOnly,eventsWritable,ledger:{writable,…},cache,planes:{greptime,index,cache,hindsight,ragflow:{ok,breaker}},capacity,…}`.
- `POST /brief` body `{repo?,branch?,graph_id?,surface?,profile?}` (server.ts:901-944). Sending `If-None-Match` can give 304. Returns 200 `text/markdown`, always, even when degraded. Headers: `etag`, `x-substrate-brief: complete|degraded|snapshot`, `x-substrate-brief-failed`, `x-substrate-brief-age`.
- `POST /events` body (types.ts:76-93): `{surface,kind,summary,session_id?,graph_id?,node_id?,linear_identifier?,step?,repo?,branch?,actor?,payload?,ts?,idempotency_key?}`.
  - kinds: session.start, prompt, claim, tool.call, file.edit, shell, commit, pr, handoff, session.end, note, warning.
  - Summary is capped at 2000 chars, payload at 16 KB.
  - Reply is 202 `{id,ts,hash,stored:true}` or **503** `{…stored:false,error}` (server.ts:998-1008). 400 means validation; 403 means attribution.
  - `idempotency_key` is ignored while `SUBSTRATE_EVENT_IDEMPOTENCY=off` (the default).
- `POST /events/query` body `{session_id?,graph_id?,node_id?,linear_identifier?,repo?,branch?,surface?,kind?,actor?,since?,until?,limit(≤500, default 50),order?,include_payload?}`. Reply is `{events:[{id,ts,surface,session_id,graph_id,node_id,linear_identifier,step,repo,branch,actor,kind,summary,hash,prev}],count,truncated}`; 503 with `error` if the ledger is down.
- `POST /memory` is **write only** (server.ts:1070-1084). Body `{scope,kind,text,subject?,trust?,ttl?,source_event?,session_id?,graph_id?,repo?,expected_version?,idempotency_key?,review_token?}`.
  - Reply `{outcome,reason,remedy,verified_persisted,idempotency_key,entry?,strategy,grant,writer,current_version?,conflict_with?,review_id?,quarantine_id?,deduplicated?,truncated?}`.
  - Status: 200 accepted and read back; 202 accepted but unconfirmed; 409 conflict; 422 quarantined; 403 denied; 503 index down.
- **Memory read over REST:** only `POST /memory/recall {query}` exists. It is a derived Hindsight recall and returns `{results,degraded,…}`.
  - Exact reads of governed memory need MCP `memory_search`.
  - `/brief` also carries memory.
- `POST /verify {graph_id}` → `verifyGraph` result with `ok`, and the first bad event if any.
- **MCP:** `POST /mcp`, JSON-RPC 2.0, headers `Content-Type: application/json` and `Accept: application/json, text/event-stream`, plus the bearer.
  - It is stateless (no `mcp-session-id`) and the reply is SSE (`event: message\ndata: {json-rpc}`).
  - Verified live: `initialize` and `tools/list` work.
  - Tools live now: memory_brief, memory_write, memory_search, memory_recall, memory_pending, events_emit, events_query, events_verify, graph_get, graph_register, graph_bind, graph_claim, graph_heartbeat, graph_release, graph_complete, graph_find, issue_get, docs_search, docs_ingest, coord_handoff(+_verify,_list), coord_drift_scan, skills_propose, coord_reap_leases, desktop_run.
  - Schemas are in mcp.ts:
    - memory_brief 209: `{repo,branch,graph_id,surface,if_none_match,profile}`; text plus structuredContent `{etag,state,failed_sources,…}`
    - memory_write 287: the same fields as `POST /memory`
    - memory_search 366: `{query?,scope?,limit 1-100,include_superseded?,subject_prefix?,before?,before_id?}`; returns `{entries,derived,degraded,reason}`, or `{entries,next}` when paged
    - events_emit 474 and events_query 517: same as REST
    - graph_register 585: `{graph_id,repo,branch,status,pr_url,nodes[{node_id,linear_identifier,state}],steps,edges}`
    - graph_bind 640: `{correlation_id?,graph_id?}`
    - graph_claim/heartbeat/release/complete: lease tools (coordination.md)
  - Tool errors come back with `isError`.

**C. Memory semantics** (docs/memory-governance.md)
- Scopes: `global | graph:<id> | repo:<owner/name> | agent:<surface> | person:<name>`. Identifiers are lower-cased and trimmed to 512 chars by `normalizeIdentifier`.
- Kinds: decision, fact, warning, handoff, todo. Subject ≤200 chars, trimmed and lower-cased (memory-policy.ts:35,85). Text cap is 4000 chars; excess is cut and flagged `truncated:true` (memory-write.ts:63,506).
- Conflict identity = scope + kind + subject. Without a subject every write appends.
  - decision → versioned: replacing a standing decision needs `expected_version`, else `version.required` / `version.stale`. The conflict reply carries `current_version`.
  - todo → last-write-wins.
  - fact and warning → append.
  - global → require-review (409 `review.required`).
- Idempotency: an explicit `idempotency_key` is exactly-once for 30 days. With no key, one is derived from the content and dedupes for 24 hours. Reusing a key with a different request gives `conflict/idempotency.reused`.
- Quarantine: secret (never releasable), pii and speculative (decision and fact only; a reviewer can release). Quarantined text never reaches a search or brief. The write-path redactor strips secret shapes first (docs/redaction.md).
- **Treat a write as stored only if `outcome==="accepted" && verified_persisted===true`** (governance.md:453).
- Trust: agent-claimed by default; shelf life 14 days, then `needs_reverification`.
- ttl is `graph|30d|permanent`; the default is `permanent` (memory-write.ts:469).
  - **Pitfall:** `ttl:"graph"` counts as expired once the graph has no `graph_index` row. So `graph_register` must precede it.
  - Under the default `SUBSTRATE_MEMORY_EXPIRY=report`, expired entries are still served, tagged `expired`.
- **No delete API.** A decision is superseded (old row retired, version+1) and the sweeper deletes only under double opt-in (`SUBSTRATE_INDEX_SWEEP=apply` plus `--apply`).
  - Honest "clear" for OpenFlow: (1) supersede decision/todo by subject, (2) write a fact or warning subject `…/retracted`, (3) scope entries per run and stop reading that scope, (4) let the `30d` ttl lapse.
  - Never promise deletion. Hindsight keeps a derived copy.

**D. Identifiers**
- Graph ID = `ut-<ts36>-<8hex>`, regex `^ut-[a-z0-9]+-[0-9a-f]{8}$` (service.ts:759). The uplift mints it. On this host the brief already shows `ut-mvf9vsaa-a99417c4` planned by omp for OpenFlow/dev.
- `graph_bind` enforces that format. `correlation_id` is `[A-Za-z0-9._:-]{1,200}`, bound once to a graph (insert-or-get; adopt the returned `graph_id`). The swarm run's correlation_id therefore maps to exactly one Graph ID.
- `events` accept any string for `graph_id`, and `memory graph:<id>` is not format-checked. Only `graph_bind` is strict.
- The brief is keyed by `repo` (normalised, used for the events SQL and `repo:` memory scope). **`branch` only labels the heading**, so memory is NOT branch-scoped. `memoryForBrief` reads scopes `global`, `repo:<repo>` and `graph:<graph_id>` (index-store.ts:2047-2060) and takes the newest 10 standing rows.
- The brief surfaces only **decisions and warnings** (brief.ts:361-375). Facts and todos are not briefed and need `memory_search`.
- **Recommended:** mint one Graph ID per workflow run (`ut-${Date.now().toString(36)}-${8hex}`), use it as the run id, `graph_register` it with the cards as nodes (`node_id`=cardId), and `graph_bind` `openflow:<workflowId>:<runId>` to it. Use the cardId as `node_id` and `session_id=openflow-<runId>-<cardId>` on events.

**E. Live probes** (SUBSTRATE_URL is loopback; token never printed)
- `GET /healthz` → 200. index, greptime, appendOnly and eventsWritable are all true; ledger writable. Planes greptime, index, cache, hindsight and ragflow are `ok` with breakers closed. Past timeouts are recorded on the hindsight and ragflow planes. memory_entries holds ~96 live rows.
- `POST /brief {repo:"SeeRay11/OpenFlow",branch:"dev"}` → 200, 271 bytes, 6 lines, `x-substrate-brief: complete`, ETag present. Full text:
```
## Substrate brief: SeeRay11/OpenFlow @ dev

Last 3 agent actions in this repo
- 13:11 omp          ultrathink planned graph ut-mvf9vsaa-a99417c4 (8 nodes)
- 13:08 omp          herdr: idle → working (pane wC:p2)
- 13:07 omp          herdr: unknown → idle (pane wC:p2)
```
- `POST /events/query {surface:"omp"}` → 200. `limit:500` returned count 500 with `truncated:true`, so there are more than 500 omp events. Kinds seen: note, session.start, session.end.
- Extra read-only: MCP tools/list works (26 tools). The `memory_search` call with `scope:"repo:SeeRay11/OpenFlow"` returned `entries:[]` but `degraded:true` (derived `recall-timeout`). The `subject_prefix:"openflow"` search returned `{entries:[],next:null}`. So **no OpenFlow memory exists yet**.
- No writes were made.

**F. Recommended OpenFlow design**
- Surface `omp` (no server change). Each card's omp session gets an MCP entry `substrate` → `${SUBSTRATE_URL}/mcp` with the Bearer header. The host also uses REST for its own calls.
- Writes:
  - Card outcome: scope `repo:<owner/name>` (lower-case), kind `fact`, subject `openflow/<workflowId>/card/<cardId>/outcome`, ttl `30d`, `graph_id=<runId>`, key `idempotency_key=openflow:<runId>:<cardId>:outcome`.
  - Key decisions: kind `decision`, subject `openflow/<workflowId>/<topic>`. Retry with `expected_version` taken from `current_version`.
  - Failures and caveats: kind `warning`.
  - Run-local scratch and handoff: scope `graph:<runId>`, kinds fact or handoff.
  - Never write `global`.
- Reads before a card starts: `POST /brief {repo,branch,graph_id:<runId>}`. For prior outcomes, `memory_search {scope:"repo:…", subject_prefix:"openflow/<workflowId>/"}`.
- Minimal host client, all fail-open except memory writes:
  - `brief(ctx)` and `searchMemory` (the latter via MCP `tools/call`, since there is no REST route)
  - `emit(event)`
  - `writeMemory(entry)`, retrying the same `idempotency_key` on 202/5xx/timeout
  - `bindGraph` and `registerGraph`
  - `health()`
- Degradation:
  - Reads (brief, events, search) fail open with a timeout of 1–2 s and no brief on error.
  - Event emits swallow failures (`stored:false` is logged, never thrown).
  - Memory writes are fail-closed: surface the failure to the card, and never claim success unless 200 and `verified_persisted`. 202 means retry, 403/409/422 means handle by `reason`.

**G. Test plan** (rehearsal twin, not the shared substrate)
1. `bun run rehearsal up --name openflow --surfaces omp,claude-code` (needs Docker images; `--pull never`). `set -a; . $XDG_RUNTIME_DIR/substrate-rehearsal/openflow/consumer.env; set +a`. `SUBSTRATE_TOKEN` = first non-swarm surface's token, which is `omp` because it is listed first. The twin refuses port 7410.
2. Run 1: mint `runId1`, `graph_register`, then write the outcome for card X (above). Assert 200 + `verified_persisted`. Replay the same key and expect `deduplicated`. Write the same decision subject without `expected_version` and expect `version.required` plus `current_version`. Send text containing a fake key and expect 422 quarantine.
3. Run 2: new `runId2`. `POST /brief {repo, graph_id:runId2}` must not show the fact (facts are not briefed). `memory_search subject_prefix:"openflow/<wf>/card/X"` must return run 1's outcome. Also write a decision and a warning in run 1 and assert they appear in run 2's brief.
4. Degradation: `bun run rehearsal pause --store index` while the host does brief/search (empty, no throw) and a write (503 / failure surfaced). `unpause`, then retry the same key and expect success. Then `rehearsal down`.
5. Token and RBAC: wrong bearer → 401; `global` write → 409 `review.required`; `person:` → 403.

**H. Risks**
- No `openflow` surface, so everything is attributed to `omp` and is mixed with other omp activity. Use `session_id` and a subject prefix. The `omp` bank is also shared with other omp users.
- `ttl:"graph"` with an unregistered graph counts as expired immediately.
- Facts and todos are not briefed, only decisions and warnings, and only the newest 10 (a busy repo can crowd the brief). Cross-run recall needs `memory_search`.
- Branch is not a memory key, so runs on different branches share repo memory.
- There is no hard delete; the double-gated sweeper and Hindsight copies persist.
- Event idempotency is off, so retried emits duplicate rows.
- `memory_search` currently reported `degraded:true` (recall timeouts) even while the governed index returned results. Treat degraded as a normal case.
- Quarantine can drop outcome text that contains a secret, PII or hedging in a decision/fact ("might/probably"); speculative wording is quarantined.
- Substrate and Hindsight planes have shown timeouts. Keep client timeouts short.