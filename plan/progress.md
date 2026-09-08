# Progress Log

Format: newest entries on top. Every milestone gets: what shipped, commit refs, what broke, decisions, what's next.

---

## 2026-09-07 — dev-agent shipped: the repo can now improve itself (gated)

**Shipped**
- **Security chore** (`8f55e76`): redacted hardcoded production Bearer token inherited from eigen in `.pi/extensions/eigen-mcp.ts` → env-based (`EE_MCP_URL`/`EE_MCP_TOKEN`, no fallback). Token remains in seed git history — repo never pushed; rewrite optional.
- **wt/devagent** (`c513370`): `modules/dev-agent` — pi-driven self-improvement. Tools: `dispatch` (external, owner+agent), `status`, `logs` (read), `merge` (mutate, **owner-only**), `abort`. Lifecycle: dispatched → running (pi headless `pi -p --mode json` in sandbox worktree `../ee-da-<id>`, single-flight) → verification gate (vitest + check in worktree) → green|red → merged|aborted. Runs persisted (`kernel_devagent_runs`, idx 73). All seams injected (PiRunner/CommandRunner) — zero real pi/git in tests. `.pi/skills/dev-agent-protocol/` documents the contract. Kernel: `run_in_progress` added to error union (orchestrator).
- **Main: 378/378 tests, `npm run check` at baseline.**

**Decisions**
- `dev-agent.dispatch` NOT approval-gated: the owner-gated merge is the control point; dispatch is audited, single-flight, 15-min capped. Policy can add it later.
- pi binary: `PI_BIN` override, default `'pi'` on PATH (binary-name default, not an env fallback).
- pi output persists truncated (4000) in `result_summary`; never logged at info.
- Local test DB: `postgres://eigen:eigen@localhost:5432/eigen_test` (created + migrated 0000→0073 during this stream); bootstrap script still owed.

**The recursive loop (how to use)**
1. `ee tool run dev-agent.dispatch --input '{"task":"…"}' --principal <owner-id>` (or via Telegram/orchestrator delegation, or MCP from hermes)
2. pi works in a sandbox worktree; kernel verifies tests+types
3. `ee approvals`-style review → `ee tool run dev-agent.merge --input '{"run_id":"…"}' --principal <owner-id>`
4. Merged changes become the new baseline — including changes to the agent itself.

**Next**
- First real dogfood: dispatch a small improvement task end-to-end (needs dev DB running + pi configured).
- Phase 2: owlery engine internalization; Phase 3: sales; brand kernel (plan/phase-1-baseline.md follow-ups).

---

## 2026-09-07 — CLI + Website merged (Phase 1 baseline)

**Shipped**
- **wt/cli** (`aeaf04b`): `src/cli/` — `ee` CLI as **thin dispatcher over kernel registry tools** (no special powers, no MCP hop). Commands: `status`, `tool list/run`, `module list/activate/deactivate`, `approvals list/decide`, `openapi`. New kernel admin tools (`kernel.module_*`, `kernel.approvals_*`) registered via new `admin-bootstrap.ts` ('kernel' module self-active by design). Principal: `--principal`/`EE_CLI_PRINCIPAL_ID`, fail loud. Exit codes: 0/1/3 (approval_required). Runner: tsx (already in devDeps), `npm run ee`.
- **wt/website** (`d15db04`): `modules/website` — content objects (`website_content`: slug/kind page|doc/visibility), tools `create/update/publish/get/list_page`, public rendering at `/s/[slug]` (private→404), contact capture `POST /api/website/contact` → `website_contact` + `kernel_events('website.contact.captured')` (ids only, no content). Markdown via marked+DOMPurify (chat's citation-rewriting deliberately not reused). Tables idx 72. `modules/index.ts` additive registration.
- **Main: 335/335 tests green, `npm run check` at baseline.**

**Decisions**
- CLI decision REVERSED (user): agents need an in-process execution surface; MCP stays external-facing (hermes/opencode), CLI is the company-agent's native hands. Recorded in `plan/phase-1-baseline.md`.
- Baseline company = website + agent (orchestrator), extensible via module contract.
- 'kernel' admin module self-active: can't gate on the store it administers.
- `/s/[slug]` fully anonymous = correct (it's the public web).

**Flags / debt**
- No `bin` entry yet (script suffices; add when packaging). No seeded-DB `ee status` smoke script yet.
- No rate limit on contact endpoint; no contact-listing surface (sales phase); `website.contact.captured` has no consumer yet.
- `modules/index.spec.ts` exact-manifest assertions grow with each module (by design).

**Next**
- Agent self-improvement loop: `pi` agent on this repo (user request) — messages → code changes → kernel-verified (tests/check) → git-committed. Design first: agent principals can already execute every tool; the missing piece is *code execution + repo access* governance (which tools mutate the repo, review gates).
- Then: owlery internalization (Phase 2), sales (Phase 3), brand kernel.

---

## 2026-09-07 — **PHASE 0 CODE-COMPLETE** (orchestrator merged)

**Shipped** (`ab7e84f`, merged to main)
- `modules/orchestrator/`: **brain** (orchestrator persona = agent principal `orchestrator`/roles admin+agent; mirrors agent-loop's JSON tool protocol but executes via `kernelRegistry.execute`; tool surface = registry ∩ activated modules ∩ role-intersection — fail closed; all LLM via `llmChatCompletion` gateway), **loop** (sequential 25s long-poll, 1s→30s backoff, abortable; job-queue deliberately not used — blocking poll ≠ cron), **allowlist admin tools** (`chat-gateway.allowlist_add/remove/list`, owner-only), **bootstrap** (fails loud only when chat-gateway activated but token missing; SQL upsert documented for activations + orchestrator principal row).
- Approval-pending UX: `approval_required` → structured `{"status":"approval_pending"}` tool result instructing the model to tell the user it's pending — the model cannot claim execution.
- **Main state: 212/212 tests green (24 files), `npm run check` = 5 documented baseline errors, lint = baseline.**

**Decisions (orchestrator)**
- App must boot `bootstrapOrchestrator()` at startup (first-call-wins singleton ordering).
- Parse-failure after retries: fail loud → Telegram redelivery (at-least-once). No apology-degradation.
- Orchestrator memory ownership: principal row seeded at bootstrap; ownership refinement deferred to memory-scoping work (Phase 4).

**Phase 0 exit criteria — status**
| Criterion | Status |
|---|---|
| One registry → MCP + OpenAPI | ✅ parity-tested |
| Principals incl. agents, permissions, approvals | ✅ tested |
| Append-only events, activation gating, git auto-commit | ✅ tested |
| Modules: memory, email, chat-gateway manifested | ✅ |
| Orchestrator answers via Telegram | ✅ code-complete — **live smoke test pending user** (needs: `npm run db:up` + `db:migrate`, `TELEGRAM_BOT_TOKEN`, activate `chat-gateway` + `memory`/`email`, allowlist owner's Telegram ID) |

**Known debt (tracked)**
- Web push inert (SW deleted with PWA strip) — Telegram is the channel for now
- `billingMode` column + wallet tables still in DB schema; eigen-green theme; "Eigen Mesh" i18n strings; PWA deps in package.json
- `modules/**` outside svelte-kit tsconfig include; kernel lint chores (interface→type, caught-error rule)

**Next: Phase 1 — Website module** (content objects, brand kernel, public rendering, contact capture) per `plan/phase-0-kernel.md` §Later phases.

---

## 2026-09-07 — Round 2 merged: wire + chat-gateway

**Shipped**
- **wt/wire** (`1c46348`): DB-backed kernel stores (`kernel/db-stores.ts` → kernel_principals/events/module_activations/approvals), module activation gating in `registry.execute` (fail closed when ActivationStore injected), `modules/memory` (7 tools wrapping existing MCP memory impls) + `modules/email` (send_mail=external, add_contact=mutate, list_contacts=read via thin owlery runners), MCP server (`tools/list`+`call`) now renders from the kernel registry, OpenAPI 3.1 generator (`kernel/openapi.ts`), parity test (MCP ↔ OpenAPI ↔ registry).
- **wt/gateway** (`fb9de70`): `modules/chat-gateway` — Telegram long-polling client (DI'd fetch), allowlist→principal resolution (fail closed, denied events carry no content), session upsert, paragraph-aware chunking (4k), `chatGatewayEnv` fails loud without `TELEGRAM_BOT_TOKEN`; tables `kernel_gateway_allowlist`/`kernel_gateway_sessions` (migration idx 71). Brain interface injected — orchestrator loop comes next.
- **Orchestrator on main**: widened approval gate to all non-read tools (`registry.ts`; vcs commit stays mutate-only). `email.send_mail` now halts as `approval_required` — wire's placeholder test updated to assert the decided semantics. Repaired NUL-corrupted `chat-gateway/stores.ts` (subagent write artifact; content intact, git had classified it binary).
- Verification: **178/178** tests green (kernel 58, mcp+modules 120); `npm run check` = 5 documented baseline errors only.

**Broke / flags**
- Root `vitest.config.ts` now includes `modules/**`; colocated `modules/chat-gateway/vitest.config.ts` kept as scoped runner (redundant but harmless).
- `modules/**` sits outside svelte-kit tsconfig include — typechecked transitively; consider tsconfig addition later.
- Pre-existing lint errors in `src/lib/kernel` files (interface→type, caught-error rule) — chore pending.
- DB-dependent suites need `DATABASE_URL` (dev DB not started this session — user starts it).

**Decisions**
- Approval gate: `auditClass !== 'read'` (external actions leave the company — approvals apply). VCS commit: `mutate` only (repo-state changes only).
- MCP principal mapping (Phase-0 parity): session user → human/admin; Bearer key → agent/admin+agent. Real PrincipalStore wiring into auth = next stream.
- Poll-loop ownership + offset persistence + allowlist bootstrap UX + orchestrator persona wiring = next workstream.

**Next**
- `wt/orchestrator`: seed orchestrator persona (agent principal), `Brain.respond` → kernel registry tools via existing agent-loop + LLM gateway; poll loop on job-queue tick; allowlist bootstrap tool; PrincipalStore→auth wiring.

---

## 2026-09-07 — Branding guideline module ruleset (plan only, no code)

**Shipped**
- `plan/branding-module-rules.md` — 25 normative rules (G1–G25) for the future brand-kernel module, derived from NN/g's "Using AI for UX Work" study guide + 32 linked articles (full-text analysis via 4 parallel research subagents; podcasts/videos excluded). Includes kernel-architecture mapping, data-model sketch, validation pipeline, anti-pattern catalog, acceptance criteria, open questions.

**Decisions**
- Voice stored exemplar-first (good/bad pairs as primary representation; single tone adjectives rejected at schema level) — evidence: tone adjectives alone exaggerate.
- Validation = deterministic rule engine (pass/fail in code) + calibrated LLM judge (F1 ≥ 0.8 vs. human annotations before autonomous blocking); layers never blended — Baymard principle.
- Risk-tiered publish gates: heritage/standard content requires human approval; only low-stakes internal drafts may auto-pass. AI drafts, never publishes.
- Guideline sets are versioned; outputs pin the version validated against — no implicit "latest" resolution (no-fallbacks guardrail).
- Synthetic audience feedback is hypothesis-grade: labeled, never satisfies a publish gate.
- Module precedes implementation — feeds phase-0 "Later phases 1: brand kernel".

**Next**
- Grill the open questions in §8 (visual pipeline, judge-model isolation, locales, disclosure UX) before any implementation planning.

---

## 2026-09-07 — Kernel skeleton + product strip merged to main

**Shipped**
- **Strip** (`ebf9295`, merged): removed billing/wallet/PayPal (−10.6k lines, 143 files), PWA/service-worker, product branding (DESIGN.md, assets.af, eigenmesh csv). Relocations: `billing/context.ts`→`db/tenant-context.ts`, `billing/platform-llm.ts`→`llm/`, `billing/preferences.ts`→`llm/`, `byok-ui.ts`→`settings/`. Kept: `llm/gateway-cost`, owlery client, messages/, evals/, docs/.
- **Kernel skeleton** (`fcddc48`, merged): `src/lib/kernel/` — registry (single execute path: permission→approval→zod-validate→handler→audit→vcs-commit), principals, events (append-only contract), modules (fail-closed activation), vcs (GitCommitter, `EE_VCS_AUTOCOMMIT=0` opt-out), approvals (latest-decision-wins gate). Tables: `kernel_principals`, `kernel_events`, `kernel_module_activations`, `kernel_approvals` + drizzle journal idx 70.
- Integration on main verified: kernel tests 30/30 green; `npm run check` 5 errors = documented eigen baseline (vapid ×3, posthog public env ×2); full vitest needs dev DB running (user starts it).

**Broke / flags**
- Service-worker was ALSO the web-push + capture-queue worker — web push is inert until it gets a new home. Accepted for v0 (Telegram is the push channel).
- `billingMode` DB column + wallet tables still in schema (migrations out of strip scope). Cosmetic leftovers: eigen-green theme, "Eigen Mesh" i18n strings, PWA deps in package.json.

**Decisions**
- Approval gate design: registry consults `ApprovalStore.latestFor(tool, principal)` — approved→proceed, pending→`approval_required` (no dup requests), none→create request + throw. Denied → new request.
- Registry collaborators are constructor-injected (EventSink/ApprovalPolicy/ApprovalStore/VcsCommitter); DB-backed stores land next.
- Worktree flow proved: `wt/strip` (mutating) and `wt/kernel` (additive) ran in parallel, merged clean.

**Next workstreams**
- `wt/wire`: DB-backed kernel stores + module manifests (memory, email) + MCP server rendered from kernel registry + OpenAPI generator + parity test
- `wt/gateway`: `modules/chat-gateway/` — Telegram long-polling, session mapping, allowlist (→ principals), chunking; migration idx 71

---

## 2026-09-07 — Phase 0 kickoff

**Shipped**
- `plan/phase-0-kernel.md` — approved architecture (grilled across 5 rounds)
- Repo seeded from eigen (`c4642f1` — tree unmodified: rsync w/o `.git`, `node_modules`, artifacts, `.env`)
- `AGENTS.md` — orchestrator model + guardrails written

**In progress**
- Strip: `billing/` (keep `llm/gateway-cost`), eigenmesh branding, PWA/service-worker, product deploy specifics
- Kernel skeleton: registry, principals, events, modules, vcs

**Workstreams** (worktrees off `main`)
- `wt/strip` — product-strip + import fixes
- `wt/kernel` — `src/lib/kernel/` + `modules/` skeleton (new files only; merges clean)

**Decisions**
- Orchestrator model adopted (AGENTS.md): subagents + worktrees, progress in `plan/`
- CLI dropped from Phase 0; OpenAPI generation stays
- Telegram gateway = company general assistant ("the orchestrator"), allowlist auth
- Strip table (billing out, PWA out, memory/MCP/job-queue/owlery-client in) — see phase-0 plan

**Next**
- Strip merged → tests green → kernel skeleton → pilot modules → orchestrator via Telegram
