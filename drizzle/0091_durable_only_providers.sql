-- The orchestrator runs on ONE engine (durable / pi-durable), which needs native
-- tool calls. The Claude Pro/Max ('anthropic') and ChatGPT ('openai_codex')
-- subscription sign-ins spoke their own API shapes without tool calls and are
-- removed; their saved credentials go with them (the owner reconnects an
-- OpenAI-compatible provider in the onboarding). The per-provider engine
-- record is gone with the choice.
DELETE FROM "llm_active_provider" WHERE "provider" IN ('anthropic', 'openai_codex');
DELETE FROM "llm_provider_config" WHERE "provider" IN ('anthropic', 'openai_codex');
ALTER TABLE "llm_provider_config" DROP CONSTRAINT IF EXISTS "llm_provider_config_orchestrator_engine_check";
ALTER TABLE "llm_provider_config" DROP COLUMN IF EXISTS "orchestrator_engine";
