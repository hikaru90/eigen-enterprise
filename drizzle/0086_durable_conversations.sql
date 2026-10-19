-- Durable agent conversations (plan/phase-durable.md D7): Postgres keeps the
-- index, pi-durable's SQLite file keeps the transcript. Company-level
-- (kernel-side, no RLS — like every kernel table): maps conversation keys
-- ("<agentId>:<sessionId>") to pi-durable conversation ids and stores the
-- pi.provider sessionId — the crash-safe attribution key every gateway model
-- call resolves back to llm_user_id (billing survives restarts). Per-user
-- secrets NEVER enter SQLite; attribution flows through llm_user_id here.
-- pi-durable ids are branded bigints — stored as text.

CREATE TABLE IF NOT EXISTS "durable_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_key" text NOT NULL,
	"agent_id" text NOT NULL,
	"llm_user_id" text NOT NULL,
	"pi_conversation_id" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "durable_conversations_conversation_key_unique" UNIQUE("conversation_key"),
	CONSTRAINT "durable_conversations_provider_session_id_unique" UNIQUE("provider_session_id")
);
