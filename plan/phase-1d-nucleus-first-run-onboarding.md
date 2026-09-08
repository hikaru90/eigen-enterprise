# Phase-1d Plan — Nucleus First-Run Onboarding (provider setup as the first screen)

Status: APPROVED (user directive, 2026-09-08)
Depends on: phase-1c (saveProviderConfig service, provider-ready, typed errors)

## Problem

Phase-1c bolted provider setup onto the legacy EigenMesh capture onboarding and surfaced it
after a failed chat attempt, linking into the old settings page. User verdict: provider setup
must be a guided tool and the FIRST thing done when opening the page — designed ground-up for
Eigen Enterprise, not translated from EigenMesh.

## Goal

Open Eigen Enterprise without a working AI provider → the page IS the setup wizard, in the
nucleus design language. Connect → chat. One card, no chatbox until the brain works.

## Flow

`/` (nucleus) load computes `needsOnboarding = !harness && !providerReady`.
- needsOnboarding → render `<ProviderOnboarding>` (wizard) INSTEAD of the chatbox.
- Wizard: provider tiles (OpenRouter / EUrouter) → credentials (fields adapt) → Connect.
  Connect = server-side dry-run test (real 1-token gateway completion) THEN save
  (`saveProviderConfig` + `onboardingCompleted = true`). Success shows
  "Connected — <model>, <latency>" and Start reveals the chat (`invalidateAll`).
- No skip: no provider, no product. BYOK-UI-disabled deployments see the operator note.
- Returning user whose provider vanished sees the wizard again on open — intended.

## Work

1. `src/lib/server/llm/provider-test.ts` — `testLlmProviderConnection(userId, config)`:
   1-token chat completion against arbitrary (pre-save) creds via the gateway; single
   attempt; activity-logged for cost tracking; returns `{ok, model, latencyMs} | {ok:false, error}`.
   EUrouter side resolves the routing rule by id (export `resolveRoutingRuleById` from llm-client).
2. `POST /api/onboarding/test-provider` — dry run: validate shape, build ResolvedLlmConfig, test.
   No persistence. `POST /api/onboarding/provider` — save + complete onboarding.
   Both: auth + `isByokUiEnabled()` gates, fail loud with user-safe errors.
3. `src/lib/components/provider-onboarding.svelte` — the wizard. Nucleus language: white,
   black borders, sharp corners, uppercase tracked wordmark, monochrome; destructive red only
   for errors. Client state machine; fetch to the two endpoints.
4. `(nucleus)/+page.server.ts` load — `needsOnboarding`, `byokUiEnabled`; `(nucleus)/+page.svelte`
   renders wizard or chat.
5. **Landing flip /capture → /** — signup (load redirect, signUpEmail callbackURL, post-success
   redirect, resend callbackURL), login (both sites), settings `resetOnboarding` redirect.
6. **Revert phase-1c additions to the legacy surface** — capture `+page.server.ts` (providerReady,
   byokUiEnabled, saveProvider action), capture overlay provider step + props, overlay spec
   back to the 3-step reality (drift correctly fixed, EigenMesh copy untouched).
7. E2E: helpers `registerUser`/`loginUser` wait for `/`; `onboarding-provider.e2e.ts` rewritten
   wizard-first (production user lands on the wizard; harness lands in chat; save via settings
   for the disappearance contract on configured deployments).

## Decisions (log)

- Wizard gates the chatbox entirely — first-run has no skip; a configured deployment never
  shows it; a broken provider brings it back. Fail loud, fail at the front door.
- Connection test is a real gateway call (1 token), not a key-format check — proof, not
  ceremony. Cost ≈ negligible; activity-logged like every other call.
- Notifications/capture blurbs dropped from first-run. The nucleus needs one thing.
- Legacy capture overlay untouched beyond reverting 1c additions; its deletion stays a
  deliberate later call (deletion policy).

## Tests (first)

- Unit: provider-test (openrouter + eurouter rule path, failure shapes, activity log);
  onboarding endpoints (auth 401, byok gate 403, validation, save+complete, dry-run no-save);
  nucleus load shape (needsOnboarding true/false, harness bypass).
- Component: provider-onboarding wizard (choice swap, connect success/failure, operator hint).
- E2E: production user → wizard is the first screen → connect → chat; configured deployment →
  no wizard; settings-saved creds keep the wizard away after onboarding reset.

## Guardrails honored

- No fallbacks: wizard never fabricates a provider; endpoints fail loud.
- LLM middleware: the test call lives in `src/lib/server/llm/`, activity-logged, cost attached.
- No string heuristics: typed errors, structured codes.
