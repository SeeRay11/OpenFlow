All paths below are relative to packages/flow/src. This is a read-only study. Nothing was run, and the rest of the 2265-line engine.ts (about 1200–1760 and 1800–1940, the orchestrate/gauntlet bodies) was skimmed rather than read.

## 1. Existing contract, as engine.ts consumes it

`EngineDeps.api` is a `Pick` of client.ts at server/engine.ts:254-291.

| member | input → output as consumed | semantics the engine relies on |
|---|---|---|
| `subscribe` | `(cb:(e:BusEvent)=>void, signal)→Promise<void>` | Resolves on stream end or abort; engine does `.catch(()=>undefined)` (engine.ts:687-). Best-effort; usage is re-read afterwards. |
| `createSession` | `{agent?,model?,directory?}→{id}` | `agent` is the generated agent key and `directory` is the per-card worktree (engine.ts:907-914). The directory is fixed for the life of the session. |
| `prompt` | `(sessionID,text,files:Attachment[])→any` | Resolves when the prompt is admitted, not when the turn ends (engine.ts:955). |
| `waitForIdle` | `(sessionID,{signal,timeout})→void` | Returns silently on abort. Throws "timed out waiting for the session to finish" or "the session never started executing…" (client.ts:318-345). Idle is derived from the active-session set plus a finished assistant message (`finish` or `error`). A 20s admission grace applies. |
| `transcript` | `(sessionID)→{text:string,error?:string}` | `error` is already run through `describe`. A non-empty `error` is thrown as the node failure (engine.ts:963). |
| `interrupt` | `(sessionID)→void` | Never throws; called from `stop()` for every id in `active`. |
| `replyPermission` | `(sid,reqID,"once"\|"always"\|"reject")` | Throw → notice "permission reply failed". |
| `replyQuestion` | `(sid,reqID,answers:string[][])` | Positional, one array of chosen labels per question. |
| `rejectQuestion` | `(sid,reqID)` | Used when unanswered or after `questionTimeout`. |
| `accepts` | `(model:ModelInfo\|undefined, mime)→boolean` | Sync. Reads `model.capabilities.input`. Also called with `"image/png"` for `imageBlindNote` (engine.ts:950). |
| `models` | `()→{providerID,id,capabilities?.input,cost?:Price[]}[]` | Keyed `${providerID}/${id}` into `catalog` (engine.ts:1979). Used for unknown-model rejection, one `catalogRetry` re-read, pricing, and `accepts`. |
| `agents` | `()→{id}[]` | `unknownAgents` (engine.ts:2241) compares ids to `node.agent.name`. |
| `agentsUnscoped?` | same | Optional. Used only when `agents()` is empty. |
| `describe` | `(unknown)→string` | Single source of error text. See the regex classifiers below. |
| `sessionSteps?` | `(sid)→StepUsage[]` | Authoritative usage, merged by `messageID` in `reconcile` (engine.ts:583). It runs in `finally`, so it runs on failure and stop too. On throw the engine notices "could not read usage". |
| `sessionCalls?` | `(sid,limit=30)→ToolCall[]` newest first | Only used by `decide()` (engine.ts:1852), and gated by `toolChannel` = `MCP_REACHES_SESSIONS` = false (graph/dispatch.ts:60). It is dead code today. |

Error classifiers are regexes on the `describe()` text (engine.ts:1142-1191):
- **`rateLimited`**: `/\b429\b|rate.?limit|too many requests/i`.
- **`transient`**: not rate-limited, no `\b4(0-2)\d\b`, and matches `5xx`, bad gateway, service unavailable, gateway time-out, internal server error, `econnreset`, `econnrefused`, `etimedout`, `enotfound`, `eai_again`, `epipe`, `socket hang up`, `fetch failed`, `network error`, `connection closed/reset/refused/error`, or `premature close`.
- **`sessionLost`**: `/session (not found|does not exist|expired|closed|invalid)|unknown session|no such session/i`.
- **Retry budgets**: `RATE_LIMIT_RETRIES` = `TRANSIENT_RETRIES` = 3, counted separately. Wait is `rateLimitBackoff*2^attempt`, and `rateLimitBackoff=0` disables retries.
- **Session loss** drops the card's session and recreates it, charged on the transport budget.
- **`describe` fallback**: `unknown error`; with a Response it appends `(HTTP n statusText)`.

## 2. Bus events (server/engine.ts:687-745, server/activity.ts:92-240)

All events are `{type, data?}`; events without `data.sessionID` are ignored.

| type | fields read | effect |
|---|---|---|
| `session.created` | `sessionID`, `info.parentID` | activity only: child session → node, depth+1, `callID` = last `task` call |
| `session.next.step.started` | `assistantMessageID`, `model{providerID,id}`, `agent` | engine: `stepModel[msgID]`, `patch{status:"running",activity:"thinking"}`; activity: `step:<id>` row titled "agent · provider/model" |
| `session.next.step.ended` | `assistantMessageID`, `tokens{input,output,reasoning,cache{read,write}}` | usage map keyed by `messageID`, then `reprice()` → `patch{usage}` and `log.usage`. Skipped if `tokens` is missing. |
| `session.next.step.failed` | `assistantMessageID`, `error` | `patch{activity:"failed"}`; error note row |
| `session.next.text.started`/`.delta` | `textID`, `delta` | `patch{activity:"writing"}`; streaming `text:<id>` row (running) |
| `session.next.text.ended` | `textID`, `text` | row done |
| `session.next.reasoning.delta`/`.ended` | `reasoningID`, `delta`/`text` | `reasoning:<id>` row |
| `session.next.tool.input.started` | `callID`, `name` | `tool:<callID>` row running; `name==="task"` marks a spawn |
| `session.next.tool.called` | `callID`, `tool`\|`name`, `input` | `patch{activity:"tool: X"}`; row titled `describe(tool,input)`, input rendered |
| `session.next.tool.progress` | `callID`, `content[]` | row body |
| `session.next.tool.success` | `callID`, `content[]`\|`result`\|`structured` | `patch{activity:"thinking"}`; row done |
| `session.next.tool.failed` | `callID`, `error`\|`result` | `patch{activity:"thinking"}`; row `status:"error"` |
| `permission.v2.asked` | `id`, `action`, `resources[]` | `answer()` (engine.ts:750) |
| `question.v2.asked` | `id`, `questions[]` | `inquire()` (engine.ts:813) |

Engine logic reads the activity rows back, not the bus:
- `writesOf(events, turnStarted)` reads tool rows. Its input shapes are not read here: [INFERENCE] they come from `tool.called` input keys such as `path`/`filePath`.
- Failed tool calls count as rows with `kind==="tool" && status==="error" && at>=turnStarted`.
- The "ran a shell" test is `title.startsWith("bash")`.

So the Omp mapping must preserve tool names `bash`, `edit`, `write`, `patch`, `read`, etc., and the row title prefix.

## 3. Shapes a replacement must produce

- **Transcript**: `{text:string, error?:string}`. `turnText(messages)` (client.ts:477) scans messages newest first. It stops at a user message that has a top-level `text`, takes the first assistant message with non-empty joined `content[].type==="text"`, and `error` comes from the newest assistant message.
- **Message**: `{id, type:"user"|"assistant", text?, content?:Part[], error?, finish?, tokens?:{input,output,reasoning,cache:{read,write}}, model?:{providerID,id}}`. A tool part is `{type:"tool", id, name, state:{input}}`.
- **`ToolCall`**: `{id:string, name:string, input:unknown}`.
- **`StepUsage`** (graph/types.ts:212): `{messageID, model:"provider/id", tokens:{input,output,reasoning,cacheRead,cacheWrite}}`.
- **`Turn`** (server/sessions.ts): `{role:"user"|"assistant", text}`. `SessionRow`: `{id,title,agent?,model?,parent?,created,updated}`.
- **Omp native** (omp://session.md:140-165): assistant `{role:"assistant", provider, model, content:[{type:"text"}|{type:"toolCall"}], usage:{input,output,cacheRead,cacheWrite,totalTokens,cost{total}}, stopReason}`, plus separate `toolResult` messages.
  - Omp has no `reasoning` token field, so map it to 0.
  - Omp's `input` excludes cache; this matches the contract in usage.ts, where `contextSize` adds the cache back.
  - Omp's own `cost` is available but is ignored today; the engine prices client-side.

## 4. Who writes and reads each field

- **`NodePatch`** has these fields (the UI type `NodeRuntime` in state.ts:20 omits `reused`, `ranShell`, `diff`).
  - **`status`, `sessionID`, `output`, `error`, `prompt`, `activity`, `started`, `finished`, `reused`, `usage`**: written by engine `patch()`.
  - **`diff`**: written in the orchestration batch path (`treeStat` / `mergeWorktrees`).
  - **`ranShell`**: written from the judging turn, and read in `RunNodeLog` by `graph/coach`.
  - **`sessionID`**: shown in inspector.tsx:213 and activity-drawer.tsx:101.
  - **`prompt`**: inspector.tsx:259 ("sent prompt").
  - **`activity`**: activity-drawer.tsx:97.
  - **`usage`**: spend panel and `costLabel`.
- **`EngineHooks`** (wired at app.tsx:833-860): `onNode`→`actions.patchRuntime`, `onNodeEvent`→`pushEvent`, `onRun`→`setRun(clone)`, `onNotice`, `onPermission`/`onQuestion`/`onQuestionClosed`, `onEngineStale` (opens the restart dialog).
- **`RunLog`** is built in `start()` (engine.ts:530) and persisted by `deps.saveRun`. It is checkpointed every `checkpointEvery` ms and read by the Runs menu and `announce`. The fields `rounds`, `best`, `verdict`, `usage` and per-node `steps`/`events` are written by the engine.
- **`RunOptions`** come from the UI (app.tsx:~880): `pipe`, `permissions`, `maxParallel`, `nodeTimeout`, `attachments`, `resume`, `sessions`. The rest (`questionTimeout`, `checkpointEvery`, `catalogRetry`, `rateLimitBackoff`, `toolChannel`) are test knobs.

## D. Insertion points (server/engine.ts)

The single choke point for every send (pipeline, swarm, orchestrate, `runSubagent`, critic, verify) is `runTurn` (871).
- The prompt text is assembled at engine.ts:948-952: `build(skipped)` + image-blind + scratch notes.
- `patch({prompt:text})` is at 953, and `api.prompt` at 955.

**(a) Uplift**: between 952 and 953, as `text = await deps.uplift?.(node, text, {kind, reuse}) ?? text`.
- It then runs before the UI "sent prompt" and before the send.
- Jev decisions and `reassignPrompt` pass through the same line.
- Protocol re-asks (`verdictPrompt`, `forceFinalPrompt`, `dispatchResultPrompt`) pass through it too. Uplift should skip or pass them through [INFERENCE]; the `build` closures know which kind they are.

**(b) Memory read**: also before 952, as an extra section after `build(skipped)`. Memory write goes after 1040 (`outputs.set(node.id, answer)`), before `patch status:"done"` at 1043. A write on failure or stop belongs in `finally` at 1128, next to `reconcile`.

**(c) Swarm progress**: the Omp-specific `subscribe` handler (687-745) is the place to `patch({activity})`. The inter-card progress hooks (`activity.note`) already exist at the batch and round level (`runPeer` 1233, `orchestrate`).

## A. Proposed `EngineApi` (names reused; new = Omp-only)

```ts
export type Backend = Pick<typeof api, never> & {
  subscribe(onEvent:(e:BusEvent)=>void, signal:AbortSignal): Promise<void>
  createSession(i:{agent?:string; model?:string; directory?:string; tools?:Record<string,boolean>; mcp?:string[]; system?:string}): Promise<{id:string}>
  prompt(sessionID:string, text:string, files?:Attachment[]): Promise<unknown>
  waitForIdle(sessionID:string, o?:{signal?:AbortSignal; timeout?:number}): Promise<void>
  transcript(sessionID:string): Promise<{text:string; error?:string}>
  interrupt(sessionID:string): Promise<void>
  replyPermission(sid:string, reqID:string, r:PermissionReply): Promise<unknown>
  replyQuestion(sid:string, reqID:string, a:string[][]): Promise<unknown>
  rejectQuestion(sid:string, reqID:string): Promise<unknown>
  accepts(model:ModelInfo|undefined, mime:string): boolean
  models(): Promise<ModelInfo[]>           // {providerID,id,capabilities?:{input:string[]},cost?:Price[]}
  agents(): Promise<{id:string}[]>
  agentsUnscoped?(): Promise<{id:string}[]>
  describe(e:unknown, r?:Response): string
  sessionSteps?(sid:string): Promise<StepUsage[]>
  sessionCalls?(sid:string, limit?:number): Promise<ToolCall[]>
}
export type EngineDeps = { api: Backend; saveRun; worktrees?; treeStat?; checkpoint?; scratch?; serveStatus?;
  uplift?: (node:FlowNode, text:string, ctx:{kind:string}) => Promise<string>   // NEW
  memory?: { read(node,runId):Promise<string>; write(node,runId,out:string):Promise<void> }  // NEW
}
```

Implementation notes for the Omp driver, one `omp --mode rpc` child per session:
- `prompt` → `{type:"prompt",message,images}` (ack at admission, like today).
- `waitForIdle` resolves on `prompt_result`/`session_settled`. `status:"error"` carries `{message,httpStatus,retryable}` and should be rendered into the `describe` text with `HTTP 429` etc., so the regexes keep working.
- `interrupt` → `{type:"abort"}`.
- `transcript`/`sessionSteps` → `get_messages_page`.
- `models` → `get_available_models`, with a spawned process or a cached catalog.
- `createSession` → spawn the process (+`new_session`), and `set_model {provider,modelId}`.

## B. Omp event → BusEvent mapping (from omp://rpc.md)

| Omp frame | BusEvent |
|---|---|
| `turn_start` / `message_start` (assistant) | `session.next.step.started` (`assistantMessageID`=messageId, model from the message) |
| `message_update` `text_delta` | `text.delta` (`textID`=messageId+idx) |
| `message_update` thinking delta | `reasoning.delta` |
| `message_end` (assistant) | `text.ended` + `step.ended` (`tokens` from `usage`: input, output, reasoning 0, cache{read,write}) |
| `tool_execution_start` | `tool.input.started` + `tool.called` (`callID`=toolCallId, `tool`, `input`) |
| `tool_execution_update` / `tool_stream_update` | `tool.progress` |
| `tool_execution_end` | `tool.success` or `tool.failed` (by `isError`) |
| `auto_retry_start` | a `step.failed` note, or ignore |
| `extension_ui_request` method `ask` | `question.v2.asked` (options→`{label,description}`); `extension_ui_response` answers `{id,selectedOptions,customInput}`. Reply shape differs from `string[][]`: map positionally. |
| `subagent_lifecycle`/`subagent_event` (with `set_subagent_subscription`) | `session.created` with `parentID` plus child events |
| (none) | `permission.v2.asked`: Omp RPC has no permission-ask frames. The `policy`/`manual` path becomes a no-op unless a `tool_call` extension hook is added. |

## E. Test compatibility

The harness (engine.test.ts:107-424) builds `api: EngineDeps["api"]` directly and passes `deps` to `start(..., deps)` (line 424).
- Only types are imported from client.ts: `BusEvent`, `PermissionReply`, `QuestionInfo` (line 4).
- **Stable**: `start()` signature, the `EngineDeps` field names, and the BusEvent names and fields (tests emit `session.next.*`, `permission.v2.asked`, `question.v2.asked`, `session.created` literally at lines 391-417, 728-757, 943, 1863, 2547 and around 3072-3420).
- **Stable**: the optional-ness of `sessionSteps`, `sessionCalls` and `agentsUnscoped`, the `waitForIdle` option names, and `describe` text conventions.
- **client.test.ts** imports `describe`, `parseModel`, `formatModel` and `turnText` from `./client`; keep that file's exports, or move the tests with the functions.
- Other consumers of `./client` are UI (inspector, mcp-panel, project-picker, providers-panel, sessions-panel, app.tsx) and `providers.ts` (type `Integration`). They call `agents`, `health`, `connect`, `disconnect`, `integrations`, `connectKey`, `removeCredential`, `testModel`, `mcp*`, `sessions`, `sessionTranscript`.
- Adding `uplift`/`memory` as optional deps keeps all 3600 lines valid.

## F. OpenCode-specific behaviours → Omp needs

1. **Agents merged into opencode.json**: `agentBlock`/`agentKey` (store.ts:336-375) plus `store.saveAgents`, called from `syncAgents` (app.tsx:642). The engine's unknown-agent preflight, "stale config restart" and `onEngineStale` all stem from it. Omp has no server cache, so drop the preflight, or implement `agents()` as "the pipeline's own keys".
2. **Permission rules per tool toggle**: `TOOL_ACTIONS` (store.ts:247-258) lists `read, grep, glob, edit, bash, webfetch, websearch, todowrite, skill, question`; mcp as `"<server>_*"`. Omp needs a per-session tool allowlist (`--tools`, or an extension) and the same names, because the engine matches `bash`/`edit` titles.
3. **Permission asks**: `answer()` (engine.ts:750) rejects `MUTATING` (`edit`,`write`,`patch`) for gauntlet critics and root. Omp has no ask frame, so it needs either tool filtering by role at spawn or a `tool_call` hook that blocks.
4. **Session directory/location, per-card worktrees**: `nodeDir` → `createSession({directory})`. Omp's equivalent is the child's `cwd`.
5. **MCP dispatch tool**: parked (`MCP_REACHES_SESSIONS=false`, graph/dispatch.ts:60). Omp can reach MCP, so `sessionCalls` could be turned on; the text fallback (`parseDispatch`) stays.
6. **Zen `-free` models**: `store.zenModels`, `providers.ts` `isFreeModel` (opencode provider, id ending `-free`), `suggestedFreeDefault`. These are meaningless on Omp; the model picker and `app.tsx:1559` free-model probe need a new source.
7. **Client-side pricing and the unpriced gate**: `summarize(steps, catalog)` needs `catalog[model].cost`. In `exhausted()` (engine.ts:1787) any unpriced model stops a gauntlet that has `maxSpend`. Omp's `get_available_models` must carry per-1M cost, or the gauntlet gate must read Omp's own `usage.cost.total` [INFERENCE; the cost field's shape in `get_available_models` was not verified].
8. **Attachments**: data URLs go as `files`. Omp uses `images` (ImageContent) for images only; non-image files would need inlining as text.
9. **Models**: `"provider/id"` strings are split on the first `/` (`parseModel`).

## G. Risks

- Error text is regex-classified, so the Omp driver must emit `HTTP <status>` in error strings.
- Idle detection is currently polling plus a grace window; `prompt_result` is cleaner but `status:"aborted"` must not be treated as success.
- Omp processes are heavy (one per session), and reuse across `runTurn` (swarm/gauntlet critic sessions) means session loss on process death must emit "session not found" to trigger recreation.
- Message ids must be stable and unique per assistant turn, since they are the usage dedupe key.
- The usage `reasoning` field is zero, so usage under-reports reasoning-token billing if Omp folds it into `output` (it likely does); this matches the unreconciled-price convention but must be checked.
- Uplift on protocol turns may corrupt the control-block format.
- The app currently needs `opencode serve` for model, provider and key management (`integrations`, `connectKey`, `testModel`, MCP panel, sessions panel); that surface has to be replaced separately.