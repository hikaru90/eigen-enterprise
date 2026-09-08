# Phase-1c Plan — Onboarding Provider Setup

Status: APPROVED (2026-09-08)
Depends on: nucleus chat surface (phase-1 milestone)

## Problem

A fresh instance with no inference provider configured fails user chat with operator-speak:
`Platform EUrouter not configured: set LLM_BASE_URL`. Provider configuration today is either
env vars (operator path) or a buried settings page (`/settings/llm`); nothing leads a user
there. The error is fail-loud (correct, per guardrails) but it is a wall, not a door.

## Goal

Provider setup is a first-class user-facing flow: offered as an onboarding step, revisitable
from a failed chat turn, backed by one shared save path. Fail loud — but with a door.

## Work

1. **Typed config errors** — `LlmNotConfiguredError` in `src/lib/server/llm/errors.ts`;
   thrown by `loadPlatformLlmConfig`, `loadLlmProviderConfig`, `assertEurouterGatewayConfigured`,
   and the rule/model-not-configured throws in `llm-client.ts`. `chatErrorTerminalPayload`
   threads `kind: 'llm_not_configured'` on the wire (walking the cause chain). No string
   matching anywhere — typed class server-side, structured field on the stream.
2. **Shared save service** — `src/lib/server/llm/save-provider-config.ts`: validation +
   tenant-encrypted key + upsert `llm_provider_config` + optional active provider +
   `billingMode → byok`. Extracted from `llmSettingsActions.saveLlmConfig`; the settings action
   keeps only form parsing and the `isByokUiEnabled()` gate. The new onboarding action
   (`?/saveProvider` on capture page) delegates to the same service.
3. **Onboarding step "Connect your AI provider"** — inserted between capture and notifications
   in `capture-onboarding-overlay.svelte`. Shown only when `providerReady === false`:
   load-side check (non-throwing) = BYOK credentials saved OR platform env present for the
   active provider. Skippable like every step. EUrouter: base URL + API key + rule UUIDs;
   OpenRouter: base URL + API key + model names.
4. **Chat failure card** — nucleus terminal error with `kind === 'llm_not_configured'` renders
   the failed bubble plus a "Set up your AI provider →" link to `/settings/llm`.

## Decisions (log)

- Chat failure deep-links to `/settings/llm` rather than an inline form — one form, no
  duplication (orchestrator call, user approved plan without picking).
- Onboarding provider setup = per-user BYOK (existing `saveLlmConfig` semantics). Platform
  service-account env stays the operator deployment path; in single-tenant self-host the
  installer is the owner, so the paths coincide.
- Keep fail-loud: no default provider, no silent degradation, no fallbacks. The UI only adds
  a door; the server still refuses to fabricate a provider.

## Tests (first)

- Unit: `LlmNotConfiguredError` thrown by loaders/guard (update existing specs);
  `chatErrorTerminalPayload` kind threading incl. wrapped causes; save service (validates,
  encrypts, upserts, flips billingMode, sets active); `isUserProviderReady` (byok creds,
  platform env present/absent, byok-ui disabled).
- E2E (Playwright, headed): fresh user onboarding shows the provider step, saves an
  OpenRouter config, completes onboarding; unconfigured chat failure surfaces the setup link.

## Guardrails honored

- No string heuristics — typed error class + structured `kind` on the wire.
- No fallbacks — nothing auto-selects a provider; skipping leaves the user unconfigured,
  loudly.
- LLM middleware untouched — all calls still go through the gateway with cost tracking.
