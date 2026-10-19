# Durable Engine — Research Findings & Integration Design

> **Review (2026-10-19, follow-up session). Read this before the original text below; parts of it were wrong.**
>
> **What the original text claimed vs. what was true**
> - *"Implementation not started… this worktree is still clean."* **False.** The branch already had two commits:
>   - `63ca241`: dependency pins;
>   - `3655eeb`: gateway tools passthrough.
>
>   It also had ~1,300 uncommitted lines: the engine, harness, adapter, index, migration `0086`, and the `builtin-json` refactor. The plan was committed **directly on main** (`9b3c4d4`).
> - **No tests existed** for any of it, contrary to the TDD guardrail and the "proof plan" below.
> - **The code didn't typecheck (6 real errors):**
>   - the committed gateway change let the `tool` role leak into the API-shape adapters (`llm-client.ts:842`);
>   - `gateway-model.ts` used `arguments` as a variable name (illegal in strict mode) and had type errors.
> - **State path:** it is `/var/lib/ee-state/os/agent/` (the workload is named `os`), not `…/eigenenterprise/agent/`.
>
> **Defects fixed in this session**
> 1. **Cross-user tool execution.** The kernel tool bridge was one process-wide extension, replaced on every dispatch with closures bound to that dispatch. Two people chatting at once could have A's tool call run with **B's principal**. Fix: calls route by `api.conversationId` to the bridge of the dispatch that owns that conversation. A call resumed after a restart (no live request) returns `not_run` instead of executing as anyone. Covered by a concurrency test.
> 2. **The lock froze the server.** `Atomics.wait` blocked the event loop for up to 2 s. It is now an async wait, sized at 30 s to outlast a blue-green handover. The lock is released if the open fails; before, a failed open locked the process out of its own state.
> 3. **Resume only happened lazily.** After a crash, pending turns resumed only when someone chatted again. Boot now opens the harness in the background (with retries) when the orchestrator runs on `durable`.
> 4. **Substrate bug, missed entirely.** Concurrent blue-green slots got different DynamicUser UIDs, and starting the candidate re-chowned the shared `StateDirectory` under the slot still serving. **Verified on the box**, fixed in ee (`9a3748d`, `User=ee-<workload>`).
> 5. **"The orchestrator flips to durable" (D6) would break chat for the Claude Pro/Max and ChatGPT subscription sign-ins**: their API-shape adapters can't carry tool calls, and the gateway (correctly) fails loud on that. The orchestrator's engine is now an explicit choice, `EE_ORCHESTRATOR_ENGINE=durable|builtin-json`, with `builtin-json` as the engine of record until those adapters support tools.
>
> **Proven since**: unit tests for the state-dir matrix, the lock (contention, stale steal, no event-loop block), the adapter, and the engine over real pi-durable (plain turn, tool call, approval_pending, history, **two users at once**), plus a **real SIGKILL crash-resume test**: a child process dies mid-model-call, the reopened harness re-runs that turn, and its answer is in the history.
>
> **Not done yet**: the D8 visibility surface (SSE + UI), the e2e on the dev server, and a box run on `durable`, which needs an OpenAI-compatible provider and a signed-in owner (so email delivery).


**Workstream:** `wt/durable-engine` (this worktree) · **Plan:** [`plan/phase-durable.md`](plan/phase-durable.md) (committed to main as `9b3c4d4`)
**Date:** 2026-10-19 · **Status: research complete, design committed, implementation not started** (the first implementation agent was cancelled before making any changes — this worktree is still clean).

---

## 1. What "PyDurable" actually is

The link (earendil-works/pi → `packages/durable`) is **not Python**: `@earendil-works/pi-durable` is a **TypeScript, MIT-licensed, ESM-only durable agent harness** (v1.3.0 on npm). The owner's intent maps 1:1 anyway — it delivers exactly the wanted properties:

| Wanted | What pi-durable provides |
|---|---|
| "Inherently durable" | Conversations, model turns, tool calls and host state are **committed to storage before anything is shown**; a crashed process reopens storage and resumes the pending turn from its checkpoint (`running → pending` reconcile at open). Crash mid-model-call loses at most the last 100 ms of stream partials. |
| "Durable objects" | Durable **tasks**: state machines with committed checkpoints (`pi.generation`, `pi.tool`, `pi.compaction` built-ins; `defineTask()` for host tasks); crash-safe tool execution (intent committed **before** `execute()`, rerun after crash only if declared `replay: "safe"`). |
| "Multiplayer" + "traceability / visibility for the team" | Watchable state: `viewState()`, `watch()` (exact op frames), **`watchEvents()`** — one event batch per commit, snapshot on connect. Server-side fan-out to browsers (SSE) is our job — that's the visibility surface. |
| No Cloudflare, SQLite, bare-metal VPS | Storage backends: Memory / **Node SQLite** (`node:sqlite`, one file, WAL — **zero native modules**) / JSONL / Cloudflare DO. SQLite-on-the-VPS is the intended non-Cloudflare shape. Embedded library, not a server. |

Verified facts (against the **published 1.3.0 tarball**, executed live on Node 22.22.3 — smoke run: open → submit → settled "done" → events streamed):

- **Requires Node ≥ 22.19** (`node:sqlite`). Local dev: 22.22.3 ✓. ee box installer pins **22.23.3** ✓ — no installer change needed.
- **Pin exact `1.3.0`** for `pi-durable`, `pi-ai`, `chord`. GitHub `main` already carries breaking changes for the next release (durable sleeps, telemetry schema, `onWake`, SQLite schema **v2** — once we bump past 1.3.0 the data dir may not roll back). Upstream went 1.0→1.3 in 10 days, every release breaking. All pi-durable imports must live behind ONE server module.
- Install: `npm install -E @earendil-works/pi-durable@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/chord@1.3.0`
- **No cross-process locking at all.** Two processes on one file eventually fail via id-mint collisions (`SessionFailed`) — possibly after double-running tasks. The host must enforce single ownership (lockfile) itself.
- `createConversation({ ownership: { kind: "ownerless" }, agent? })` exists in 1.3.0 (verified in `dist/harness/types.d.ts:653`) → per-chat-session conversations are supported, not just the reserved `root()`.
- pi-durable passes the conversation's **provider session UUIDv7** (from the `pi.provider` doc) into every model call as `options.sessionId` (verified `dist/harness/generation.js:125`) → crash-safe key for per-user billing attribution in Postgres.
- Custom model provider is a plain `{ stream, streamSimple }` api object returning an `AssistantMessageEventStream` — **pi-ai makes no HTTP calls if we hand it our own api**. Reference implementation to copy: `pi-ai/dist/providers/faux.js` (+ `createAssistantMessageEventStream` from `@earendil-works/pi-ai/utils/event-stream`).
- `watchEvents` event types (1.3.0): `snapshot, run_start, run_end, turn_start, turn_end, message_start, message_update` (text/thinking/toolcall deltas), `message_end, tool_execution_start/update/end` (with `toolCallId`, `taskId`), `inbox_update, submission, auto_retry_start/end, deferred_poll, entry_appended, agent_changed, usage_changed, task_failed, compaction_start/end`. Late joiners get a fresh `snapshot` when >100 batches behind.
- Crash recovery on bare metal = reopen + `resume()` at boot (1.3.0 has no durable sleeps; systemd restart picks everything up).
- Runtime fit: ESM only, `sideEffects: false`, leave **external** in the SvelteKit SSR build (default). Heavy optional deps (`photon` WASM, `pi-codemode`, provider SDKs) are never loaded by the paths we use.
- No Postgres storage adapter exists upstream; SQLite file is the intended local backend.

## 2. Where it plugs into eigenEnterprise (seam analysis)

Full runtime map was produced (file:line-level; summarized here):

- The orchestrator's turn loop is a **LoopEngine** (`src/lib/kernel/engine.ts` contract, `src/lib/kernel/engines/builtin-json.ts`), registered next to the `pi` coding-agent engine at boot (`src/lib/server/boot.ts:146`). `AgentConfig.loopEngine` selects per agent. **→ Register a third engine `durable`. Nothing existing breaks; journeys (`JourneyAwareAgentRuntime`) and spend/budget machinery are engine-agnostic.**
- Tools: `EngineContext.executeTool` → `KernelRegistry.execute` (activation ∩ roles ∩ approvals ∩ audit ∩ vcs). **→ The durable engine mirrors the current `selectToolSurface` into pi-durable tools whose `execute` calls the registry — permissions/approvals/audit inherited for free**, plus pi-durable persists tool intents/results durably.
- Model calls: guardrail says everything goes through `src/lib/server/llm/` (`llmChatCompletion`: BYOK resolution, rate limits, retries, `activity_call_log`, PostHog). **→ The custom pi-ai provider calls `llmChatCompletion` — no direct provider HTTP.** Gap found: the gateway has **no `tools` parameter today** (the JSON-protocol engine worked around it with "answer in JSON" prompting) → the gateway gains an optional OpenAI `tools`/`tool_calls` passthrough, still the only door.
- Persistence today: user chat row written before dispatch, assistant rows **after** the full reply — a mid-turn crash loses the turn. **That is the exact gap pi-durable closes.** Chat-endpoint persistence is engine-agnostic and stays as-is.
- Composition root: `bootApp()` memo resets on HMR; the repo's answer is `globalThis` caching (`recapTickHost`, boot.ts:88). **→ Same pattern for the harness: one per process lifetime, lazy-opened on first dispatch, never closed on recompose** (health gate stays DB-ping only).
- Data dirs: on the ee box the release tree is **read-only** (`ReadOnlyPaths`); ee injects `EE_STATE_DIR=/var/lib/ee-state/<workload>` with a systemd `StateDirectory` that survives blue-green redeploys. **→ SQLite file at `${EE_STATE_DIR}/agent/agent.sqlite`** (explicit `EE_AGENT_STATE_DIR` overrides; neither set → fail loud).
- Risks catalogued: blue-green slots briefly share the StateDirectory (mitigated by lazy-open + lockfile with bounded retry → loud failure, never silent corruption); dev HMR double-open (globalThis guard); `tick-job-queue`-style second processes must never open the store (lockfile catches it).

## 3. Design decisions (D1–D10, committed in plan/phase-durable.md — owner can veto)

1. **D1** Pin exact `1.3.0` ×3; all pi-durable imports behind one module (`src/lib/server/agent/`).
2. **D2** Storage = one SQLite file: `EE_AGENT_STATE_DIR` → else `${EE_STATE_DIR}/agent` → else throw loud.
3. **D3** Single-owner lockfile (pid-stamped, bounded retry, steal-if-stale, then loud); globalThis singleton; lazy open; no graceful-close handler (recovery-on-reopen IS the feature).
4. **D4** All model calls through the LLM gateway via the custom provider; gateway gains optional tools passthrough; no streaming change (one delta, as today).
5. **D5** Tools bridge through the kernel registry (surface refreshed per dispatch; approval_pending semantics preserved).
6. **D6** `durable` is an opt-in LoopEngine; the orchestrator flips to it; `builtin-json` stays compiled in as rollback. The durable engine does NOT write `kernel_agent_session_events` (pi-durable is the history source — no double bookkeeping).
7. **D7** Postgres keeps the index (`durable_conversations`: conversation_key, agent_id, llm_user_id, pi_conversation_id, provider_session_id unique — migration `0086` + journal idx 86 + schema file), SQLite keeps the transcript. Per-user secrets never enter SQLite.
8. **D8** Team visibility = authenticated SSE fanning `watchEvents` (snapshot on connect) + a company surface listing runs and showing the live event feed; multiple browsers on one run = the multiplayer slice. Kernel events stay metadata-only.
9. **D9** Chat UI persistence unchanged. Known gap, on record: a server death mid-turn completes the turn durably (committed, visible in the live surface, in the agent's context) but the chat **bubble mirror** is lost with the dead request — mirroring settled turns is a listed follow-up.
10. **D10** No new services ever: SQLite + in-process harness under the existing systemd unit. Repo `engines.node` → `^22.19.0`.

**Out of scope (follow-ups):** durable background tasks/subagents (software-factory M0 fuel), chat-bubble mirror of settled durable turns, gateway streaming (real token deltas), Postgres storage adapter, compaction/usage surfacing.

## 4. Proof plan

- **Unit**: provider adapter (faux-style), engine dispatch through a real registry fixture (tool call + `approval_pending` path), storage-dir fail-loud matrix, lockfile steal/contension, conversation index, and a **true crash-resume test** (subprocess opens tmpdir SQLite, blocks mid-request, gets SIGKILLed; reopen + `resume()` completes the turn from the checkpoint).
- **E2E** (dev server + mock gateway extended for tool calls): chat on the `durable` engine; the visibility surface shows the run live; a second browser sees the same stream.
- **The box** (fresh `ee/e2e/box.sh` systemd box, real installer, owner signup, mock gateway as BYOK at `http://host.docker.internal:5199/v1`): chat → visibility surface → **`systemctl restart` mid-turn → the turn completes after reboot**, committed events watchable, state file at `/var/lib/ee-state/eigenenterprise/agent/`.

## 5. Current status & next steps

- ✅ Research (2 subagent deep-dives + hands-on verification against the published tarball)
- ✅ `plan/phase-durable.md` committed to main (`9b3c4d4`); worktree `../ee-durable` created (branch `wt/durable-engine`)
- ✅ Docker daemon reachable: `ee-box` (the local VPS) and `eigen-enterprise-db` both healthy
- ⏸️ **Implementation not started** — the core implementation agent was cancelled before any file was touched. The brief is fully specified (deps → gateway tools param → `src/lib/server/agent/{pi-durable,gateway-model,durable-harness,conversation-index}.ts` → `src/lib/kernel/engines/durable.ts` → boot wiring + orchestrator flip → migration 0086 → unit tests incl. subprocess crash-resume).
- Then: visibility surfaces (SSE + UI + mock-gateway tools + e2e) → gates → fresh-box deploy + mid-turn-restart demo → merge to main → `plan/progress.md`.
