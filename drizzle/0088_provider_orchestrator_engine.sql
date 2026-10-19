-- The orchestrator's loop engine is chosen explicitly at provider connect time
-- and recorded on the provider row (modules/orchestrator/engine-choice.ts):
-- OpenAI-compatible providers -> 'durable'; API-shape subscription sign-ins
-- (no tool calls) -> 'builtin-json'. Existing rows keep today's behaviour
-- ('builtin-json', the engine of record) until they are re-connected.
ALTER TABLE "llm_provider_config" ADD COLUMN IF NOT EXISTS "orchestrator_engine" text;
UPDATE "llm_provider_config" SET "orchestrator_engine" = 'builtin-json' WHERE "orchestrator_engine" IS NULL;
ALTER TABLE "llm_provider_config" ALTER COLUMN "orchestrator_engine" SET NOT NULL;
ALTER TABLE "llm_provider_config" DROP CONSTRAINT IF EXISTS "llm_provider_config_orchestrator_engine_check";
ALTER TABLE "llm_provider_config" ADD CONSTRAINT "llm_provider_config_orchestrator_engine_check" CHECK ("orchestrator_engine" IN ('builtin-json', 'durable'));
