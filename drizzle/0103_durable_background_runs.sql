-- Durable background runs + chat mirror (plan/phase-software-factory.md §3.1, S0;
-- plan/phase-durable.md D9).
--
-- durable_conversations.run_principal_id: the principal a BACKGROUND run's
-- tools execute as (no browser request attached). Chat conversations leave it
-- NULL — a chat tool call resumed after a restart still reports not_run.
-- durable_conversations.run_tools: the background run's tool surface
-- (name/description/JSON Schema), so a reopened harness can re-register the
-- bridge before resuming the run. NULL for chat rows.
ALTER TABLE "durable_conversations" ADD COLUMN IF NOT EXISTS "run_principal_id" text;
--> statement-breakpoint
ALTER TABLE "durable_conversations" ADD COLUMN IF NOT EXISTS "run_tools" jsonb;
--> statement-breakpoint
-- chat_message.durable_answer_key: "<piConversationId>:<answerEntryId>" of a
-- durable turn mirrored into the chat after a restart (D9). Unique so the
-- mirror never writes the same reply twice; NULL for every live-written row.
ALTER TABLE "chat_message" ADD COLUMN IF NOT EXISTS "durable_answer_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_message_durable_answer_key_unique" ON "chat_message" ("durable_answer_key");
