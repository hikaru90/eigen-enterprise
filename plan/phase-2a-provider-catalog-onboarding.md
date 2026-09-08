# Phase-2a Plan — Provider onboarding: method → provider (pi-inspired, catalog-driven)

Status: APPROVED (user directive: research pi.dev provider selection, implement autonomously)
Depends on: phase-1d (wizard gate, provider-ready, mock-gateway e2e)

## Research summary (pi, packages/ai)

- Credentials are type-tagged per provider: `ApiKeyCredential | OAuthCredential`
  (`{refresh, access, expires}`), one row per provider id.
- Providers expose `apiKey` auth and/or `oauth` auth; OAuth flows carry
  `isSubscription: true` (Claude Pro/Max, ChatGPT, GitHub Copilot, SuperGrok/X…).
- Login interacts via normalized events: `auth_url` (open browser) and
  `device_code` (userCode + verificationUri + poll interval) — both are web-native.
- Concrete flows:
  - **GitHub Copilot (subscription)**: device flow `github.com/login/device/code`
    (client_id Iv1.b507a08c87ecfe98, scope read:user) → poll `login/oauth/access_token`
    → exchange GitHub token at `api.github.com/copilot_internal/v2/token` (short-lived
    Copilot token, `expires_at`) → OpenAI-compatible chat at
    `https://api.individual.githubcopilot.com` (+ Copilot headers, base URL derivable
    from token `proxy-ep`). Models via `GET {base}/models`.
  - **OpenRouter OAuth (PKCE)**: `openrouter.ai/auth?callback_url=<ours>&code_challenge…`
    → callback with `?code=` → POST `api/v1/auth/keys` `{code, code_verifier}` →
    **permanent API key**. `callback_url` is caller-controlled → web-native.
  - Catalog: **models.dev** (`api.json`) — provider id/name/api base URL/env-var hint,
    models with modalities + cost. `npm: @ai-sdk/openai-compatible` marks providers our
    OpenAI-shaped gateway can speak to. This is the "open source package".

## Goal

Two-question wizard: **"How do you want to connect?"** (Subscription sign-in | API key)
→ **provider list** (catalog-driven) → per-method credentials → real test → save.
Subscriptions = OAuth sign-in; API key = catalog provider with prefilled base URL +
key + model suggestions. EUrouter stays pinned first-class.

## Work

1. **Migration `0075_llm_provider_oauth.sql`** + journal + schema: `auth_type`
   ('api_key' default | 'oauth'), `oauth_access_encrypted`, `oauth_refresh_encrypted`,
   `oauth_expires_at`, `oauth_meta` (jsonb) on `llm_provider_config`.
2. **`src/lib/server/llm/catalog.ts`** — models.dev fetch (timeout, 24 h in-memory cache,
   `MODELS_DEV_CATALOG_URL` override for e2e), filtered to openai-compatible providers;
   shape: `{id, name, baseUrl, envVar, docUrl, chatModels[], embeddingModels[]}`;
   EUrouter pinned first-class. No silent fallback: fetch failure = explicit error the
   wizard surfaces with a retry.
3. **OAuth modules** `src/lib/server/llm/oauth/`: `github-copilot.ts` (device start/poll/
   token exchange, headers, base-URL derivation, model list), `openrouter-oauth.ts`
   (PKCE authorize URL + code exchange). GitHub/OpenRouter base URLs read from env with
   production defaults (explicit overrides for e2e).
4. **llm-client generalization**: `LlmProviderKind` widens to string; `ResolvedLlmConfig`
   gains `authType` + oauth credential; `loadLlmProviderConfig` resolves OAuth rows
   (decrypt; Copilot refresh-on-expiry persists the rotated token); `chatRoutingConfig`:
   EUrouter keeps rule-based routing, every other provider is direct-model.
   Copilot = chat only (embeddings stay a typed loud error naming the fix).
5. **Wizard v2** (`provider-onboarding.svelte`): step 1 method, step 2 provider
   (catalog-driven grid; subscription column lists Copilot + OpenRouter sign-in),
   step 3 credentials per method (API key form as today; device-code card showing
   user_code + link + polling; OpenRouter = redirect + auto-callback). Connect keeps
   the real 1-token proof. Endpoints: catalog, copilot start/poll, openrouter
   authorize/callback, extended test/save.
6. **Tests**: catalog (parse/filter/override), provider-input (catalog provider ids),
   oauth modules (fetch-mocked success/pending/failure), llm-client OAuth resolve +
   Copilot refresh, endpoints, wizard component (method step → provider step →
   credential steps), e2e via mock-gateway also serving the models.dev fixture +
   GitHub device-flow stubs (catalog + GitHub URLs overridden by env).

## Decisions (log)

- Subscription sign-ins in v1: GitHub Copilot (device flow — fully web-native) and
  OpenRouter sign-in (PKCE with caller-controlled callback). Claude Pro/Max and ChatGPT
  subscriptions are the documented next step: they need a browser redirect allowlist
  strategy plus an Anthropic/Codex API-shape adapter — a separate deliberate pass.
- models.dev is a live dependency with explicit failure + retry, not a silent fallback.
- No schema-level provider enum: provider is text, so new providers never need migrations.

## Guardrails honored

Typed errors only; LLM middleware stays the single gateway path (OAuth lives in
`src/lib/server/llm/`); secrets encrypted at rest (tenant envelope); tests first.
