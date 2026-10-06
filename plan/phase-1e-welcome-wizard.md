# Phase-1e Plan — Welcome Setup Wizard (the whole system, not just the provider)

Status: APPROVED (user directive, verbatim: "I WANT A SETUP WIZARD THAT GUIDES THROUGH THE
SETUP! THE USER DOES NOT KNOW WHAT THIS IS, WHAT THE SYSTEM CAN DO AND WHAT THEY WANT.")

## Problem

Phase-1d/2a built the provider wizard, but its gate is `providerReady` only. A user whose
provider works (platform credits, or env-configured BYOK) logs in and lands on a bare
"What do you need?" chat box: nothing explains what Eigen Enterprise IS, what it can DO,
or what to do FIRST. Existing users who completed provider onboarding long ago never see
any guidance either. User verdict: unacceptable.

## Goal

First open of `/` for a user who has not completed welcome onboarding → a setup wizard in
the nucleus design language that walks: ① What is this → ② What can it do → ③ Connect the
AI (conditional, reuses the provider wizard) → ④ Pick your first move → into the product.
Skippable at every step (a tour, not a prison — unlike the provider, which stays a hard gate).

## Flow

`(nucleus)/+page.server.ts` gains `showWelcome = !harness && welcome_completed_at IS NULL`.
Page precedence: `showWelcome` → `<WelcomeWizard>`; else `needsOnboarding` (provider gate,
unchanged) → `<ProviderOnboarding>`; else chat.

Wizard steps (all with "Skip setup"):
1. WELCOME — plain words: what Eigen Enterprise is (your company's memory + AI on your
   own server).
2. CAPABILITIES — six cards: Nucleus chat, Capture, Memory, Knowledge graph, Brand studio,
   API keys — each one sentence, each linked.
3. CONNECT — `providerReady` → completed card. Not ready → `<ProviderOnboarding>` renders
   inline; its Start (invalidateAll) flips the load data and the step renders connected.
4. FIRST MOVE — "What do you want to do first?": Start with the chat (primary, completes +
   closes), Capture a thought (/capture), Open memory (/memory), Design a brand (/brand),
   Explore the graph (/graph).

Completion: `POST /api/onboarding/welcome` sets `user_preference.welcome_completed_at = now()`
(upsert, idempotent, auth 401, fail loud). Client then `invalidateAll()` → wizard gone.

## Work

1. Migration `0082_welcome_onboarding.sql` (`ALTER TABLE user_preference ADD COLUMN
   welcome_completed_at timestamp`) + journal idx 82 + `brain.schema.ts` field.
2. `(nucleus)/+page.server.ts` — read `user_preference.welcome_completed_at`, return
   `showWelcome`. Harness accounts never see it. Provider gate untouched.
3. `POST /api/onboarding/welcome` — auth gate, upsert, `{ok:true}`.
4. `src/lib/components/welcome-wizard.svelte` — props `{providerReady, byokUiEnabled}`;
   client state machine; completion POST + invalidateAll; error text on failure (fail loud).
5. `(nucleus)/+page.svelte` — precedence branch for the wizard.
6. E2E: new `onboarding-welcome.e2e.ts` (production domain: wizard is the first screen →
   walk UI → chat; skip → chat; persists across re-login). `onboarding-provider.e2e.ts`
   production cases complete welcome via API first (they test the provider wizard, not the
   tour).

## Decisions (log)

- New `welcome_completed_at` on `user_preference` instead of reusing `user.onboarding_completed`:
  that flag means "provider onboarding done" (set by saveProviderConfig) and platform-credit
  users never hit it; a fresh flag also makes the tour appear for existing accounts — exactly
  what the owner asked to see.
- Welcome is skippable; the provider step inside it is not (no provider, no product — phase-1d
  decision stands where it belongs).
- The provider wizard is reused, not duplicated: one credential flow to maintain.
- Stale e2e suites that still expect the removed `/capture` overlay on `/` (release,
  projects-assign-task) are pre-existing breakage, out of scope here.

## Tests (first)

- Unit: nucleus load shape (showWelcome true/false × harness); welcome endpoint (401, upsert,
  idempotent); component spec (step walk, skip, connect step states, completion POST).
- E2E: welcome-first-screen → complete → chat; skip → chat; gone after re-login.
- Gates: `npm test`, `npm run check`, production build.

## Guardrails honored

- No fallbacks: missing DB row ≠ error (default null = show tour); persistence errors fail loud.
- No silent degradation: wizard never fakes provider readiness; connect step is the real gate.
