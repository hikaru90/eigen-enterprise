-- eigenInference and the model slots (plan/phase-company-brain.md §6, CB1).
-- One row per company: the "Use eigenInference" switch and the model each role
-- slot runs on. chat / stt / tts / decision are picked in Settings → AI from the
-- curated pool (src/lib/server/llm/model-pool.ts); NULL = the pool's pick.
-- embedding is fixed per install: set once, on the first resolution, never
-- through Settings (changing it means re-indexing every vector).
-- Company-level table (no RLS): the AI provider is the company's, whoever
-- triggers a call; the capability guard decides who may change it.
--
-- Upgrade: the switch starts OFF where the company already runs on its own key
-- (the owner's billing mode is byok), ON everywhere else. An install with no vector
-- yet (a fresh one, or one whose ingest never got that far, like os.cerberusblue.com)
-- is pinned to the pool's embedding pick now (qwen/qwen3-embedding-8b, CB1): there is
-- nothing to stay compatible with, so a model typed into an old provider form never
-- decides it. An install that has vectors keeps what made them: it is pinned on its
-- first embedding from that (and fails loud if that model is not in the pool).

CREATE TABLE IF NOT EXISTS "company_ai" (
	"id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
	"use_eigen_inference" boolean NOT NULL,
	"chat_model" text,
	"stt_model" text,
	"tts_model" text,
	"decision_model" text,
	"embedding_model" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_ai_singleton" CHECK ("id" = 'company')
);
--> statement-breakpoint
INSERT INTO "company_ai" ("id", "use_eigen_inference", "embedding_model", "updated_by")
SELECT 'company',
	NOT EXISTS (
		SELECT 1 FROM "user_preference" p
		JOIN "user" u ON u."id" = p."user_id"
		WHERE u."role" = 'owner' AND p."billing_mode" = 'byok'
	),
	CASE WHEN EXISTS (SELECT 1 FROM "thought" WHERE "embedding" IS NOT NULL)
		OR EXISTS (SELECT 1 FROM "canonical_entity" WHERE "embedding" IS NOT NULL)
		OR EXISTS (SELECT 1 FROM "temporal_event" WHERE "embedding" IS NOT NULL)
		OR EXISTS (SELECT 1 FROM "community_summary" WHERE "summary_embedding" IS NOT NULL)
	THEN NULL ELSE 'qwen/qwen3-embedding-8b' END,
	'migration:0160_company_ai'
ON CONFLICT ("id") DO NOTHING;
