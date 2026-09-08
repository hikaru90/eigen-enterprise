# Phase-2b Plan — Subscription sign-ins: Claude Pro/Max + ChatGPT (pi-derived adapters)

Status: APPROVED (user directive "go then", 2026-09-08)
Depends on: phase-2a (catalog wizard, oauth columns, mock-gateway e2e)

## Research summary (pi, verified against source)

- **Anthropic OAuth (Claude Pro/Max)**: PKCE authorize at `claude.ai/oauth/authorize`
  (client `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, `state=verifier`), token exchange +
  refresh at `platform.claude.com/v1/oauth/token` (JSON). Access tokens are
  `sk-ant-oat…`; requests use `Authorization: Bearer` (never x-api-key), identity
  headers (`user-agent: claude-cli/<v>`, `x-app: cli`), betas
  `claude-code-20250219,oauth-2025-04-20`, and the system prompt MUST begin with the
  Claude Code identity line. API: `POST {base}/v1/messages` (non-streaming supported).
  Base: `https://api.anthropic.com`.
- **OpenAI Codex (ChatGPT Plus/Pro)**: TWO login modes; we implement **device code**
  (`auth.openai.com/api/accounts/deviceauth/usercode|token`, verification page
  `/codex/device`) — identical UX to Copilot. Token exchange/refresh at
  `auth.openai.com/oauth/token`; access token is a JWT whose
  `https://api.openai.com/auth.chatgpt_account_id` claim feeds the required
  `chatgpt-account-id` header. Chat: `POST {base}/codex/responses` (SSE, `stream:true`
  always), headers `Authorization Bearer`, `chatgpt-account-id`, `originator`,
  `OpenAI-Beta: responses=experimental`; body `{model, store:false, stream:true,
  instructions, input, text:{verbosity}, include:[reasoning.encrypted_content]…}`.
  Accumulate `response.output_text.delta`; final state in `response.completed`.
  Base: `https://chatgpt.com/backend-api`. Default model: `gpt-5.1-codex`.
- Neither subscription path provides embeddings → typed loud error naming the fix
  (same as Copilot).

## Work

1. **OAuth modules** (`src/lib/server/llm/oauth/`): `anthropic.ts` (authorize URL,
   authorization-input parser accepting code | `code#state` | full redirect URL,
   exchange + refresh), `openai-codex.ts` (device start / one-shot poll / code exchange
   + refresh, JWT accountId extraction). Env-overridable URLs (e2e), production defaults.
2. **API-shape adapters** (`src/lib/server/llm/api-shapes.ts`):
   `fetchProviderChatCompletion(config, …)` returns a Response whose JSON is normalized
   to OpenAI shape (choices/usage) for `anthropic` (non-streaming messages) and
   `openai_codex` (SSE accumulation); all other providers pass through as real fetches.
   llm-client + provider-test call the dispatcher, so retries, cost logging, PostHog and
   the connection test work unchanged across shapes. Embeddings: typed loud errors.
3. **Endpoints**: `POST /api/onboarding/oauth/anthropic/authorize` (PKCE cookie + URL),
   `…/anthropic/connect` (paste code/URL → exchange → save → complete),
   `POST /api/onboarding/oauth/openai/start|poll` (device flow → save → complete).
4. **Wizard v3**: subscription step gains "Claude Pro/Max" (opens authorize page, paste
   code/URL card) and "ChatGPT Plus/Pro" (device-code card, same UX as Copilot);
   generalized device/paste state machines. Default models: catalog-derived with pinned
   fallbacks (`claude-sonnet-4-5`, `gpt-5.1-codex`).
5. **E2E**: mock-gateway stubs — Anthropic token exchange + `/v1/messages` (Anthropic
   shape), Codex device endpoints + `/codex/responses` SSE, authorize redirects carrying
   `?code=&state=`. Tests: full Claude manual-code flow including a real chat turn through
   the adapter; full ChatGPT device flow; both to "Connected → workspace → chat reply".

## Decisions (log)

- Manual-code paste for Anthropic (pi's headless pattern) — dodges redirect-allowlist
  issues entirely and works remotely; state (= verifier) is validated when pasted.
- Codex uses the device-code login (not the localhost browser flow) — same UX as Copilot,
  no local server. SSE accumulation server-side; store:false per Codex requirement.
- Provider ids: `anthropic`, `openai_codex` (free-form column — no migrations).

## Guardrails honored

Typed errors; all model traffic through `src/lib/server/llm/` with cost logging; secrets
tenant-encrypted; tests first (unit + component + headless e2e against stubs).
