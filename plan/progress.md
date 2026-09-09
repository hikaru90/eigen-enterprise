# Progress Log

Format: newest entries on top. Every milestone gets: what shipped, commit refs, what broke, decisions, what's next.

## 2026-09-08 — Phase-2c: explicit model selection — no implicit defaults

**Shipped** (`21ad301` feature, wt/model-selection, rebased onto brand-kernel main, ff-merged)
- **User directive**: never default to gpt-4o-mini (or anything). Model choice is now a dedicated wizard step for EVERY flow, driven by the models.dev catalog via `GET /api/onboarding/catalog/models?provider=…` (works for anthropic/openai-codex whose API shape excludes them from the API-key grid).
- **Pinned defaults removed everywhere**: OpenRouter sign-in no longer pins openai/gpt-4o-mini; Anthropic no longer pins claude-sonnet-4-5; Codex no longer pins gpt-5.1-codex. Connect/poll endpoints REQUIRE the chosen chat model; onboarding completes only after selection. API-key form model inputs start EMPTY with catalog datalist suggestions.
- **Embedding fields render only when the catalog says the provider supports embeddings**; otherwise an honest note (memory features need one later). `getCatalogModelLists(providerId)` returns model lists for ANY catalog id (raw entries cached unfiltered).
- **E2E hardening**: root layout sets `body[data-eigen-hydrated]` on mount (SSR hydration replay was wiping values filled pre-hydration); `fillPersisted` verifies the value SURVIVES a settle window and re-fills; flow-id → catalog-id mapping fixed (github_copilot → github-copilot); mock-gateway fixture extended (anthropic/openai-codex/openrouter/github-copilot entries) and its chat replies are now agent-protocol JSON (tool-first, alternating list_projects/answer per the journey contract).
- **Gates: unit 3473 passed, components 13 passed, e2e 6 passed on BOTH deployment shapes, check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Model lists come from the live catalog even for API-shape-excluded providers (Claude/Codex sign-ins need model pickers too) — the catalog is the single source of model truth.
- No model default anywhere in onboarding; Continue is disabled until a chat model is picked. Server-side, connect/poll reject empty modelChat (400).
- OpenRouter sign-in carries the chosen models through the PKCE cookie (authorize body → callback save) since its completion is a redirect, not a wizard step.

**Tracked**
- Model pickers list the full catalog for the provider; a "recommended" subset per subscription tier would be a UX refinement.
- Settings → LLM still edits models for the two first-class providers only; fold catalog-wide editing into the legacy-deletion pass.

---
## 2026-09-08 — Phase-2c M1+M2 shipped: brand kernel schema + guideline curation module

**Shipped** (`d71dc6b` plan + `a03fb89` feature, wt/branding, ff-merged)
- **Migration 0076** (`drizzle/0076_branding_tables.sql` + journal idx 76, applied to dev DB + functionally smoked): 10 `brand_*` tables — guideline sets (immutable versions, draft|active|retired, **one-active-per-locale partial unique index** so D3 is DB-enforced), voice examples, lexicon, visual tokens, glossary, criteria, assets, validations, judge metrics, calibration cases. CHECK constraints on every enum-ish column.
- `src/lib/server/db/brand.schema.ts` — drizzle schema (consumed only by modules/brand).
- **`modules/brand`** — store (interface + InMemory + Db + lazy `defaultBrandStore()`; lifecycle guards live IN the store), manifest, **10 kernel tools**: `brand.set_create/update/activate/get/list`, `example_add`, `lexicon_add`, `criterion_add`, `token_add`, `glossary_add`.
- **Guards**: activation requires CARE-complete context + ≥2 exemplars incl. ≥1 good and ≥1 bad (G2); single tone words rejected at zod level; curation writes draft-only; active/retired immutable (G23); `getActiveSet(locale)` fails loud — no implicit "latest".
- **G8/D5 enforcement**: mutation descriptors are admin-role AND handlers reject non-human principals (an agent holding the admin role still gets `permission_denied`); `brand.set_activate` is additionally approval-gated (APPROVAL_REQUIRED_TOOLS).
- Wired in `modules/index.ts`; `index.spec.ts` exact-manifest assertions grown by design.
- **Gates: modules+kernel 411 passed / 1 skipped; db 23 passed / 2 skipped; check 0 errors (24 warnings = main's); lint 7 errors = main's pre-existing baseline, 0 in modules/brand.** Migration smoke: second active set per locale correctly violates the unique index.

**Decisions**
- D1–D5 recorded in `plan/phase-2c-branding-module.md` (visual pipeline out of scope v0; dedicated judge identity + explicit `BRAND_JUDGE_MODEL` unset-loud; per-locale sets; layered disclosure; human-only mutations + activation approval gate).

**Next**
- M3 stream: `brand.content_generate` (N≥3 variants via gateway, judge-rank), deterministic→judge validation pipeline, `brand.content_publish` approval-gated with risk tiers.
- M4 stream (separate — touches `src/lib/server/llm/**`): `brand-context` gateway middleware (G4) — CARE block injection + `guideline_set_id` on call records; generation without an active set fails loud.
- M5: calibration + regression + acceptance sweep (§7 checklist).

## 2026-09-08 — Phase-2c approved: brand kernel implementation starts

**Shipped**
- `plan/phase-2c-branding-module.md` — approved phase plan. `plan/branding-module-rules.md` flips PROPOSED → APPROVED.
- **§8 open questions resolved as decisions D1–D5** (vetoable, recorded in the phase plan): D1 visual-asset pipeline out of scope v0 (owlery bootstraps tokens later); D2 dedicated judge identity + explicit `BRAND_JUDGE_MODEL` (unset = loud failure, never a silent generator-model fallback); D3 per-locale guideline sets, one active per locale, explicit-locale resolution (no implicit "latest"); D4 disclosure = site-level statement + per-asset provenance flag; D5 guideline mutations human-admin-only (handler kind check), `brand.set_activate` additionally approval-gated, agent-proposal flow tracked as follow-up.
- Module id `brand`, tool namespace `brand.*`; milestones M1 schema+migration 0076 → M2 store+manifest+guideline tools → M3 generation/validation/publish → M4 gateway brand-context middleware → M5 calibration/regression/acceptance sweep.

**Next:** M1+M2 on `wt/branding` worktree.

## 2026-09-08 — Phase-2b: subscription sign-ins — Claude Pro/Max + ChatGPT via API-shape adapters

**Shipped** (`7fe61c5` plan + `feb8cc1` feature, wt/subscription-signins, ff-merged)
- **Anthropic (Claude Pro/Max) sign-in**: PKCE authorize (state=verifier) opened in a new tab; user pastes the code/redirect URL back (pi's manual_code pattern — no redirect-allowlist dependency); exchange + refresh at platform.claude.com. OAuth requests authenticate via Bearer with Claude Code identity headers (`user-agent: claude-cli/x`, `x-app: cli`), betas `claude-code-20250219,oauth-2025-04-20`, and the required Claude Code system preamble (pi: buildParams).
- **OpenAI (ChatGPT Plus/Pro) sign-in**: device-code flow (`auth.openai.com/api/accounts/deviceauth/*`, verification page `/codex/device`) — same wizard UX as Copilot. Access token is a JWT; `chatgpt_account_id` claim extracted for the required `chatgpt-account-id` header.
- **API-shape adapters** (`llm/api-shapes.ts`): Anthropic messages (non-streaming, `/v1/messages`) and Codex responses (SSE `/codex/responses` accumulation) normalize to OpenAI shape — llm-client's retry loop, cost logging, and PostHog run unchanged. Dispatch gated by `usesApiShape(provider)`; OpenAI-compat path untouched. Embeddings on subscription providers fail loud naming the fix.
- **llm-client**: resolve-on-expiry generalized — github_copilot, anthropic, and openai_codex rotate and persist tokens on expiry; OpenRouter OAuth keys pass through (never expire).
- **Wizard v3**: subscription step now offers Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, and OpenRouter sign-in — paste-code card and device-code card join the API-key catalog form.
- **E2E**: mock-gateway gained Anthropic token/messages + Codex device/SSE stubs; the Claude test captures the loopback callback REQUEST (Chrome replaces the failed navigation's URL) and pastes the full URL; both flows run a real chat turn through the adapters.
- **Gates: unit 3470 passed, components 12 passed, e2e 6 passed on BOTH deployment shapes, check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Anthropic uses manual-code paste (pi's headless pattern) instead of a registered redirect URI — works remotely and self-hosted without any client registration.
- Codex uses the device-code login (not the localhost:1455 browser flow) — same rationale; SSE accumulated server-side (Codex rejects store:true and pi always streams).
- OAuth refresh generalized: anthropic/openai_codex/github_copilot rotate-and-persist on expiry inside loadLlmProviderConfig.

**Tracked**
- OpenRouter sign-in + catalog model defaults are pinned conservatively (gpt-4o-mini / text-embedding-3-small / claude-sonnet-4-5 / gpt-5.1-codex); model PICKERS for subscription providers (catalog or /models endpoints) are the next UX refinement.
- answer_question/retrieve chaining in the agent journey means a first-turn plain answer is rejected (tool-first contract) — subscription e2e asserts the turn completes, not the reply content (journey tests already cover reply semantics with real providers).

---
## 2026-09-08 — Phase-2a: provider onboarding — method → provider (pi-inspired, catalog-driven)

**Shipped** (`01eab7a` plan + `b338c48` feature, wt/provider-catalog-onboarding, ff-merged)
- **Research**: pi's `packages/ai` auth architecture — type-tagged credentials (`api_key | oauth`), `OAuthAuth.isSubscription`, normalized events (`auth_url`, `device_code`). Ported the two web-native flows and adopted **models.dev** (the open model catalog pi generates from) as the provider catalog.
- **Wizard v2 — two questions**: ① "Use a subscription I have" vs "Use an API key" ② provider selection — subscription lists **GitHub Copilot** (device flow) + **Sign in with OpenRouter** (PKCE → permanent key); API-key lists the models.dev catalog (OpenAI-compatible only, chat/embedding model counts, search) with EUrouter pinned first-class.
- **GitHub Copilot subscription, full e2e**: device code shown in the wizard → server polls → GitHub token exchanged for a short-lived Copilot token (proxy-ep → api base derivation, model list) → stored tenant-encrypted (`auth_type/oauth_*` columns, **migration 0075**). Chat-only by design: embeddings absence fails loud naming the fix.
- **OpenRouter sign-in**: `authorize` sets an httpOnly PKCE verifier cookie, OpenRouter redirects back with `?code=`, exchanged for a permanent key, saved + onboarding completed + redirected to `/`.
- **llm-client generalized**: provider ids are free-form text (new providers never need migrations); all non-EUrouter providers route by direct model; OAuth rows resolve + refresh transparently (rotated access persisted under the store lock semantics of `loadLlmProviderConfig`).
- **Gates: unit 3456 passed, components 10 passed, e2e 4 passed on BOTH deployment shapes (incl. the full Copilot device flow headlessly via mock-gateway stubs), check 0 errors, lint = main's 7 pre-existing.** Migration 0075 applied to the dev DB.

**Decisions**
- v1 subscription providers = Copilot (device flow — fully web-native, no client-secret) + OpenRouter sign-in (PKCE with caller-controlled callback). **Claude Pro/Max and ChatGPT subscriptions are the deliberate next step**: they need a redirect-allowlist strategy + Anthropic/Codex API-shape adapters — pi's `anthropic.ts`/`openai-codex.ts` are the reference implementations.
- models.dev is a live dependency with loud failure + retry (never a silent fallback); `MODELS_DEV_CATALOG_URL` / `OAUTH_GITHUB_*` env overrides exist for e2e determinism.
- Wizard strictness by catalog: embedding-capable providers require an embedding model (memory depends on it); chat-only providers (Copilot) warn and defer.

**Tracked**
- Claude/ChatGPT subscription OAuth + Anthropic/Codex API-shape adapter (next pass).
- Settings → LLM remains the legacy two-provider surface; catalog providers currently manageable only via onboarding (reconnect flow = revisit onboarding) — fold into the legacy-deletion pass.

---
## 2026-09-08 — Phase-1d: first-run onboarding IS the first screen (nucleus, ground-up)

**Shipped** (`a1fb017` plan + `8972baa` feature, wt/nucleus-first-run-onboarding, ff-merged)
- **The wizard IS the page**: open `/` without a working provider → `ProviderOnboarding` (nucleus design: white, black borders, sharp, tracked uppercase wordmark) replaces the chatbox entirely. Provider tiles (OpenRouter / EUrouter) → adaptive credential fields → **Connect runs a real 1-token gateway call** (`testLlmProviderConnection`, config-driven routing — env cannot silently complete wizard creds) **before saving** (`saveProviderConfig` + `onboardingCompleted=true`). No skip: no provider, no product. Operator-hint branch for BYOK-disabled deployments.
- **Landing flip /capture → /** — signup (load, callbackURL ×2, post-success), login (×4), settings resetOnboarding. Onboarding is literally the first thing on opening the page; e2e helpers follow (`waitForURL '/'`).
- **Nucleus gate**: load returns `needsOnboarding = !harness && !providerReady` — returning users whose provider vanished see the wizard again; harness accounts never do.
- **Legacy surface reverted to pre-1c**: capture overlay back to its 3-step EigenMesh shape (deletion stays a deliberate later call); capture page lost the 1c provider-step additions.
- **`scripts/mock-gateway.mjs`** — OpenRouter-compatible mock gateway as a second playwright webServer: the wizard's real test-call is proven e2e against a reachable gateway (dummy-URL runs correctly fail the test — feature working as designed).
- **Gates: unit 3442 passed, components 8 passed, e2e 3 passed on BOTH deployment shapes (platform env emptied + present), check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Ground-up per user directive: EigenMesh onboarding copy/design is not carried over; the wizard is EE-native and gates the chatbox. First-run has no skip — fail loud at the front door.
- Connection proof is a real gateway request (1 token, activity-logged), not a key-format check.
- Wizard requires complete working credentials (EUrouter: both rule UUIDs; OpenRouter: both models) — stricter than the permissive Settings form, by design.

**Tracked**
- `release-helpers.completeOnboardingOverlay` still walks the removed install step (pre-existing; production-user e2e helpers need a rewrite for the wizard-first flow).
- Old eigenmesh copy remains in the legacy capture overlay + `/settings` pages until the deliberate legacy-deletion pass.

---
## 2026-09-08 — Phase-1c: onboarding provider setup — LLM config is user-facing, not an env dead end

**Shipped** (`92f96dd` plan + `215c303` feature, wt/onboarding-provider-setup, ff-merged)
- **Typed `LlmNotConfiguredError`** (`src/lib/server/llm/errors.ts` + `isLlmNotConfiguredError` cause-chain walk) thrown by platform-llm, llm-client loaders, llm-config-guard, preferences. Chat error terminal payload threads `code: 'llm_not_configured'` on the wire; `ChatStreamError` carries it. Zero string matching.
- **Onboarding step "Connect your AI provider"** in `capture-onboarding-overlay.svelte` (id-based step flow frozen at mount): EUrouter (base URL + key + rule UUIDs) / OpenRouter (base URL + key + model names). Skippable; operator-hint branch when `BILLING_BYOK_UI_ENABLED=false`. Only shown when `isUserProviderReady` is false (mirrors `loadLlmConfig` fidelity: billingMode-aware, non-throwing env check).
- **`saveProviderConfig` service** — one persistence path for Settings → LLM and the onboarding action (validate, tenant-encrypt, upsert `llm_provider_config`, active provider, `billingMode → byok`). Settings action slimmed to form-parse + BYOK-UI gate.
- **Failed chat turns get a door**: nucleus renders "Set up your AI provider →" under the failed bubble when `code === 'llm_not_configured'`.
- **E2E** (`onboarding-provider.e2e.ts`, 3 tests, green on BOTH deployment shapes — provider env present and emptied): step shown+save via onboarding form, step hidden once BYOK creds exist (via settings form, deterministic on any deployment), skippable.
- **`E2E_PORT` playwright override** — a worktree checkout can e2e its own build instead of silently reusing another checkout's dev server on 5173 (reuseExistingServer trap; cost ~an hour to diagnose — the bug ran main's suite against a stale server and "passed" 14 unrelated tests).
- **Gates: unit 3424 passed, components 8 passed, e2e 3 passed, check 0 errors, lint errors = main's 7 (all pre-existing kernel).**

**Decisions**
- Chat failure deep-links to `/settings/llm` (one form, no duplication) — orchestrator call, user approved plan without picking.
- Onboarding provider setup = per-user BYOK (existing semantics); platform service-account env stays the operator path — coincident in single-tenant self-host.
- Provider step visibility is load-derived (`providerReady`), never an execution gate: the gateway still fails loud; the UI only adds a door.
- Component spec for the overlay enrolled in the browser gate with `$app/*` stub modules (`src/lib/vitest-stubs/`) + alias in `vitest.browser.config.ts` (vi.mock can't intercept virtual modules that fail import-analysis).

**Broke / found**
- `capture-onboarding-overlay.svelte.spec.ts` was stale since the billing strip (`ebf9295`) — expected an install/wallet step the component no longer had; rewritten and enrolled in the browser gate.
- Pre-existing, NOT fixed here (different workstreams): `release-helpers.completeOnboardingOverlay` still expects the removed install step (breaks production-user e2e helpers); `auth.e2e` `text=Capture` strict-mode failure; capture/pricing e2e need LLM env; `tests/qa-*` call the stripped billing API; `release.e2e` PayPal preflight. Kernel lint errors (7) pre-exist on main.
- Worktree checkouts need `.env` copied manually (untracked) or module-init env guards throw; hermetic specs are unaffected.

**Next:** nucleus `/` surface — route auth redirect flip to `/`, identity-in-chatbox; then Phase 2 owlery internalization.

---
## 2026-09-08 — THE NUCLEUS: one white screen, one chatbox

**Shipped** (`9829262` nucleus + `693a5a6` hermetic-env fix + auth dev-links `ea8f5e4`)
- **`/` is now the nucleus**: white screen, one chatbox (text + Qwen ASR mic via existing `/api/capture/transcribe`), streaming replies via `/api/chat`. No nav, no module concepts, no eigenmesh landing (deleted). `(nucleus)` route group pins light palette; console routes still exist as unlinked internal tooling (deletion policy: later, deliberate).
- **Journey seed** in the orchestrator persona: founding requests open the brand journey — tone of voice first, one question at a time. Wired through `AGENT_SYSTEM_PROMPT` (critical fix: `/api/chat` runs the legacy agent-loop, which never saw the persona).
- **Auth links print to terminal in dev** (`ea8f5e4`) — no local mail server needed.
- **Env truths reconciled**: user `.env` had a duplicate placeholder OWLERY block; Vite dotenv (last-wins) saw it as configured, CLI loader (first-wins) as unconfigured — the login lockout + 2 flaky specs traced to this. `.env` cleaned; specs now mock `$env/dynamic/private` hermetically (`693a5a6`).
- **Main: 1112 tests green, check at 0 errors.**

**Decisions**
- The surface hides the console; nothing is deleted without a decision. Brand-token re-skin happens via the brand kernel phase — visual identity stays green for now.
- ASR transcript fills the input (user reviews before send), not auto-send.

**Tracked (honest list)**
- `/api/chat` still runs the legacy agent-loop, not the kernel AgentRuntime — unify so the chatbox speaks through the harness proper.
- Post-auth redirect still lands on `/capture` (e2e helpers cascade) — flip login/signup → `/` in a dedicated stream.
- Identity-in-chatbox (no boring /login page) — journey design later.

---
## 2026-09-08 — Dev instance live on :5433; test DB rebuilt from scratch (1206/1206)

**Shipped**
- Compose: containers renamed `eigen-enterprise-*`; EE db on **host 5433** (legacy eigen stack keeps 5432) — `.env.example` updated.
- Fresh-boot infra fix inherited from eigen: `01-extensions.sh` sets `search_path` before `::agtype` index casts (first boot on a clean volume previously failed all four graph indexes).
- `eigen-enterprise-db` running + healthy; `eigen_test` created with the FULL init chain (vector+age+graph+labels+indexes, `eigen_app` role + grants, pg_cron/pg_net), 75 migrations applied, **RLS applied (`db:rls`) — the missing piece behind the "pre-existing" integration failures: RLS policies are not part of migrations**.
- Verification: **1206/1206** (kernel/modules/cli/mcp/db/activity/routes) on the new instance, including the tenant-secrets RLS integration specs.

**Decisions**
- Test DBs must bootstrap with `db:migrate` + `db:rls` (migrations alone ≠ RLS). Follow-up candidate: `db:test-up` script automating create+init+migrate+rls.
- Old eigen-db (5432) untouched; its eigen_test is obsolete.

**Smoke test fully unblocked:** `.env` → `DATABASE_URL=...localhost:5433/eigen`; `db:up` → `db:migrate` → `db:rls` → `dev`; activations + allowlist SQL per bootstrap.ts docs.

**Next:** Phase 2 — owlery internalization (EmailProvider port), then sales (Phase 3).

---

## 2026-09-08 — Startup wired + company feed live (smoke-test ready)

**Shipped** (wt/startup `4951da0`, wt/activity `2fafd7d`, MCP-spec fix `4b6ef81`)
- **`src/lib/server/boot.ts`** — the composition root: `bootApp()` memoized single-flight (failed boots do NOT cache — retry recomposes fresh); kernel → bootstrapOrchestrator(kernel, wireGateway, { engines: [['pi', piEngine]] }) → bootstrapChatGateway stage; env injectable. `src/hooks.server.ts` triggers it additive + loud-fail.
- **Company feed** — `/activity` now renders `kernel_events` (agent.*, tool.executed, gateway.telegram.*, dev-agent.*) via `listKernelEvents` read-model + `toFeedItem` whitelist (metadata only; content fields proven excluded by tests). Full emitted-type inventory grepped + pinned.
- **Stale HTTP-MCP spec fixed** — broadened verification scope to `src/routes` exposed a seed-era spec asserting the pre-kernel contract (unprefixed tool name, no activation). Now: fixture kernel (memory activated, real descriptors, mocked impls), namespaced `memory.retrieve_thoughts`. 655/655 in src/routes.
- **Main state: kernel+modules+cli 446, mcp 56, routes 655, boot/activity included — check at 5-error baseline.**

**Flags**
- 6 pre-existing eigen_test integration failures (tenant-secrets, ontology-db, retrieval, thought-lifecycle) — test-DB schema drift; `npm run db:migrate` against eigen_test before smoke test.
- Feed open items: `textLength` whitelist field, `website.contact.captured` inclusion, load-more cursor — later touches.

**SMOKE TEST (user runs)**
1. `npm run db:up && npm run db:migrate`
2. `.env`: TELEGRAM_BOT_TOKEN, LLM gateway creds
3. SQL: activate `chat-gateway` + `memory` (+`email`); allowlist Telegram user → principal; seed `orchestrator` principal row
4. `npm run dev` → message the bot → orchestrator responds via builtin-json engine; /activity shows the events
5. hermes: point MCP at `/api/mcp` (session user) or Bearer key (agent principal)

**Next:** Phase 2 — owlery engine internalization (EmailProvider port first), then sales (Phase 3).

---

---

## 2026-09-08 — THE HARNESS IS IN (AgentRuntime + LoopEngine + PiEngine)

**Shipped** (`034c1f1` harness + `a6996af` pi-engine + orchestrator integration, merged to `main`)
- **Kernel primitives**: `kernel/agent.ts` (AgentConfig/AgentTypeSpec), `kernel/engine.ts` (EngineContext + LoopEngine — the harness hands engines tools/approvals/events/spend; engines own model/prompts/strategy), `kernel/agent-runtime.ts` (dispatch pipeline: unknown_agent → agent_disabled → unknown_engine → budget → dispatched → run → replied; payloads metadata-only), `kernel/tool-surface.ts` (shared fail-closed filter: activation ∩ scope ∩ roles), `kernel/agent-admin.ts` (`agent.list/enable/disable`, owner-gated), `kernel/pi-engine.ts` (headless pi as a hosted engine; canonical PI_GUARDRAILS; spawn seam injected).
- **Demotions done**: orchestrator brain → thin adapter over AgentRuntime; orchestrator = seeded AgentConfig (`builtin-json` engine, `EE_HARNESS_SPEND_CAP_USD`, malformed = boot fails loud); dev-agent runner delegates spawning to PiEngine.
- **Manifest extension (additive)**: `agents?: AgentTypeSpec[]`, `verification?: VerificationPolicySpec[]` — third parties can ship agents, not just tools.
- **Integration (orchestrator, on main)**: resolved harness × gateway-extraction conflicts (brain.ts adapter keeps `$lib/kernel/gateway` port; bootstrap keeps composition-root shape `bootstrapOrchestrator(kernel, wireGateway, options)` + runtime seeding; bootstrap.spec reconciled to three-arg convention); unified pi-engine's structural EngineContext mirror into the canonical type; added `options.engines` injection seam so the composition root hosts `pi` without module-to-module imports (boundary guard stays green). New test proves engine injection via dispatch.
- **Main: 446 (kernel+modules+cli) + 56 (mcp) = 502 tests green; `npm run check` at 5-error baseline.**

**Decisions**
- Adding an agent = one AgentConfig + zero new code; it inherits permissions/approvals/events/spend/verification. The orchestrator holds no code privilege — deleting/replacing it touches no kernel code.
- Spend cap: single cap on the harness agent itself (`EE_HARNESS_SPEND_CAP_USD`); no granular per-agent limits (user decision).
- Sessions in engines: in-memory Maps (documented debt); gateway-cost accumulation wiring = follow-up (spend currently via `recordSpend`).
- Merge-conflict lesson recorded: parallel sessions on `main` + long-lived worktrees = textual conflicts on shared files; integration unification is orchestrator work.

**Next**
- Startup call site that composes kernel → orchestrator → gateway (pending since gateway extraction) — then the live Telegram smoke test.
- Apply `agent.*` events on the wire (activity feed UI); persisted sessions; gateway-cost spend accumulation into the runtime.
- Then per roadmap: owlery internalization (Phase 2), sales (Phase 3), brand kernel.

---

## 2026-09-08 — Gateway contract moved into the kernel (declared edges now zero)

**Shipped** (`56d8c80`, merged to `main`)
- New `src/lib/kernel/gateway.ts`: the chat-gateway port lives in the kernel now. It holds `TelegramSessionRef`, `Brain`, `AllowlistEntry`, `AllowlistStore`, `GatewaySession`, `SessionStore`, plus the `CHAT_GATEWAY_MODULE_ID` and `CHAT_GATEWAY_ALLOWLIST_TOOLS` constants. chat-gateway imports them from the kernel; every local copy is gone, no re-export shims inside modules.
- New `src/lib/kernel/wiring.ts`: `WiredKernel` and `registerModuleTools()` moved here from modules/index.ts. The composition root still assembles the kernel, but the wiring types belong to the kernel.
- `modules/index.ts` gained the gateway boot stage: `bootstrapChatGateway(kernel, brain, { env, db? })` returns the boot object, or null when the module is inactive. The fail-loud token rule is unchanged: an active gateway without `TELEGRAM_BOT_TOKEN` still aborts startup. `bootstrapOrchestrator(kernel, wireGateway, options?)` now takes the kernel as a parameter and hands the brain to the injected gateway stage. It has no caller yet (startup wiring is still pending the user's live smoke test), so the signature change breaks nothing.
- `DECLARED_WIRING_EDGES` is an empty Map, pinned by test. The repo scan passes with zero exceptions: no module imports another module or the composition root.
- Verification: 327 passed / 1 skipped (kernel + modules), `npm run check` at the 5-error baseline, lint clean on touched files.

**Decisions**
- The kernel owns the port (the `Brain` type the gateway consumes), while phase 1b decides who implements it (BuiltinJsonLoop). The two streams stack cleanly.
- modules/index.ts re-exports `WiredKernel`/`registerModuleTools` because src/cli, mcp/server, and admin-bootstrap import them from there and sat outside this stream's scope. Re-pointing those imports is a small chore, not urgent.

**Next:** phase 1b harness streams (wt/harness, wt/pi-engine); startup call site that composes kernel → orchestrator → gateway; then the HTTP tool route.

---

## 2026-09-08 — wt/harness: AgentRuntime + LoopEngine kernel primitive (orchestrator demoted to config)

**Shipped** (branch `wt/harness`, phase-1b)
- `kernel/agent.ts` — AgentConfig (id === principal id), AgentTypeSpec, VerificationPolicySpec, AgentSessionRef, LoopEngineId.
- `kernel/engine.ts` — `EngineContext` { agent, principal, executeTool, listTools, emit, spendUsd } + `LoopEngine` (type alias for lint; structural). Tool list is precomputed per dispatch → `listTools()` sync.
- `kernel/tool-surface.ts` — THE shared filter (activation ∩ role intersection ∩ agent module scope, fail closed); runtime + orchestrator both resolve surfaces through it. MCP listing untouched (activation-only subset).
- `kernel/agent-runtime.ts` — dispatch pipeline: unknown_agent → agent_disabled → unknown_engine → budget check (emit `agent.budget_exceeded` + throw before any run) → emit `agent.dispatched` → engine.run → emit `agent.replied` {replyLength} (payloads metadata-only, never content). `stop()` = disable + `agent.stopped` (v0; in-flight cancellation is engine-dependent, documented). `recordSpend()` + injected `spendFn` + injected `rolesFor` (AgentConfig carries no roles; default `['agent']`).
- `kernel/engines/builtin-json.ts` — brain loop extracted verbatim (think-strip, fence-strip, brace-balance, parse-retry ×3 default, approval_pending UX, history cap 40, 8 iterations, 12k tool-result chars). Kernel-local `EngineChatMessage`/`LlmCompleteFn` (no kernel→server import); `llmUserId` defaults to `ctx.agent.id`.
- `modules/orchestrator/brain.ts` — thin adapter (identity data + `respond` → `runtime.dispatch`, `offeredTools` → `runtime.listAgentTools`); `bootstrap.ts` seeds the runtime (`orchestrator` config, `builtin-json` engine, `EE_HARNESS_SPEND_CAP_USD` → spendCapUsd, malformed = boot fails loud) — **flagged modules/** edit.
- `kernel/agent-admin.ts` (new) — module `agent`: `agent.list` (read, admin+agent), `agent.enable`/`agent.disable` (mutate, owner-only), self-seeded active from orchestrator bootstrap.
- Manifest extension (additive): `ModuleManifest.agents?: AgentTypeSpec[]`, `.verification?: VerificationPolicySpec[]` + zod schema; v0 declarative only, nothing enforces.
- `kernel/errors.ts` — 6 new loud codes: unknown_agent(404), agent_disabled(409), duplicate_agent(409), unknown_engine(500), duplicate_engine(409), budget_exceeded(402).

**Verification:** kernel+modules+cli 424 passed / 1 skipped (baseline 383; brain.spec 14 tests moved to `engines/builtin-json.spec.ts`, ~27 net new); mcp+modules w/ test DB 252 green; check = exactly 5 baseline errors; lint: 0 errors in harness files (7 pre-existing elsewhere).

**Decisions / flags**
- Spend wiring: gateway-cost.ts exposes parsers only — no per-principal accumulation query exists in `llm/` → default is a per-runtime in-memory accumulator via `recordSpend(agentId, usd)`; gateway-cost wiring documented follow-up (llm/** untouched).
- Sessions in engines are in-memory Maps (documented debt, same as Phase-0 brain).
- brain.spec deleted (moved) — OrchestratorBrainError → `LoopProtocolError` (LoopProtocolError is the engine's class now).

**Next:** apply events on the wire (activity feed), PiEngine (`wt/pi-engine`, no modules/index edits), persisted sessions + gateway-cost accumulation.


---

## 2026-09-08 — Kernel open-API round 2 merged (manifest schema, problem+json, boundary guard, event provenance)

**Shipped** (4 worktree streams → `main` @ `d3451ec`)
- **wt/manifest-schema** (`fa3674d`): `kernel/manifest-schema.ts` — published Zod→JSON Schema contract for `ModuleManifest`, fail-loud in `ModuleRegistry.register()`. **Fix-forward** (`d3451ec`): `tools: []` is valid (toolless modules legitimate — caught by `admin-bootstrap`/`brain` fixtures exercising `registerModuleTools`; schema was over-constrained, fixtures were right).
- **wt/problem-json** (`d12dc11`): `KernelError.toProblemJson()` — RFC 9457 (urn:eigenenterprise:problem:<code>, exhaustive title map = type error on missing entry, status map + 500 fallback); OpenAPI `components.schemas.problem` + problem+json on 400/401/403.
- **wt/event-source** (`6a3dd57`): `KernelEvent.source` + persistence (drizzle `0074_kernel_event_source` + journal idx 74 — **migration not yet applied**), `moduleSource()`/`KERNEL_EVENT_SOURCE` urns, `toCloudEvent` resolution `event.source ?? source` (throw if neither), all 7 emit sites wired (registry audit per-module, dev-agent ×4, website ×1, chat-gateway ×2).
- **wt/boundaries** (`45e5306` + `33b33d5`): `kernel/boundaries.ts` import-specifier detector (resolves relative specifiers, catches dynamic + export-from + bare forms) + repo-scan test. **The guard earned its keep on day one: 11 real `orchestrator→chat-gateway/index` edges found** (orchestrator = boot stage wiring the gateway surface) — codified as `DECLARED_WIRING_EDGES` pinned by test, not silently ignored.
- Verification on main: 370 passed / 1 skipped, only `mcp/registry.spec.ts` fails (`DATABASE_URL` — user-started DB, known); check = 5 baseline errors; lint clean.

**Broke / flags**
- Manifest validation broke 2 fixture files with fake `tools: []` manifests → root cause was the schema rule, not the fixtures; fixed schema, reverted fixture edits.
- Orchestrator still structurally coupled to chat-gateway internals (types, stores) — declared, tracked.

**Decisions**
- Toolless manifests are valid; tool-name pattern allows snake_case (all 20+ real tools use it) — published contract documents reality.
- Cross-module wiring edges are *declared policy* with reasons, zero by default; contract extraction (gateway types → kernel) is the follow-up that shrinks the set.
- problem+json 404/409 surfacing deferred until the HTTP tool route exists.

**Next:** extract chat-gateway contract to kernel (kill declared edges); apply migration 0074 (`npm run db:migrate`, user-started DB); HTTP tool route mounting registry with bearer → principal mapping.

---

## 2026-09-08 — Kernel open-API standards round merged (output schemas + CloudEvents)

**Shipped** (`49ae71c` + `1585d9b`, merged to `main` @ `575ea06`)
- `plan/kernel-open-api.md` — approved standard stack: JSON Schema 2020-12 contracts (one Zod source → MCP + OpenAPI), registry-`execute()`-only inter-module calls (zero side doors), CloudEvents 1.0 event envelope, OpenAPI 3.1 edge; A2A watched, not adopted. Rejected: gRPC, direct imports, bespoke wire protocol.
- **wt/output-schema** (`49ae71c`): `ToolDescriptor.outputSchema?: ZodType`; `execute()` validates handler results pre-audit (`invalid_output`, audited `ok:false`, vcs commit skipped); MCP `tools/list` + OpenAPI 200 responses advertise compiled output schema (`io: 'output'`); parity test covers output round-trip. `errors.ts`: `invalid_output` added (coexists with `run_in_progress` from the dev-agent stream).
- **wt/cloud-events** (`1585d9b`): `kernel/cloudevents.ts` — CloudEvents 1.0 `CloudEvent` type, `toCloudEvent(event, source)` mapper (source explicit per call site — no implicit defaults), `eventType()` reverse-DNS convention `com.eigenenterprise.<module>.<name>`. Envelope derived at boundaries — **no kernel_events migration** (open-api plan rule 4).
- Verification on main: 325 passed / 1 skipped (kernel + mcp + modules); only failure = `mcp/registry.spec.ts` `DATABASE_URL` missing (known — user starts dev DB). `npm run check` = 5 documented baseline errors; lint clean.

**Broke / flags**
- `main` advanced mid-stream (`40a3654` dev-agent/website/cli) — both branches merged main first, then landed; `errors.ts` union auto-merged (both new codes coexist). Worktree `node_modules` symlinked from main checkout this round — fast, worked clean.

**Decisions**
- Output validation lives inside the handler `try` (reuses existing audit-`ok:false`-rethrow path; no duplicated audit logic).
- CloudEvents adapter only this round — wiring explicit `source` into all emit sites is a follow-up on main.

**Next (from `plan/kernel-open-api.md` §Later):** manifest JSON Schema at registration, problem+json error shape, cross-module import guard, emit-site `source` wiring.

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
